import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireWorkspacePermission } from "@/lib/auth/middleware";
import { resolveVisibleAccountIds } from "@/lib/account-visibility";
import { logAudit } from "@/lib/audit/logger";
import { logger } from "@/lib/logger";

const log = logger("QuickReplySync");

type RouteParams = {
  params: Promise<{ workspaceId: string; accountId: string }>;
};

const BRIDGE_URL = process.env.BRIDGE_URL || `http://localhost:${process.env.BRIDGE_PORT || 3001}`;
const INTERNAL_SECRET = process.env.INTERNAL_SECRET;

/**
 * 2026-05-21 TG Business Phase B(round 4):
 * `POST /api/.../accounts/[acc]/quick-replies/sync` — 從 TG pull server-side quick
 * replies,upsert 到 Switchboard QuickReply 表(tgShortcutId + tgAccountId 標識 sync 來源)。
 *
 * 行為:
 *   - 純 PULL(TG → Switchboard),不刪 Switchboard 既有的本地 row
 *   - 失蹤(TG 端刪掉但 Switchboard 還有 sync 記錄)→ 軟刪 = 不存在於本次 sync 的 tgShortcutId 對應 row 改 ownerUserId=null + scope=WORKSPACE(防止員工依賴失蹤的 shortcut)
 *     ⚠️ 簡化:直接刪掉(`deleteMany`),tgAccountId+shortcut unique 已防衝突。日後若需保留歷史改 soft-delete。
 *   - 只 sync 文字 body 已知是空(TG 不暴露 quick reply 內容,需 GetQuickReplyMessages 拉訊息列表)— MVP 先存 shortcut + topMessageId,UI 顯示時提示「(內容需在 TG 端查看)」
 *
 * 權限:account 必須可見 + 有 canManageCommunicationAccounts(或 admin)。
 */
export async function POST(_req: Request, { params }: RouteParams) {
  const { workspaceId, accountId } = await params;
  const auth = await requireWorkspacePermission(workspaceId);
  if (auth instanceof NextResponse) return auth;

  if (
    !auth.isSystemAdmin &&
    !auth.permissions.canManageCommunicationAccounts
  ) {
    return NextResponse.json({ error: "權限不足" }, { status: 403 });
  }

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
    select: { id: true, displayName: true },
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

  let shortcuts: Array<{
    shortcutId: number;
    shortcut: string;
    topMessageId: number;
    count: number;
  }> = [];
  try {
    const r = await fetch(`${BRIDGE_URL}/tg-business/quick-replies`, {
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
      log.warn("bridge /tg-business/quick-replies failed", {
        accountId,
        status: r.status,
        body: errBody.slice(0, 200),
      });
      return NextResponse.json(
        { error: "TG 同步失敗(可能此帳號非 Premium)" },
        { status: 502 },
      );
    }
    const data = (await r.json()) as {
      shortcuts?: typeof shortcuts;
      error?: string;
    };
    shortcuts = Array.isArray(data.shortcuts) ? data.shortcuts : [];
    if (data.error) {
      log.warn("bridge returned error", {
        accountId,
        error: String(data.error).slice(0, 200),
      });
    }
  } catch (err) {
    log.warn("bridge call failed", {
      accountId,
      err: String(err).slice(0, 200),
    });
    return NextResponse.json({ error: "bridge 連線失敗" }, { status: 502 });
  }

  // Upsert each shortcut
  let upserted = 0;
  const seenIds: number[] = [];
  for (const s of shortcuts) {
    seenIds.push(s.shortcutId);
    await prisma.quickReply.upsert({
      where: { tgAccountId_shortcut: { tgAccountId: accountId, shortcut: s.shortcut } },
      create: {
        workspaceId,
        tgAccountId: accountId,
        tgShortcutId: s.shortcutId,
        ownerUserId: auth.userId,
        scope: "PRIVATE",
        shortcut: s.shortcut,
        title: s.shortcut, // TG 沒給「title」概念,先用 shortcut 自己當顯示
        body: `(此 shortcut 同步自 Telegram;訊息內容請在 TG 端查看 ${s.count} 條訊息)`,
        sortOrder: 0,
      },
      update: {
        tgShortcutId: s.shortcutId,
        // 不覆蓋使用者在 Switchboard 端自己改的 body / title — 純更新 sync metadata
      },
    });
    upserted++;
  }

  // 把這次 sync 沒看到的 tgAccountId 對應 row(TG 端被刪)刪掉,保持 mirror。
  // 注意:tgAccountId IS NOT NULL → 只動 sync 自此帳號的 row,本地 row(tgAccountId=null)不動。
  const tombstoneIds = (
    await prisma.quickReply.findMany({
      where: {
        workspaceId,
        tgAccountId: accountId,
        ...(seenIds.length > 0 ? { tgShortcutId: { notIn: seenIds } } : {}),
      },
      select: { id: true },
    })
  ).map((r) => r.id);
  if (tombstoneIds.length > 0) {
    await prisma.quickReply.deleteMany({ where: { id: { in: tombstoneIds } } });
  }

  await logAudit({
    workspaceId,
    userId: auth.userId,
    action: "quick_reply.sync_from_tg",
    entityType: "CommunicationAccount",
    entityId: accountId,
    details: { upserted, removed: tombstoneIds.length },
  });

  return NextResponse.json({
    syncedShortcuts: upserted,
    removedShortcuts: tombstoneIds.length,
  });
}
