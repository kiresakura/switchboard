import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireWorkspacePermission } from "@/lib/auth/middleware";
import { resolveVisibleAccountIds } from "@/lib/account-visibility";
import { logAudit } from "@/lib/audit/logger";

const BRIDGE_URL =
  process.env.BRIDGE_URL ||
  `http://localhost:${process.env.BRIDGE_PORT || 3001}`;
const INTERNAL_SECRET = process.env.INTERNAL_SECRET;

type RouteParams = {
  params: Promise<{ workspaceId: string; groupId: string }>;
};

type CallMode = "voice" | "video";

function isCallMode(value: unknown): value is CallMode {
  return value === "voice" || value === "video";
}

function buildFallbackLaunchUrl(platformUserId: string) {
  // Telegram does not expose a stable documented deep link that directly starts
  // private voice/video calls. Open the native user profile/chat as a handoff.
  return `tg://user?id=${encodeURIComponent(platformUserId)}`;
}

export async function POST(req: Request, { params }: RouteParams) {
  const { workspaceId, groupId } = await params;
  const auth = await requireWorkspacePermission(workspaceId, "canDirectMessage");
  if (auth instanceof NextResponse) return auth;

  let body: { mode?: unknown; accountId?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "無效的請求內容" }, { status: 400 });
  }

  if (!isCallMode(body.mode)) {
    return NextResponse.json({ error: "mode 必須是 voice 或 video" }, { status: 400 });
  }
  const accountId =
    typeof body.accountId === "string" && body.accountId.trim()
      ? body.accountId.trim()
      : null;

  const visibleAccountIds = await resolveVisibleAccountIds({
    userId: auth.userId,
    workspaceId,
    isSystemAdmin: auth.isSystemAdmin,
    permissions: auth.permissions,
  });

  const group = await prisma.group.findFirst({
    where: {
      id: groupId,
      workspaceId,
      chatType: "PRIVATE",
      ...(visibleAccountIds.size > 0
        ? {
            accountMemberships: {
              some: { accountId: { in: Array.from(visibleAccountIds) } },
            },
          }
        : { id: "__never_match__" }),
    },
    select: {
      id: true,
      title: true,
      customerName: true,
      platformGroupId: true,
      accountMemberships: { select: { accountId: true } },
    },
  });

  if (!group) {
    return NextResponse.json(
      { error: "只能在可見的 1:1 私訊對話啟動通話" },
      { status: 404 },
    );
  }

  if (accountId) {
    const canUseAccount =
      visibleAccountIds.has(accountId) &&
      group.accountMemberships.some((m) => m.accountId === accountId);
    if (!canUseAccount) {
      return NextResponse.json(
        { error: "無權使用此帳號啟動通話入口" },
        { status: 403 },
      );
    }
  }

  let username: string | null = null;
  let phone: string | null = null;
  if (INTERNAL_SECRET) {
    try {
      const bridgeRes = await fetch(`${BRIDGE_URL}/user-info`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${INTERNAL_SECRET}`,
        },
        body: JSON.stringify({
          platformUserId: group.platformGroupId,
          workspaceId,
        }),
        signal: AbortSignal.timeout(8_000),
      });
      if (bridgeRes.ok) {
        const data = await bridgeRes.json().catch(() => null);
        username =
          typeof data?.info?.username === "string" && data.info.username
            ? data.info.username
            : null;
        phone =
          typeof data?.info?.phone === "string" && data.info.phone
            ? data.info.phone
            : null;
      }
    } catch {
      // Bridge profile lookup is best-effort; the user-id deep link is enough
      // for the native Telegram handoff in already-known private chats.
    }
  }

  const launchUrl = username
    ? `tg://resolve?domain=${encodeURIComponent(username)}&profile`
    : buildFallbackLaunchUrl(group.platformGroupId);
  const webUrl = username ? `https://t.me/${encodeURIComponent(username)}` : null;

  await logAudit({
    workspaceId,
    userId: auth.userId,
    action: "direct_chat.call_intent",
    entityType: "Group",
    entityId: group.id,
    details: {
      mode: body.mode,
      accountId,
      groupTitle: group.customerName || group.title,
      platformUserId: group.platformGroupId,
      launchKind: username ? "username" : "user_id",
      handoffOnly: true,
    },
  });

  return NextResponse.json({
    success: true,
    mode: body.mode,
    launchUrl,
    webUrl,
    phoneUrl: phone ? `tel:${phone}` : null,
    handoffOnly: true,
    message:
      body.mode === "voice"
        ? "已開啟 Telegram。請在 Telegram 原生 App 中發起通話。"
        : "已開啟 Telegram。請在 Telegram 原生 App 中發起視訊。",
  });
}
