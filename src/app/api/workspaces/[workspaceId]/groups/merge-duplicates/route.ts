import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireWorkspacePermission } from "@/lib/auth/middleware";
import { logAudit } from "@/lib/audit/logger";
import { mergeGroupInto } from "@/lib/groups/merge-group";

type RouteParams = { params: Promise<{ workspaceId: string }> };

// GET /api/workspaces/:id/groups/merge-duplicates
// 找出同 workspace 內「同 title」的多筆 Group（潛在重複），回傳 dry-run 預覽，
// 讓 admin 在 UI 上確認後再選一筆當主，把其他的軟刪除（isActive=false + 軟移除 membership）。
//
// 這個 API 自己不做合併動作 — 純診斷。實際合併走 POST，body 帶 keepGroupId + dropGroupIds。
export async function GET(_req: Request, { params }: RouteParams) {
  const { workspaceId } = await params;
  const auth = await requireWorkspacePermission(workspaceId, "canManageGroupRegistry");
  if (auth instanceof NextResponse) return auth;

  // 抓所有啟用中、按 title 分組
  // (pairingLinks 計數在 H4 broker-strip 拿掉。)
  const groups = await prisma.group.findMany({
    where: { workspaceId, isActive: true },
    include: {
      _count: {
        select: { accountMemberships: true },
      },
    },
    orderBy: { createdAt: "asc" },
  });

  const byTitle = new Map<string, typeof groups>();
  for (const g of groups) {
    const list = byTitle.get(g.title) ?? [];
    list.push(g);
    byTitle.set(g.title, list);
  }

  const duplicates = Array.from(byTitle.entries())
    .filter(([, list]) => list.length > 1)
    .map(([title, list]) => ({
      title,
      groups: list.map((g) => ({
        id: g.id,
        platformGroupId: g.platformGroupId,
        chatType: g.chatType,
        side: g.side,
        tags: g.tags,
        createdAt: g.createdAt.toISOString(),
        accountMembershipCount: g._count.accountMemberships,
      })),
    }));

  return NextResponse.json({ duplicates });
}

// POST /api/workspaces/:id/groups/merge-duplicates
//   body { auto: true } → 自動掃描 + 合併所有同名重複群組（保留 -100 開頭那筆 = supergroup）
//   body { keepGroupId, dropGroupIds } → 手動指定保留 / 丟棄哪幾筆
//
// 合併方式：完整把 drop 群組的 memberships / pairing links / messages /
// directChatMessage 全部轉到 keep 群組，drop 群組軟刪除。
export async function POST(req: Request, { params }: RouteParams) {
  const { workspaceId } = await params;
  const auth = await requireWorkspacePermission(workspaceId, "canManageGroupRegistry");
  if (auth instanceof NextResponse) return auth;

  let body: {
    auto?: boolean;
    keepGroupId?: string;
    dropGroupIds?: string[];
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "無效的請求內容" }, { status: 400 });
  }

  // ── auto 模式：掃所有同 title 的 dup，挑「-100 開頭 + 最早建立」當 keep ──
  if (body.auto === true) {
    const groups = await prisma.group.findMany({
      where: { workspaceId, isActive: true },
      orderBy: { createdAt: "asc" },
    });
    const byTitle = new Map<string, typeof groups>();
    for (const g of groups) {
      const list = byTitle.get(g.title) ?? [];
      list.push(g);
      byTitle.set(g.title, list);
    }

    const merges: Array<{ title: string; keep: string; drops: string[] }> = [];
    for (const [title, list] of byTitle.entries()) {
      if (list.length < 2) continue;
      // 優先順序：(1) -100 開頭（=supergroup）優先；(2) 同類別則最早建立的優先
      const sorted = [...list].sort((a, b) => {
        const aIs100 = a.platformGroupId.startsWith("-100");
        const bIs100 = b.platformGroupId.startsWith("-100");
        if (aIs100 !== bIs100) return aIs100 ? -1 : 1;
        return a.createdAt.getTime() - b.createdAt.getTime();
      });
      const keepRow = sorted[0];
      const dropRows = sorted.slice(1);
      merges.push({
        title,
        keep: keepRow.id,
        drops: dropRows.map((g) => g.id),
      });
    }

    let mergedGroups = 0;
    let droppedRows = 0;
    for (const m of merges) {
      for (const dropId of m.drops) {
        await mergeGroupInto(dropId, m.keep);
        droppedRows++;
      }
      mergedGroups++;
    }

    // 全 workspace 把所有 CHANNEL 類別的群組統一改成 GROUP。
    // 原因：bridge auto-register 之前把所有 -100 開頭的 chat 一律分類成 CHANNEL，
    // 但其實絕大多數是「超級群組 (megagroup)」應該是 GROUP。CS 用途幾乎沒有純廣播頻道，
    // 一律改 GROUP 是「絕大部分情況下對」，icon 也會變成藍色人。
    // 真有純廣播頻道的人可在「編輯」手動改回 CHANNEL（單一 row 級調整，不會被覆蓋）。
    const normalizedChannels = await prisma.group.updateMany({
      where: { workspaceId, chatType: "CHANNEL" },
      data: { chatType: "GROUP" },
    });

    await logAudit({
      workspaceId,
      userId: auth.userId,
      action: "groups.merge_duplicates_auto",
      entityType: "Workspace",
      entityId: workspaceId,
      details: {
        mergedGroups,
        droppedRows,
        normalizedChannels: normalizedChannels.count,
        merges,
      },
    }).catch(() => null);

    return NextResponse.json({
      success: true,
      mode: "auto",
      mergedGroups,
      droppedRows,
      normalizedChannels: normalizedChannels.count,
      merges,
    });
  }

  // ── 手動指定模式 ──
  const keep = body.keepGroupId;
  const drops = Array.isArray(body.dropGroupIds) ? body.dropGroupIds : [];
  if (!keep || drops.length === 0) {
    return NextResponse.json(
      { error: "需要 keepGroupId 與至少一個 dropGroupIds（或改傳 auto: true）" },
      { status: 400 },
    );
  }
  if (drops.includes(keep)) {
    return NextResponse.json(
      { error: "keepGroupId 不能同時出現在 dropGroupIds 裡" },
      { status: 400 },
    );
  }

  // 安全檢查：所有 id 都屬於本 workspace + 都還活著
  const allIds = [keep, ...drops];
  const groups = await prisma.group.findMany({
    where: { id: { in: allIds }, workspaceId, isActive: true },
    select: { id: true },
  });
  if (groups.length !== allIds.length) {
    return NextResponse.json(
      { error: "有部分群組 id 不屬於此 workspace 或已軟刪除" },
      { status: 400 },
    );
  }

  // 把可能被誤分類為 CHANNEL 的 keep row 改回 GROUP
  await prisma.group.updateMany({
    where: { id: keep, chatType: "CHANNEL" },
    data: { chatType: "GROUP" },
  });

  for (const dropId of drops) {
    await mergeGroupInto(dropId, keep);
  }

  await logAudit({
    workspaceId,
    userId: auth.userId,
    action: "groups.merge_duplicates",
    entityType: "Group",
    entityId: keep,
    details: { keep, drops },
  }).catch(() => null);

  return NextResponse.json({ success: true, dropped: drops.length });
}
