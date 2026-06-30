import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireWorkspacePermission } from "@/lib/auth/middleware";
import { resolveVisibleAccountIds } from "@/lib/account-visibility";
import { logAudit } from "@/lib/audit/logger";
import { logger } from "@/lib/logger";

const log = logger("PinnedSync");

type RouteParams = {
  params: Promise<{ workspaceId: string; accountId: string }>;
};

const BRIDGE_URL = process.env.BRIDGE_URL || `http://localhost:${process.env.BRIDGE_PORT || 3001}`;
const INTERNAL_SECRET = process.env.INTERNAL_SECRET;

/**
 * 2026-05-21 二線(round 4):從 TG pull 釘選對話清單同步到 Switchboard Group.conversationPinnedAt。
 *
 * 設計:
 *   - **單向 pull**(TG → Switchboard)— 員工在 TG 端 pin / unpin,Switchboard 跟上。
 *   - Switchboard 端在 conversations 上的 pin(`conversationPinnedAt`)目前是 UI 概念,
 *     不會 push 回 TG。push 方向(`messages.ToggleDialogPin`)留下回合再做 — 需先
 *     確認 UX 是「Switchboard pin 跟 TG pin 共用同一個狀態」還是「兩套並存」。
 *   - 一次性 sync:不會 cron 跑(那要 pg-boss job + dedupe);使用者明確按「同步釘選」才觸發。
 *
 * 行為:
 *   1. 呼叫 bridge `/sync-pinned-dialogs` 拿 platformGroupId 清單
 *   2. 對該清單上的 Group 設 conversationPinnedAt = now()(如果還沒釘)
 *   3. 其他「Switchboard 釘了但 TG 沒釘」的 Group 取消 pin(`conversationPinnedAt = null`)
 *
 * 範圍限制:只動「at least one accountMembership = 此 account」的 Group;
 *           其他帳號的 Group 不碰(避免 A 帳號 sync 把 B 帳號的 pin 蓋掉)。
 */
export async function POST(_req: Request, { params }: RouteParams) {
  const { workspaceId, accountId } = await params;
  const auth = await requireWorkspacePermission(workspaceId);
  if (auth instanceof NextResponse) return auth;

  const visible = await resolveVisibleAccountIds({
    userId: auth.userId,
    workspaceId,
    isSystemAdmin: auth.isSystemAdmin,
    permissions: auth.permissions,
  });
  if (!visible.has(accountId)) {
    return NextResponse.json({ error: "無權同步此帳號" }, { status: 403 });
  }

  const account = await prisma.communicationAccount.findFirst({
    where: { id: accountId, workspaceId, status: "ACTIVE" },
    select: { id: true },
  });
  if (!account) {
    return NextResponse.json(
      { error: "找不到帳號或帳號未啟用" },
      { status: 404 },
    );
  }
  if (!INTERNAL_SECRET) {
    return NextResponse.json({ error: "bridge 未設定 INTERNAL_SECRET" }, { status: 500 });
  }

  let pinnedPlatformIds: string[] = [];
  try {
    const r = await fetch(`${BRIDGE_URL}/sync-pinned-dialogs`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${INTERNAL_SECRET}`,
      },
      body: JSON.stringify({ accountId }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!r.ok) {
      const errBody = await r.text().catch(() => "");
      log.warn("bridge /sync-pinned-dialogs failed", {
        accountId,
        status: r.status,
        body: errBody.slice(0, 200),
      });
      return NextResponse.json({ error: "TG 同步失敗" }, { status: 502 });
    }
    const data = (await r.json()) as {
      pinnedChatIds?: string[];
      error?: string;
    };
    pinnedPlatformIds = Array.isArray(data.pinnedChatIds) ? data.pinnedChatIds : [];
  } catch (err) {
    log.warn("bridge call failed", { err: String(err).slice(0, 200) });
    return NextResponse.json({ error: "bridge 連線失敗" }, { status: 502 });
  }

  // 找出此 account 旗下所有 Group
  const accountGroups = await prisma.group.findMany({
    where: {
      workspaceId,
      accountMemberships: { some: { accountId } },
    },
    select: { id: true, platformGroupId: true, conversationPinnedAt: true },
  });

  const tgPinnedSet = new Set(pinnedPlatformIds);
  const now = new Date();
  let pinnedCount = 0;
  let unpinnedCount = 0;

  for (const g of accountGroups) {
    const shouldBePinned = tgPinnedSet.has(g.platformGroupId);
    const isPinned = g.conversationPinnedAt != null;
    if (shouldBePinned && !isPinned) {
      await prisma.group.update({
        where: { id: g.id },
        data: { conversationPinnedAt: now },
      });
      pinnedCount++;
    } else if (!shouldBePinned && isPinned) {
      await prisma.group.update({
        where: { id: g.id },
        data: { conversationPinnedAt: null },
      });
      unpinnedCount++;
    }
  }

  await logAudit({
    workspaceId,
    userId: auth.userId,
    action: "conversation.sync_pinned_from_tg",
    entityType: "CommunicationAccount",
    entityId: accountId,
    details: { pinnedCount, unpinnedCount, totalTGPinned: pinnedPlatformIds.length },
  });

  return NextResponse.json({
    pinned: pinnedCount,
    unpinned: unpinnedCount,
    totalTGPinned: pinnedPlatformIds.length,
  });
}
