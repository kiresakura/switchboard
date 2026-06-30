import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireWorkspaceMember } from "@/lib/auth/middleware";
import { resolveVisibleAccountIds } from "@/lib/account-visibility";
import { logger } from "@/lib/logger";

const log = logger("ReadBy");

type RouteParams = {
  params: Promise<{ workspaceId: string; messageId: string }>;
};

const BRIDGE_URL = process.env.BRIDGE_URL || `http://localhost:${process.env.BRIDGE_PORT || 3001}`;
const INTERNAL_SECRET = process.env.INTERNAL_SECRET;

/**
 * 2026-05-21 TG parity:GetMessageReadParticipants — 小群組(<=100 成員、訊息 <=7天)
 * 看誰已讀某則 OUTBOUND 訊息。
 *
 * GET /api/workspaces/[ws]/messages/[id]/read-by
 *   ↳ { readers: [{ platformUserId, displayName, avatarUrl }] }
 *
 * 限制:
 *   - 只對 OUTBOUND 訊息(我們發的)有意義 — TG 不會回「對方訊息誰讀了」
 *   - 大群 / 老訊息 → bridge 回空陣列(不是錯誤,是 TG 設計上不暴露)
 *   - 沒 platformMessageId(本地 optimistic / 未同步)→ 422
 *
 * 權限:呼叫者必須能看到 DCM 所屬帳號(account-visibility)。
 * UI:類似 reactor list popover,bubble hover toolbar 加一個「已讀名單」icon。
 */
export async function GET(_req: Request, { params }: RouteParams) {
  const { workspaceId, messageId } = await params;
  const auth = await requireWorkspaceMember(workspaceId);
  if (auth instanceof NextResponse) return auth;

  const dcm = await prisma.directChatMessage.findFirst({
    where: { id: messageId, workspaceId },
    select: {
      id: true,
      accountId: true,
      direction: true,
      platformMessageId: true,
      group: { select: { platformGroupId: true, chatType: true } },
    },
  });
  if (!dcm) {
    return NextResponse.json({ error: "找不到訊息" }, { status: 404 });
  }

  // 可見性
  const visible = await resolveVisibleAccountIds({
    userId: auth.userId,
    workspaceId,
    isSystemAdmin: auth.isSystemAdmin,
    permissions: auth.permissions,
  });
  if (!visible.has(dcm.accountId)) {
    return NextResponse.json({ error: "無權查看此訊息已讀名單" }, { status: 403 });
  }

  // 只對 OUTBOUND 有意義
  if (dcm.direction !== "OUTBOUND") {
    return NextResponse.json(
      { readers: [], note: "TG 只暴露我方訊息的已讀名單" },
      { status: 200 },
    );
  }
  if (!dcm.platformMessageId || !dcm.group.platformGroupId) {
    return NextResponse.json(
      { error: "此訊息尚未與 Telegram 同步" },
      { status: 422 },
    );
  }
  // 1:1 私訊不需要這支 — 用 readAt(UpdateReadHistoryOutbox)更精準
  if (dcm.group.chatType === "PRIVATE") {
    return NextResponse.json(
      { readers: [], note: "1:1 私訊請看訊息的藍勾標記" },
      { status: 200 },
    );
  }
  if (!INTERNAL_SECRET) {
    return NextResponse.json({ error: "bridge 未設定 INTERNAL_SECRET" }, { status: 500 });
  }

  let readByPlatformIds: string[] = [];
  try {
    const bridgeRes = await fetch(`${BRIDGE_URL}/get-read-participants`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${INTERNAL_SECRET}`,
      },
      body: JSON.stringify({
        accountId: dcm.accountId,
        chatId: dcm.group.platformGroupId,
        platformMessageId: dcm.platformMessageId,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!bridgeRes.ok) {
      const errBody = await bridgeRes.text().catch(() => "");
      log.warn("bridge /get-read-participants failed", {
        messageId: dcm.id,
        status: bridgeRes.status,
        body: errBody.slice(0, 200),
      });
      // 對使用者非致命 — 回空名單即可。
      return NextResponse.json({ readers: [] });
    }
    const result = (await bridgeRes.json()) as { readBy?: string[]; error?: string };
    readByPlatformIds = Array.isArray(result.readBy) ? result.readBy : [];
  } catch (err) {
    log.warn("get-read-participants bridge call failed", {
      messageId: dcm.id,
      error: String(err).slice(0, 200),
    });
    return NextResponse.json({ readers: [] });
  }

  if (readByPlatformIds.length === 0) {
    return NextResponse.json({ readers: [] });
  }

  // 把 platformUserId 對映到我們快取的 displayName / avatar(SenderAvatar 表)
  const avatars = await prisma.senderAvatar.findMany({
    where: {
      workspaceId,
      platformUserId: { in: readByPlatformIds },
    },
    select: { platformUserId: true, displayName: true, mediaPath: true },
  });
  const byUid = new Map(avatars.map((a) => [a.platformUserId, a]));

  return NextResponse.json({
    readers: readByPlatformIds.map((uid) => {
      const a = byUid.get(uid);
      return {
        platformUserId: uid,
        displayName: a?.displayName ?? null,
        avatarUrl: a?.mediaPath
          ? `/api/workspaces/${workspaceId}/avatars/${encodeURIComponent(uid)}`
          : null,
      };
    }),
  });
}
