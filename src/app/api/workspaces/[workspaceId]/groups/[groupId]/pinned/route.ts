import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireWorkspaceMember } from "@/lib/auth/middleware";
import { logger } from "@/lib/logger";

const log = logger("PinnedMessage");

type RouteParams = {
  params: Promise<{ workspaceId: string; groupId: string }>;
};

const BRIDGE_URL = process.env.BRIDGE_URL || `http://localhost:${process.env.BRIDGE_PORT || 3001}`;
const INTERNAL_SECRET = process.env.INTERNAL_SECRET;

const REFRESH_TTL_MS = 60 * 1000; // 1 分鐘內不重打 bridge,避免每次切對話都打

/**
 * P1 2026-05-20:取得 group / channel 的釘選訊息。
 *
 * 流程:
 *   1) 從 DB 讀目前的 pinnedPlatformMessageId
 *   2) 如果 pinnedRefreshedAt 過期(> 1min),呼叫 bridge `/get-pinned-message`
 *      refresh 一次;有用 chat 才會花 ~200ms,個人 chat bridge 會直接回 null
 *   3) 用 pinnedPlatformMessageId 在 DCM 找對應內容(可能找不到 — 訊息未
 *      被 bridge archive 到 DCM,例如更早歷史。這種情況回傳「only id, no
 *      content」讓 UI 自己決定要不要 fallback 顯示「(訊息不在已載入歷史中)」)
 *
 * 不主動 trigger refresh from cron — 改成「使用者開對話 + ttl 過期」才 refresh,
 * 對絕大多數 1:1 chat 來說 0 額外開銷(bridge 看到 InputPeerUser 直接 return null)。
 */
export async function GET(_req: Request, { params }: RouteParams) {
  const { workspaceId, groupId } = await params;
  const auth = await requireWorkspaceMember(workspaceId);
  if (auth instanceof NextResponse) return auth;

  const group = await prisma.group.findFirst({
    where: { id: groupId, workspaceId },
    select: {
      id: true,
      platformGroupId: true,
      pinnedPlatformMessageId: true,
      pinnedRefreshedAt: true,
      accountMemberships: {
        where: { isListeningAccount: true, account: { status: "ACTIVE" } },
        select: { accountId: true },
        take: 1,
      },
    },
  });
  if (!group) {
    return NextResponse.json({ error: "找不到群組" }, { status: 404 });
  }

  let { pinnedPlatformMessageId } = group;
  const needsRefresh =
    !group.pinnedRefreshedAt ||
    Date.now() - group.pinnedRefreshedAt.getTime() > REFRESH_TTL_MS;
  const accountId = group.accountMemberships[0]?.accountId;

  if (needsRefresh && accountId && INTERNAL_SECRET) {
    try {
      const res = await fetch(`${BRIDGE_URL}/get-pinned-message`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${INTERNAL_SECRET}`,
        },
        body: JSON.stringify({ accountId, chatId: group.platformGroupId }),
        signal: AbortSignal.timeout(8000),
      });
      if (res.ok) {
        const data = (await res.json()) as { pinnedMessageId?: string | null };
        const refreshed = data.pinnedMessageId ?? null;
        // 只在 value 真的變了才寫 DB,避免每次 refresh 都 hit updatedAt
        if (refreshed !== pinnedPlatformMessageId) {
          await prisma.group.update({
            where: { id: groupId },
            data: {
              pinnedPlatformMessageId: refreshed,
              pinnedRefreshedAt: new Date(),
            },
          });
          pinnedPlatformMessageId = refreshed;
        } else {
          // 沒變也更新 refreshedAt,讓 TTL 重新計
          await prisma.group.update({
            where: { id: groupId },
            data: { pinnedRefreshedAt: new Date() },
          });
        }
      }
    } catch (err) {
      log.warn("bridge /get-pinned-message refresh failed (non-fatal)", {
        error: String(err).slice(0, 200),
      });
      // refresh 失敗就用 DB 既有值
    }
  }

  if (!pinnedPlatformMessageId) {
    return NextResponse.json({ pinned: null });
  }

  // 找對應 DCM 內容
  const dcm = await prisma.directChatMessage.findFirst({
    where: {
      workspaceId,
      groupId,
      platformMessageId: pinnedPlatformMessageId,
    },
    select: {
      id: true,
      content: true,
      messageType: true,
      senderDisplayName: true,
      senderPlatformId: true,
      createdAt: true,
      mediaFileName: true,
    },
  });

  return NextResponse.json({
    pinned: {
      platformMessageId: pinnedPlatformMessageId,
      dcmId: dcm?.id ?? null,
      content: dcm?.content ?? null,
      messageType: dcm?.messageType ?? null,
      senderDisplayName: dcm?.senderDisplayName ?? dcm?.senderPlatformId ?? null,
      timestamp: dcm?.createdAt?.toISOString() ?? null,
      mediaFileName: dcm?.mediaFileName ?? null,
    },
  });
}
