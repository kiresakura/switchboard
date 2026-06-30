import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireWorkspacePermission } from "@/lib/auth/middleware";
import { resolveVisibleAccountIds } from "@/lib/account-visibility";
import { logAudit } from "@/lib/audit/logger";
import { logger } from "@/lib/logger";

const log = logger("ContactAction");

const BRIDGE_URL =
  process.env.BRIDGE_URL ||
  `http://localhost:${process.env.BRIDGE_PORT || 3001}`;
const INTERNAL_SECRET = process.env.INTERNAL_SECRET;

type RouteParams = {
  params: Promise<{ workspaceId: string; groupId: string }>;
};

const VALID_ACTIONS = ["block", "unblock", "add"] as const;

/**
 * 2026-05-21 Wave 1 — 對 1:1 私訊的聯絡人操作(封鎖 / 解除封鎖 / 加為聯絡人)。
 *
 * POST /api/workspaces/:ws/groups/:groupId/contact-action
 *   body: { action: "block" | "unblock" | "add", accountId }
 *
 * 實際 TG API 呼叫在 bridge worker(連線中的 GramJS client 由 bridge 持有);
 * 此路由做 auth + 可見性檢查 + 轉發。
 */
export async function POST(req: Request, { params }: RouteParams) {
  const { workspaceId, groupId } = await params;
  const auth = await requireWorkspacePermission(workspaceId, "canDirectMessage");
  if (auth instanceof NextResponse) return auth;

  if (!INTERNAL_SECRET) {
    return NextResponse.json(
      { error: "bridge 未設定 INTERNAL_SECRET" },
      { status: 500 },
    );
  }

  let body: { action?: string; accountId?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "無效的請求內容" }, { status: 400 });
  }
  const { action, accountId } = body;
  if (
    !action ||
    !VALID_ACTIONS.includes(action as (typeof VALID_ACTIONS)[number])
  ) {
    return NextResponse.json({ error: "不支援的聯絡人動作" }, { status: 400 });
  }
  if (!accountId) {
    return NextResponse.json({ error: "缺少 accountId" }, { status: 400 });
  }

  // 可見性檢查 — 員工只能對自己看得到的對話操作
  const visible = await resolveVisibleAccountIds({
    userId: auth.userId,
    workspaceId,
    isSystemAdmin: auth.isSystemAdmin,
    permissions: auth.permissions,
  });
  const group = await prisma.group.findFirst({
    where: {
      id: groupId,
      workspaceId,
      ...(visible.size > 0
        ? {
            accountMemberships: {
              some: { accountId: { in: Array.from(visible) } },
            },
          }
        : { id: "__never_match__" }),
    },
    select: {
      id: true,
      chatType: true,
      platformGroupId: true,
      title: true,
      customerName: true,
    },
  });
  if (!group) {
    return NextResponse.json({ error: "找不到對話" }, { status: 404 });
  }
  if (group.chatType !== "PRIVATE") {
    return NextResponse.json(
      { error: "只能對 1:1 私訊的聯絡人操作" },
      { status: 400 },
    );
  }

  try {
    const bridgeRes = await fetch(`${BRIDGE_URL}/contact-action`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${INTERNAL_SECRET}`,
      },
      body: JSON.stringify({
        accountId,
        chatId: group.platformGroupId,
        action,
        firstName: group.customerName || group.title || "",
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const result = (await bridgeRes.json().catch(() => ({}))) as {
      success?: boolean;
      error?: string;
    };
    if (!bridgeRes.ok || result.error || result.success === false) {
      return NextResponse.json(
        { error: result.error || "聯絡人操作失敗" },
        { status: bridgeRes.ok ? 400 : 502 },
      );
    }

    await logAudit({
      workspaceId,
      userId: auth.userId,
      action: `contact.${action}`,
      entityType: "Group",
      entityId: groupId,
      details: { accountId },
    });

    return NextResponse.json({ success: true });
  } catch (err) {
    log.warn("contact-action bridge call failed", {
      groupId,
      error: String(err).slice(0, 200),
    });
    return NextResponse.json(
      { error: "bridge 無回應(可能未啟動)" },
      { status: 502 },
    );
  }
}
