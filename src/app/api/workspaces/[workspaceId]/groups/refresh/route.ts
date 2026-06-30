import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireWorkspacePermission } from "@/lib/auth/middleware";
import { logAudit } from "@/lib/audit/logger";
import { logger } from "@/lib/logger";
import { mergeGroupInto } from "@/lib/groups/merge-group";

const log = logger("GroupRefresh");

type RouteParams = { params: Promise<{ workspaceId: string }> };

const BRIDGE_URL = process.env.BRIDGE_URL || `http://localhost:${process.env.BRIDGE_PORT || 3001}`;
const INTERNAL_SECRET = process.env.INTERNAL_SECRET;

// GET /api/workspaces/:id/groups/refresh — preview: list TG groups without auto-registering
export async function GET(_req: Request, { params }: RouteParams) {
  const { workspaceId } = await params;
  const auth = await requireWorkspacePermission(workspaceId, "canManageGroupRegistry");
  if (auth instanceof NextResponse) return auth;

  try {
    const res = await fetch(`${BRIDGE_URL}/discover-preview`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${INTERNAL_SECRET || ""}`,
      },
      body: JSON.stringify({ workspaceId }),
      signal: AbortSignal.timeout(30000),
    });

    if (!res.ok) {
      return NextResponse.json(
        { error: "Bridge 同步失敗，請確認 bridge 服務是否運行" },
        { status: 502 }
      );
    }

    const data = await res.json();
    return NextResponse.json({
      groups: data.groups || [],
      newCount: data.newCount || 0,
      totalCount: data.totalCount || 0,
      errors: data.errors || [],  // 透傳每個帳號的執行錯誤（client 未連線等）
    });
  } catch (err) {
    log.error("Failed to call bridge /discover-preview", { error: String(err) });
    return NextResponse.json(
      { error: "無法連接 Bridge 服務" },
      { status: 502 }
    );
  }
}

// POST /api/workspaces/:id/groups/refresh — register SELECTED groups from preview
// Body: { groups: [{ platformGroupId, title, chatType, accountId }] }
export async function POST(req: Request, { params }: RouteParams) {
  const { workspaceId } = await params;
  const auth = await requireWorkspacePermission(workspaceId, "canManageGroupRegistry");
  if (auth instanceof NextResponse) return auth;

  // 同步策略(2026-05-05 spec 變更):
  //   - 預設「全部 TG 對話都登記到 Switchboard」(isActive=true, isHidden=false),
  //     不再依勾選決定可見性。原本「沒勾就藏起來」的 UX 太粗暴 — 使用者
  //     可能只是不想監聽某個群組,但仍希望它出現在群組管理 / 配對候選裡。
  //   - 勾選只控「該帳號是否擔任 listening account」(isListeningAccount):
  //     有勾 → 接收新訊息(進 review queue / DCM 歸檔等);沒勾 → 不接收。
  //   - 既有的 isHidden / isActive 由群組管理頁面的「隱藏」/「停用」按鈕單獨控制,
  //     跟同步流程脫鉤。
  //
  // Body schema:
  //   - wantListening?: boolean(新)— 預設 true。false = 不擔任此對話的 listener。
  //   - isHidden?: boolean(legacy / deprecated)— 仍接受但忽略其 isActive 副作用,
  //     僅當 wantListening 沒帶時當 fallback:isHidden=true ⇒ wantListening=false。
  let body: {
    groups?: Array<{
      platformGroupId: string;
      title: string;
      chatType: string;
      accountId: string;
      wantListening?: boolean;
      /** @deprecated use wantListening */
      isHidden?: boolean;
    }>;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "無效的請求內容" }, { status: 400 });
  }

  const selected = body.groups;
  if (!selected || !Array.isArray(selected) || selected.length === 0) {
    return NextResponse.json({ error: "請至少選擇一個群組" }, { status: 400 });
  }

  let registeredListening = 0;
  let registeredSilent = 0;
  const upsertedGroupIds: string[] = [];

  for (const g of selected) {
    // 判斷監聽意願:wantListening 優先;沒帶就看 legacy isHidden(true=不監聽);
    // 全沒帶 → 預設 true(勾)。
    const wantListening =
      typeof g.wantListening === "boolean"
        ? g.wantListening
        : g.isHidden === true
          ? false
          : true;
    try {
      const existing = await prisma.group.findUnique({
        where: {
          workspaceId_platformGroupId: {
            workspaceId,
            platformGroupId: g.platformGroupId,
          },
        },
      });
      let group;
      if (existing) {
        // 已存在:更新 metadata + 把 isActive 翻回 true。
        //
        // 為什麼動 isActive:isActive=false 只會被「系統」設(刪帳號的
        // cascade、data hygiene),從來不是使用者直接設的;當使用者明確
        // 把這個群組勾進 sync dialog,就是表達「我要這個群組存在」,
        // 系統先前因 cascade 軟刪的 isActive 應該被覆寫回 true,否則
        // 群組同步成功了卻在 UI 上看不見,讓人困惑。
        //
        // 為什麼不動 isHidden:isHidden 是使用者主動按「隱藏」按鈕造成
        // 的,re-sync 不該把它翻回來(尊重原本的隱藏意圖)。
        group = await prisma.group.update({
          where: { id: existing.id },
          data: {
            title: g.title,
            chatType: g.chatType || "GROUP",
            isActive: true,
          },
        });
      } else {
        // 新建:預設全可見、active。同步把 TG 上有的對話如實登記進來,
        // 由使用者再決定要不要藏 / 停用。
        group = await prisma.group.create({
          data: {
            workspaceId,
            platformGroupId: g.platformGroupId,
            title: g.title,
            side: "UNASSIGNED",
            chatType: g.chatType || "GROUP",
            isActive: true,
            isHidden: false,
          },
        });
      }
      upsertedGroupIds.push(group.id);

      // 唯一受勾選影響的:該帳號的 isListeningAccount。
      //   勾(wantListening=true) → true(明確覆寫)
      //   沒勾(wantListening=false) → false(明確設成不監聽)
      // 這跟舊版「沒勾不主動關現有監聽」的保守行為不同 — 新 spec 下「沒勾」
      // 是使用者明確表達不要監聽,server 應該照做。
      await prisma.accountGroupMembership.upsert({
        where: { accountId_groupId: { accountId: g.accountId, groupId: group.id } },
        create: {
          accountId: g.accountId,
          groupId: group.id,
          isListeningAccount: wantListening,
        },
        update: {
          isListeningAccount: wantListening,
        },
      });

      if (wantListening) registeredListening++;
      else registeredSilent++;
    } catch (err) {
      log.warn("Failed to register group", { platformGroupId: g.platformGroupId, error: String(err) });
    }
  }

  // ─── 自動清除同名重複群組 ─────────────────────────────────────
  // 同步流程結束後，若同 workspace 內有同名群組（多半是「超級群組升級」的舊 row 殘留，
  // 或不同 chatType 兩筆並存 = bridge 早期誤分類）→ 自動以 -100 開頭那筆為主合併。
  // 不問使用者，因為系統有確定性規則可以判斷哪筆該保留。
  let mergedDuplicates = 0;
  let droppedRows = 0;
  try {
    const allActive = await prisma.group.findMany({
      where: { workspaceId, isActive: true },
      orderBy: { createdAt: "asc" },
    });
    const byTitle = new Map<string, typeof allActive>();
    for (const g of allActive) {
      const list = byTitle.get(g.title) ?? [];
      list.push(g);
      byTitle.set(g.title, list);
    }
    for (const [, list] of byTitle.entries()) {
      if (list.length < 2) continue;
      // 規則：(1) -100 開頭優先（超級群組）；(2) 同類則取最早建立
      const sorted = [...list].sort((a, b) => {
        const aIs100 = a.platformGroupId.startsWith("-100");
        const bIs100 = b.platformGroupId.startsWith("-100");
        if (aIs100 !== bIs100) return aIs100 ? -1 : 1;
        return a.createdAt.getTime() - b.createdAt.getTime();
      });
      const keepId = sorted[0].id;
      // 把 keep row 可能誤分類成 CHANNEL 的修回 GROUP（icon 顯示問題）
      if (sorted[0].chatType === "CHANNEL") {
        await prisma.group.update({
          where: { id: keepId },
          data: { chatType: "GROUP" },
        });
      }
      for (const drop of sorted.slice(1)) {
        await mergeGroupInto(drop.id, keepId);
        droppedRows++;
      }
      mergedDuplicates++;
    }
  } catch (err) {
    log.warn("auto-merge duplicates failed (non-fatal)", { error: String(err) });
  }

  // (Pairing-reconcile step removed with H2 broker-strip — Pairing model
  // no longer exists; group registration is the whole job now.)
  void upsertedGroupIds;

  await logAudit({
    workspaceId,
    userId: auth.userId,
    action: "groups.selective_sync",
    entityType: "Group",
    entityId: workspaceId,
    details: {
      registeredListening,
      registeredSilent,
      requested: selected.length,
      mergedDuplicates,
      droppedRows,
    },
  }).catch(() => {});

  const totalRegistered = registeredListening + registeredSilent;
  const msgParts = [`已同步 ${totalRegistered} 個對話`];
  if (registeredListening > 0)
    msgParts.push(`其中 ${registeredListening} 個被監聽`);
  if (registeredSilent > 0)
    msgParts.push(`${registeredSilent} 個僅登記不監聽`);
  if (mergedDuplicates > 0)
    msgParts.push(`自動合併 ${mergedDuplicates} 組重複群組`);

  return NextResponse.json({
    success: true,
    registered: totalRegistered,
    registeredListening,
    registeredSilent,
    // legacy 欄位保留兼容(舊 UI 回應 parser 仍可解;新 UI 改讀 registeredListening / Silent)
    registeredHidden: registeredSilent,
    mergedDuplicates,
    droppedRows,
    message: msgParts.join("；"),
  });
}
