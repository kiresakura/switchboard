/**
 * folder-sync — TG 原生資料夾(DialogFilter)→ Switchboard TgFolder 的 upsert 邏輯。
 *
 * 2026-05-21:抽成共用函式,給兩個 caller 用:
 *   1. Bridge discovery loop —— 自動同步(每 5 分鐘,主要路徑)
 *   2. tg-folders API POST —— 手動同步(緊急 / 即時觸發,fallback)
 *
 * 兩者拿到 filters 的方式不同(bridge 直接 clientManager.getDialogFilters,
 * API 走 HTTP /get-dialog-filters),但「把 filters 寫進 DB」的邏輯一樣 —
 * 就是這個檔案。
 *
 * 純 DB 操作,不碰 GramJS / HTTP — caller 負責先取得 filters 再傳進來。
 */

import type { PrismaClient } from "@prisma/client";

/** 已正規化的 TG 資料夾(對齊 clientManager.getDialogFilters 回傳)。 */
export type TgDialogFilter = {
  tgFilterId: number;
  title: string;
  emoticon: string | null;
  /** 此 filter 應包含的 TG peer id(platformGroupId 格式)。 */
  peerIds: string[];
};

export type FolderUpsertResult = {
  /** 成功 upsert 的 folder 數。 */
  upserted: number;
  /** 因 TG 端刪除而被清掉的 folder 數。 */
  removed: number;
};

/**
 * 把某帳號的一批 TG 資料夾 upsert 進 TgFolder 表。
 *
 *   - peerIds 解析成 Switchboard Group.id(查 Group;沒登錄過的 peer 自然漏掉,
 *     等下次該 group 有訊息被 auto-register 後,下輪 sync 自動補上)
 *   - upsert key = (workspaceId, accountId, tgFilterId)
 *   - 此帳號之前 sync 過、但這次 filters 不再出現的 → 刪除(維持 mirror)
 *
 * @returns { upserted, removed }
 */
export async function upsertAccountFolders(
  prisma: PrismaClient,
  workspaceId: string,
  accountId: string,
  filters: TgDialogFilter[],
): Promise<FolderUpsertResult> {
  // 一次把所有 peerIds 查 Group 解析成 Switchboard Group.id
  const allPeerIds = Array.from(new Set(filters.flatMap((f) => f.peerIds)));
  const groups =
    allPeerIds.length === 0
      ? []
      : await prisma.group.findMany({
          where: { workspaceId, platformGroupId: { in: allPeerIds } },
          select: { id: true, platformGroupId: true },
        });
  const platformToGroupId = new Map(
    groups.map((g) => [g.platformGroupId, g.id]),
  );

  let upserted = 0;
  const seenFilterIds = new Set<number>();
  for (const f of filters) {
    seenFilterIds.add(f.tgFilterId);
    const groupIds = f.peerIds
      .map((pid) => platformToGroupId.get(pid))
      .filter((v): v is string => !!v);
    await prisma.tgFolder.upsert({
      where: {
        workspaceId_accountId_tgFilterId: {
          workspaceId,
          accountId,
          tgFilterId: f.tgFilterId,
        },
      },
      create: {
        workspaceId,
        accountId,
        tgFilterId: f.tgFilterId,
        title: f.title,
        emoticon: f.emoticon,
        groupIds,
      },
      update: {
        title: f.title,
        emoticon: f.emoticon,
        groupIds,
        syncedAt: new Date(),
      },
    });
    upserted++;
  }

  // 清掉此帳號之前 sync 過、但 TG 端已刪的 filter。
  let removed = 0;
  if (seenFilterIds.size > 0) {
    const del = await prisma.tgFolder.deleteMany({
      where: {
        workspaceId,
        accountId,
        tgFilterId: { notIn: Array.from(seenFilterIds) },
      },
    });
    removed = del.count;
  } else {
    // TG 端整批清空 → 刪光此帳號所有 TgFolder。
    const del = await prisma.tgFolder.deleteMany({
      where: { workspaceId, accountId },
    });
    removed = del.count;
  }

  return { upserted, removed };
}
