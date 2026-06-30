import { timingSafeEqual } from "crypto";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { eventBus } from "@/lib/realtime/event-bus";
import { isPlaceholderSecret } from "@/lib/security/secret-guard";

const GATEWAY_SECRET =
  process.env.TELEGRAM_VOIP_GATEWAY_SECRET ||
  process.env.VOIP_GATEWAY_SECRET ||
  process.env.INTERNAL_SECRET ||
  "";

function verifySecret(authHeader: string | null): boolean {
  // C3: never authenticate against a build-time/dev placeholder secret.
  if (!GATEWAY_SECRET || isPlaceholderSecret(GATEWAY_SECRET) || !authHeader) return false;
  const expected = `Bearer ${GATEWAY_SECRET}`;
  if (authHeader.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(authHeader), Buffer.from(expected));
}

type CallEventKind = "incoming" | "outgoing_update" | "updated" | "ended";

function normalizeKind(value: unknown): CallEventKind | null {
  if (
    value === "incoming" ||
    value === "outgoing_update" ||
    value === "updated" ||
    value === "ended"
  ) {
    return value;
  }
  return null;
}

export async function POST(req: Request) {
  if (!verifySecret(req.headers.get("authorization"))) {
    return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });
  }

  let body: {
    event?: unknown;
    workspaceId?: unknown;
    groupId?: unknown;
    accountId?: unknown;
    sessionId?: unknown;
    mode?: unknown;
    state?: unknown;
    detail?: unknown;
    platformUserId?: unknown;
    callerName?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "無效的請求內容" }, { status: 400 });
  }

  const event = normalizeKind(body.event);
  const workspaceId = typeof body.workspaceId === "string" ? body.workspaceId : "";
  const groupId = typeof body.groupId === "string" ? body.groupId : "";
  const accountId = typeof body.accountId === "string" ? body.accountId : "";
  const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
  const platformUserId =
    typeof body.platformUserId === "string" ? body.platformUserId : "";
  const mode = body.mode === "video" ? "video" : "voice";
  if (!event || !accountId || !sessionId) {
    return NextResponse.json(
      { error: "event、accountId、sessionId 為必填" },
      { status: 400 },
    );
  }
  if (!groupId && !platformUserId) {
    return NextResponse.json(
      { error: "需要 groupId 或 platformUserId 其中之一" },
      { status: 400 },
    );
  }

  // The gateway only knows the Telegram peer for helper-detected (incoming)
  // calls; resolve the Switchboard private chat from the account + TG user id.
  const group = await prisma.group.findFirst({
    where: groupId
      ? {
          id: groupId,
          ...(workspaceId ? { workspaceId } : {}),
          chatType: "PRIVATE",
          accountMemberships: { some: { accountId } },
        }
      : {
          platformGroupId: platformUserId,
          chatType: "PRIVATE",
          accountMemberships: { some: { accountId } },
        },
    select: {
      id: true,
      title: true,
      customerName: true,
      platformGroupId: true,
      workspaceId: true,
    },
  });
  if (!group) {
    return NextResponse.json({ error: "找不到私訊對話" }, { status: 404 });
  }

  eventBus.publish({
    type: event === "incoming" ? "call:incoming" : "call:updated",
    workspaceId: group.workspaceId,
    data: {
      groupId: group.id,
      accountId,
      gatewaySessionId: sessionId,
      mode,
      state: typeof body.state === "string" ? body.state : event,
      detail: typeof body.detail === "string" ? body.detail : undefined,
      platformUserId: platformUserId || group.platformGroupId,
      callerName:
        typeof body.callerName === "string"
          ? body.callerName
          : group.customerName || group.title,
    },
  });

  return NextResponse.json({ success: true });
}
