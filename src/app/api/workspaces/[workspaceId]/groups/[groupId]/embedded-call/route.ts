import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireWorkspacePermission } from "@/lib/auth/middleware";
import { resolveVisibleAccountIds } from "@/lib/account-visibility";
import { logAudit } from "@/lib/audit/logger";

const GATEWAY_URL =
  process.env.TELEGRAM_VOIP_GATEWAY_URL ||
  process.env.VOIP_GATEWAY_URL ||
  "";
const GATEWAY_SECRET =
  process.env.TELEGRAM_VOIP_GATEWAY_SECRET ||
  process.env.VOIP_GATEWAY_SECRET ||
  process.env.INTERNAL_SECRET ||
  "";

type RouteParams = {
  params: Promise<{ workspaceId: string; groupId: string }>;
};

type CallMode = "voice" | "video";
type CallDirection = "outgoing" | "incoming";

function isCallMode(value: unknown): value is CallMode {
  return value === "voice" || value === "video";
}

function isDirection(value: unknown): value is CallDirection {
  return value === "outgoing" || value === "incoming";
}

function gatewayUrl(path: string): string {
  return new URL(path, GATEWAY_URL.endsWith("/") ? GATEWAY_URL : `${GATEWAY_URL}/`).toString();
}

function gatewayHeaders() {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${GATEWAY_SECRET}`,
  };
}

async function getAuthorizedPrivateGroup({
  workspaceId,
  groupId,
  accountId,
  auth,
}: {
  workspaceId: string;
  groupId: string;
  accountId: string;
  auth: {
    userId: string;
    isSystemAdmin: boolean;
    permissions: Parameters<typeof resolveVisibleAccountIds>[0]["permissions"];
  };
}) {
  const visibleAccountIds = await resolveVisibleAccountIds({
    userId: auth.userId,
    workspaceId,
    isSystemAdmin: auth.isSystemAdmin,
    permissions: auth.permissions,
  });
  if (!visibleAccountIds.has(accountId)) return null;

  return prisma.group.findFirst({
    where: {
      id: groupId,
      workspaceId,
      chatType: "PRIVATE",
      accountMemberships: { some: { accountId } },
    },
    select: {
      id: true,
      title: true,
      customerName: true,
      platformGroupId: true,
    },
  });
}

export async function POST(req: Request, { params }: RouteParams) {
  const { workspaceId, groupId } = await params;
  const auth = await requireWorkspacePermission(workspaceId, "canDirectMessage");
  if (auth instanceof NextResponse) return auth;

  if (!GATEWAY_URL || !GATEWAY_SECRET) {
    return NextResponse.json(
      {
        error: "EMBEDDED_CALL_GATEWAY_NOT_CONFIGURED",
        message: "尚未設定 Telegram VoIP gateway,無法在 Switchboard 內接聽通話。",
      },
      { status: 501 },
    );
  }

  let body: {
    mode?: unknown;
    direction?: unknown;
    accountId?: unknown;
    gatewaySessionId?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "無效的請求內容" }, { status: 400 });
  }

  if (!isCallMode(body.mode)) {
    return NextResponse.json({ error: "mode 必須是 voice 或 video" }, { status: 400 });
  }
  const direction = isDirection(body.direction) ? body.direction : "outgoing";
  const accountId =
    typeof body.accountId === "string" && body.accountId.trim()
      ? body.accountId.trim()
      : "";
  if (!accountId) {
    return NextResponse.json({ error: "缺少 accountId" }, { status: 400 });
  }
  const gatewaySessionId =
    typeof body.gatewaySessionId === "string" && body.gatewaySessionId.trim()
      ? body.gatewaySessionId.trim()
      : "";
  if (direction === "incoming" && !gatewaySessionId) {
    return NextResponse.json({ error: "incoming 通話缺少 gatewaySessionId" }, { status: 400 });
  }

  const group = await getAuthorizedPrivateGroup({
    workspaceId,
    groupId,
    accountId,
    auth,
  });
  if (!group) {
    return NextResponse.json(
      { error: "只能在可見的 1:1 私訊對話使用內嵌通話" },
      { status: 404 },
    );
  }

  const endpoint =
    direction === "incoming"
      ? `telegram/calls/sessions/${encodeURIComponent(gatewaySessionId)}/answer`
      : "telegram/calls/sessions";
  const gatewayRes = await fetch(gatewayUrl(endpoint), {
    method: "POST",
    headers: gatewayHeaders(),
    body: JSON.stringify({
      workspaceId,
      groupId: group.id,
      accountId,
      platformUserId: group.platformGroupId,
      mode: body.mode,
      direction,
      operatorUserId: auth.userId,
    }),
    signal: AbortSignal.timeout(15_000),
  }).catch((err) => err as Error);

  if (gatewayRes instanceof Error) {
    return NextResponse.json(
      {
        error: "VOIP_GATEWAY_UNREACHABLE",
        message: "Telegram VoIP gateway 無法連線，請確認 TELEGRAM_VOIP_GATEWAY_URL 服務已啟動。",
        detail: gatewayRes.message,
      },
      { status: 502 },
    );
  }

  const data = await gatewayRes.json().catch(() => ({}));
  if (!gatewayRes.ok) {
    return NextResponse.json(
      {
        error: data.error || "VOIP_GATEWAY_ERROR",
        message: data.message || "Telegram VoIP gateway 拒絕建立通話 session",
      },
      { status: gatewayRes.status },
    );
  }

  const sessionId =
    typeof data.sessionId === "string" && data.sessionId
      ? data.sessionId
      : gatewaySessionId;

  await logAudit({
    workspaceId,
    userId: auth.userId,
    action:
      direction === "incoming"
        ? "direct_chat.embedded_call_answer"
        : "direct_chat.embedded_call_start",
    entityType: "Group",
    entityId: group.id,
    details: {
      mode: body.mode,
      direction,
      accountId,
      platformUserId: group.platformGroupId,
      gatewaySessionId: sessionId,
    },
  });

  return NextResponse.json({
    success: true,
    mode: body.mode,
    direction,
    sessionId,
    signalingUrl: data.browserSignalingUrl || data.signalingUrl || null,
    iceServers: Array.isArray(data.iceServers) ? data.iceServers : [],
    offer: data.offer || null,
    expiresAt: data.expiresAt || null,
  });
}

export async function PATCH(req: Request, { params }: RouteParams) {
  const { workspaceId, groupId } = await params;
  const auth = await requireWorkspacePermission(workspaceId, "canDirectMessage");
  if (auth instanceof NextResponse) return auth;

  if (!GATEWAY_URL || !GATEWAY_SECRET) {
    return NextResponse.json({ error: "EMBEDDED_CALL_GATEWAY_NOT_CONFIGURED" }, { status: 501 });
  }

  let body: { accountId?: unknown; sessionId?: unknown; signal?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "無效的請求內容" }, { status: 400 });
  }
  const accountId = typeof body.accountId === "string" ? body.accountId : "";
  const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
  if (!accountId || !sessionId || typeof body.signal !== "object" || body.signal == null) {
    return NextResponse.json({ error: "缺少 accountId、sessionId 或 signal" }, { status: 400 });
  }

  const group = await getAuthorizedPrivateGroup({ workspaceId, groupId, accountId, auth });
  if (!group) {
    return NextResponse.json({ error: "找不到可見的私訊對話" }, { status: 404 });
  }

  const gatewayRes = await fetch(
    gatewayUrl(`telegram/calls/sessions/${encodeURIComponent(sessionId)}/signals`),
    {
      method: "POST",
      headers: gatewayHeaders(),
      body: JSON.stringify({
        workspaceId,
        groupId: group.id,
        accountId,
        operatorUserId: auth.userId,
        signal: body.signal,
      }),
      signal: AbortSignal.timeout(10_000),
    },
  ).catch((err) => err as Error);

  if (gatewayRes instanceof Error) {
    return NextResponse.json(
      {
        error: "VOIP_GATEWAY_UNREACHABLE",
        message: "Telegram VoIP gateway 無法連線，請確認 TELEGRAM_VOIP_GATEWAY_URL 服務已啟動。",
        detail: gatewayRes.message,
      },
      { status: 502 },
    );
  }
  const data = await gatewayRes.json().catch(() => ({}));
  return NextResponse.json(data, { status: gatewayRes.status });
}

export async function DELETE(req: Request, { params }: RouteParams) {
  const { workspaceId, groupId } = await params;
  const auth = await requireWorkspacePermission(workspaceId, "canDirectMessage");
  if (auth instanceof NextResponse) return auth;

  if (!GATEWAY_URL || !GATEWAY_SECRET) {
    return NextResponse.json({ success: true });
  }

  let body: { accountId?: unknown; sessionId?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "無效的請求內容" }, { status: 400 });
  }
  const accountId = typeof body.accountId === "string" ? body.accountId : "";
  const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
  if (!accountId || !sessionId) {
    return NextResponse.json({ error: "缺少 accountId 或 sessionId" }, { status: 400 });
  }

  const group = await getAuthorizedPrivateGroup({ workspaceId, groupId, accountId, auth });
  if (!group) {
    return NextResponse.json({ error: "找不到可見的私訊對話" }, { status: 404 });
  }

  await fetch(gatewayUrl(`telegram/calls/sessions/${encodeURIComponent(sessionId)}`), {
    method: "DELETE",
    headers: gatewayHeaders(),
    body: JSON.stringify({
      workspaceId,
      groupId: group.id,
      accountId,
      operatorUserId: auth.userId,
    }),
    signal: AbortSignal.timeout(10_000),
  }).catch(() => null);

  await logAudit({
    workspaceId,
    userId: auth.userId,
    action: "direct_chat.embedded_call_end",
    entityType: "Group",
    entityId: group.id,
    details: { accountId, gatewaySessionId: sessionId },
  });

  return NextResponse.json({ success: true });
}
