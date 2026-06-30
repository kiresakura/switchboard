import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireWorkspacePermission } from "@/lib/auth/middleware";
import { logger } from "@/lib/logger";
import { mergeGroupInto } from "@/lib/groups/merge-group";

const log = logger("GroupAutoSync");

type RouteParams = { params: Promise<{ workspaceId: string }> };

const BRIDGE_URL =
  process.env.BRIDGE_URL || `http://localhost:${process.env.BRIDGE_PORT || 3001}`;
const INTERNAL_SECRET = process.env.INTERNAL_SECRET;

type DiscoveredChat = {
  platformGroupId: string;
  title: string;
  chatType: string;
  accountId: string;
  isNew: boolean;
  isReactivatable?: boolean;
};

// POST /api/workspaces/:id/groups/auto-sync
//
// 進入群組管理頁時自動跑的「無聲完整同步」：
//   1. 向 bridge 取最新 chat 列表（discover-preview）
//   2. 把所有 isNew / isReactivatable 全部 upsert 到 DB（不問使用者）
//   3. 合併同名重複群組（以 -100 開頭那筆為主）
//   4. 把所有 chatType=CHANNEL 的群統一改 GROUP（修早期誤分類）
//   5. 復原停用配對（若所有 groupLinks 都已啟用）
//
// 失敗（例：bridge 沒跑）→ 回 200 + 帶 error 訊息，client 照常呈現現有資料；
// 不會丟 5xx 阻塞整個頁面。
export async function POST(_req: Request, { params }: RouteParams) {
  const { workspaceId } = await params;
  const auth = await requireWorkspacePermission(workspaceId, "canManageGroupRegistry");
  if (auth instanceof NextResponse) return auth;

  let bridgeOk = true;
  let bridgeError = "";
  let registered = 0;
  let mergedDuplicates = 0;
  let droppedRows = 0;
  let normalizedChannels = 0;

  // ── 1. discover-preview ──
  let discovered: DiscoveredChat[] = [];
  try {
    const res = await fetch(`${BRIDGE_URL}/discover-preview`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${INTERNAL_SECRET || ""}`,
      },
      body: JSON.stringify({ workspaceId }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      bridgeOk = false;
      bridgeError = "Bridge 無法回應（可能未啟動）";
    } else {
      const data = await res.json();
      discovered = (data.groups ?? []) as DiscoveredChat[];
    }
  } catch (err) {
    bridgeOk = false;
    bridgeError = "無法連接 Bridge 服務";
    log.warn("auto-sync: bridge unreachable", { error: String(err) });
  }

  // ── 2. 註冊所有「真正新增」的群組，不問使用者 ──
  if (bridgeOk) {
    const toRegister = discovered.filter((g) => g.isNew);
    for (const g of toRegister) {
      try {
        const group = await prisma.group.upsert({
          where: {
            workspaceId_platformGroupId: {
              workspaceId,
              platformGroupId: g.platformGroupId,
            },
          },
          create: {
            workspaceId,
            platformGroupId: g.platformGroupId,
            title: g.title,
            side: "UNASSIGNED",
            chatType: g.chatType || "GROUP",
          },
          update: {
            title: g.title,
            chatType: g.chatType || "GROUP",
            isActive: true,
            isHidden: false,
          },
        });
        await prisma.accountGroupMembership.upsert({
          where: {
            accountId_groupId: { accountId: g.accountId, groupId: group.id },
          },
          create: {
            accountId: g.accountId,
            groupId: group.id,
            isListeningAccount: true,
          },
          update: {},
        });
        registered++;
      } catch (err) {
        log.warn("auto-sync register failed", {
          platformGroupId: g.platformGroupId,
          error: String(err),
        });
      }
    }
  }

  // ── 2.5 自動復原「因帳號被刪而孤兒化」的群組（不打擾使用者）──
  //
  // 情境：使用者把 TG 帳號刪掉 → 該帳號獨佔的群組被軟刪除 (isActive=false)
  //       連帶該群組所屬的配對也被停用。後來重新加同號或別的Telegram 帳號，
  //       bridge 又看到這些群組（isReactivatable=true）。
  //
  // 我們要區分兩種「isReactivatable」狀態：
  //   A) 「孤兒群組」(由帳號刪除 cascade 而來) — 該 group 的 AccountGroupMembership
  //      已被 cascade 全部刪光、目前 0 個 membership → 應該自動復原（使用者
  //      預期：「之前的配對 / 客戶設定 / 標籤都直接接回去，不用再手動勾」）。
  //   B) 「使用者刻意隱藏」(從 sync dialog 取消勾選 / 從群組頁手動隱藏) —
  //      該 group 仍有至少一個 AccountGroupMembership (帳號還在)。這種要尊重
  //      使用者的意圖，不能無聲翻出，仍需走 sync dialog 重新勾選。
  //
  // 這個自動復原 = 只處理 A，不碰 B。
  let autoRevivedOrphans = 0;
  if (bridgeOk) {
    const reactivatable = discovered.filter((g) => g.isReactivatable);
    for (const g of reactivatable) {
      try {
        const existing = await prisma.group.findUnique({
          where: {
            workspaceId_platformGroupId: {
              workspaceId,
              platformGroupId: g.platformGroupId,
            },
          },
          include: {
            _count: { select: { accountMemberships: true } },
          },
        });
        if (!existing || existing.isActive) continue; // 不是 reactivatable，跳

        // 這支群組目前有沒有任何 membership？沒有 → 是「孤兒」（情境 A）
        const isOrphaned = existing._count.accountMemberships === 0;
        if (!isOrphaned) {
          // 情境 B：使用者隱藏了這群組但帳號還在。尊重使用者意圖，
          // 不碰 isActive，等 sync dialog 由人工確認。
          continue;
        }

        // 情境 A：自動復原
        await prisma.group.update({
          where: { id: existing.id },
          data: {
            title: g.title,
            chatType: g.chatType || "GROUP",
            isActive: true,
            isHidden: false,
          },
        });
        await prisma.accountGroupMembership.upsert({
          where: {
            accountId_groupId: { accountId: g.accountId, groupId: existing.id },
          },
          create: {
            accountId: g.accountId,
            groupId: existing.id,
            isListeningAccount: true,
          },
          update: { isListeningAccount: true },
        });
        autoRevivedOrphans++;
        log.info("auto-revived orphan group (account re-added)", {
          groupId: existing.id,
          title: g.title,
          newAccountId: g.accountId,
        });
      } catch (err) {
        log.warn("auto-revive orphan failed", {
          platformGroupId: g.platformGroupId,
          error: String(err),
        });
      }
    }
  }

  // ── 3. 合併同名重複群組 ──
  try {
    const all = await prisma.group.findMany({
      where: { workspaceId, isActive: true },
      orderBy: { createdAt: "asc" },
    });
    const byTitle = new Map<string, typeof all>();
    for (const g of all) {
      const list = byTitle.get(g.title) ?? [];
      list.push(g);
      byTitle.set(g.title, list);
    }
    for (const [, list] of byTitle.entries()) {
      if (list.length < 2) continue;
      const sorted = [...list].sort((a, b) => {
        const aIs100 = a.platformGroupId.startsWith("-100");
        const bIs100 = b.platformGroupId.startsWith("-100");
        if (aIs100 !== bIs100) return aIs100 ? -1 : 1;
        return a.createdAt.getTime() - b.createdAt.getTime();
      });
      const keepId = sorted[0].id;
      for (const drop of sorted.slice(1)) {
        await mergeGroupInto(drop.id, keepId);
        droppedRows++;
      }
      mergedDuplicates++;
    }
  } catch (err) {
    log.warn("auto-sync merge failed", { error: String(err) });
  }

  // ── 4. CHANNEL → GROUP 統一修正 ──
  try {
    const r = await prisma.group.updateMany({
      where: { workspaceId, chatType: "CHANNEL" },
      data: { chatType: "GROUP" },
    });
    normalizedChannels = r.count;
  } catch (err) {
    log.warn("auto-sync chatType normalize failed", { error: String(err) });
  }

  // (Pairing reconcile + dedup steps removed with H2 broker-strip.)

  return NextResponse.json({
    success: true,
    bridgeOk,
    bridgeError,
    registered,
    autoRevivedOrphans,
    mergedDuplicates,
    droppedRows,
    normalizedChannels,
  });
}
