import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireWorkspaceMember } from "@/lib/auth/middleware";
import { logger } from "@/lib/logger";
import { upsertAccountFolders } from "@/lib/telegram/folder-sync";

const log = logger("TgFolders");

type RouteParams = { params: Promise<{ workspaceId: string }> };

const BRIDGE_URL = process.env.BRIDGE_URL || `http://localhost:${process.env.BRIDGE_PORT || 3001}`;
const INTERNAL_SECRET = process.env.INTERNAL_SECRET;

/**
 * P2 2026-05-20:TG 原生資料夾(DialogFilter)同步。
 *
 *   GET  → 列出此 workspace 所有 TgFolder + 各自的 groupIds(供 UI 顯示 chips 用)
 *   POST → 觸發同步:呼叫 bridge `/get-dialog-filters`,把 TG 端的資料夾結構
 *          落到 Switchboard DB,把 TG peer ids 解析到 Switchboard Group.id
 *
 * 員工已經在 TG 端分好類了,我們 sync 過來作 chat list 快速 filter — 不逼員工
 * 在 Switchboard 重做分類。
 */
export async function GET(_req: Request, { params }: RouteParams) {
  const { workspaceId } = await params;
  const auth = await requireWorkspaceMember(workspaceId);
  if (auth instanceof NextResponse) return auth;

  const folders = await prisma.tgFolder.findMany({
    where: { workspaceId },
    orderBy: [{ accountId: "asc" }, { tgFilterId: "asc" }],
    select: {
      id: true,
      accountId: true,
      tgFilterId: true,
      title: true,
      emoticon: true,
      groupIds: true,
      syncedAt: true,
      account: { select: { displayName: true } },
    },
  });

  return NextResponse.json({
    folders: folders.map((f) => ({
      id: f.id,
      accountId: f.accountId,
      accountName: f.account.displayName ?? "(未命名帳號)",
      tgFilterId: f.tgFilterId,
      title: f.title,
      emoticon: f.emoticon,
      groupIds: f.groupIds,
      syncedAt: f.syncedAt.toISOString(),
    })),
  });
}

/**
 * POST /api/workspaces/[ws]/tg-folders — 手動同步觸發(緊急 fallback)。
 *
 * 2026-05-21:TG 資料夾「主要」由 bridge discovery loop 每 5 分鐘自動同步
 * (見 telegram-bridge.ts syncAllAccountFolders)。這支 POST 保留給:
 *   - 員工剛在 TG 端改了資料夾、不想等下一輪自動同步
 *   - 自動同步出狀況時的緊急手動觸發
 *
 * body: { accountId? } — 沒給就同步全部 ACTIVE accounts
 * 流程跟自動同步一樣,共用 upsertAccountFolders;差別只在 filters 來源是
 * 走 HTTP bridge /get-dialog-filters(API 端沒有 clientManager 實例)。
 */
export async function POST(req: Request, { params }: RouteParams) {
  const { workspaceId } = await params;
  const auth = await requireWorkspaceMember(workspaceId);
  if (auth instanceof NextResponse) return auth;

  let body: { accountId?: string } = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }

  if (!INTERNAL_SECRET) {
    return NextResponse.json(
      { error: "bridge 未設定 INTERNAL_SECRET" },
      { status: 500 }
    );
  }

  const accounts = await prisma.communicationAccount.findMany({
    where: {
      workspaceId,
      status: "ACTIVE",
      ...(body.accountId ? { id: body.accountId } : {}),
    },
    select: { id: true, displayName: true },
  });
  if (accounts.length === 0) {
    return NextResponse.json({ syncedAccounts: 0, syncedFolders: 0 });
  }

  let syncedFolders = 0;
  for (const acc of accounts) {
    try {
      const res = await fetch(`${BRIDGE_URL}/get-dialog-filters`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${INTERNAL_SECRET}`,
        },
        body: JSON.stringify({ accountId: acc.id }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) {
        log.warn("bridge /get-dialog-filters failed", {
          accountId: acc.id,
          status: res.status,
        });
        continue;
      }
      const data = (await res.json()) as {
        filters?: Array<{
          tgFilterId: number;
          title: string;
          emoticon: string | null;
          peerIds: string[];
        }>;
      };
      // 共用 upsertAccountFolders — 跟 bridge 自動同步走同一套寫入邏輯。
      const result = await upsertAccountFolders(
        prisma,
        workspaceId,
        acc.id,
        data.filters ?? [],
      );
      syncedFolders += result.upserted;
    } catch (err) {
      log.warn("TgFolder sync failed for account", {
        accountId: acc.id,
        error: String(err).slice(0, 200),
      });
    }
  }

  return NextResponse.json({
    syncedAccounts: accounts.length,
    syncedFolders,
  });
}
