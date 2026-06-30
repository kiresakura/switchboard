import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireWorkspacePermission } from "@/lib/auth/middleware";
import { resolveVisibleAccountIds } from "@/lib/account-visibility";
import { logAudit } from "@/lib/audit/logger";
import { logger } from "@/lib/logger";
import { normalizeTelegramAdminAction } from "@/lib/telegram/admin-action";

const log = logger("TelegramAdminAction");

const BRIDGE_URL =
  process.env.BRIDGE_URL || `http://localhost:${process.env.BRIDGE_PORT || 3001}`;
const INTERNAL_SECRET = process.env.INTERNAL_SECRET;

type RouteParams = { params: Promise<{ workspaceId: string }> };

function actionChatIds(action: ReturnType<typeof normalizeTelegramAdminAction>): string[] {
  if (!action) return [];
  switch (action.kind) {
    case "pin-message":
    case "dialog-pin":
    case "channel-title":
    case "channel-admin":
      return [action.chatId];
    case "folder-update":
      return [
        ...action.includeChatIds,
        ...(action.pinnedChatIds ?? []),
        ...(action.excludeChatIds ?? []),
      ];
    case "folder-delete":
      return [];
  }
}

/**
 * POST /api/workspaces/:workspaceId/telegram-admin-action
 *
 * Thin, audited proxy for Telegram-side management operations that must be
 * executed by the connected bridge client: message/dialog pins, dialog filters,
 * channel title updates, and channel admin rights.
 */
export async function POST(req: Request, { params }: RouteParams) {
  const { workspaceId } = await params;
  const auth = await requireWorkspacePermission(
    workspaceId,
    "canManageCommunicationAccounts",
  );
  if (auth instanceof NextResponse) return auth;

  if (!INTERNAL_SECRET) {
    return NextResponse.json(
      { error: "bridge 未設定 INTERNAL_SECRET" },
      { status: 500 },
    );
  }

  let body: { accountId?: string; action?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "無效的請求內容" }, { status: 400 });
  }

  const accountId = typeof body.accountId === "string" ? body.accountId : "";
  const action = normalizeTelegramAdminAction(body.action);
  if (!accountId || !action) {
    return NextResponse.json(
      { error: "accountId 或 action 不合法" },
      { status: 400 },
    );
  }

  const visible = await resolveVisibleAccountIds({
    userId: auth.userId,
    workspaceId,
    isSystemAdmin: auth.isSystemAdmin,
    permissions: auth.permissions,
  });
  if (!visible.has(accountId)) {
    return NextResponse.json({ error: "無權使用此帳號" }, { status: 403 });
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

  if (action.kind === "folder-delete" || action.kind === "folder-update") {
    const folder = await prisma.tgFolder.findUnique({
      where: {
        workspaceId_accountId_tgFilterId: {
          workspaceId,
          accountId,
          tgFilterId: action.filterId,
        },
      },
      select: { id: true },
    });
    if (!folder) {
      return NextResponse.json(
        { error: "無法驗證此 Telegram 資料夾屬於目前工作區/帳號，已拒絕操作" },
        { status: 403 },
      );
    }
  }

  const uniqueChatIds = Array.from(new Set(actionChatIds(action)));
  if (uniqueChatIds.length > 0) {
    const groups = await prisma.group.findMany({
      where: {
        workspaceId,
        platformGroupId: { in: uniqueChatIds },
        accountMemberships: { some: { accountId } },
      },
      select: { id: true, platformGroupId: true, chatType: true },
    });
    const found = new Set(groups.map((g) => g.platformGroupId));
    const missing = uniqueChatIds.filter((id) => !found.has(id));
    if (missing.length > 0) {
      return NextResponse.json(
        { error: "action 包含不屬於此帳號/工作區的對話", missingChatIds: missing },
        { status: 403 },
      );
    }
    if (
      (action.kind === "channel-title" || action.kind === "channel-admin") &&
      groups.some((g) => g.chatType === "PRIVATE")
    ) {
      return NextResponse.json(
        { error: "頻道管理操作不能套用在 1:1 私訊" },
        { status: 400 },
      );
    }
    if (action.kind === "channel-title" && groups.some((g) => g.chatType !== "CHANNEL")) {
      return NextResponse.json(
        { error: "channel-title 僅支援 Telegram channel" },
        { status: 400 },
      );
    }
  }

  try {
    if (action.kind === "channel-admin") {
      return NextResponse.json(
        { error: "channel-admin 暫停開放：需更細的高風險 Telegram 管理員權限設定" },
        { status: 403 },
      );
    }

    const bridgeRes = await fetch(`${BRIDGE_URL}/telegram-admin-action`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${INTERNAL_SECRET}`,
      },
      body: JSON.stringify({ accountId, action }),
      signal: AbortSignal.timeout(20_000),
    });
    const result = (await bridgeRes.json().catch(() => ({}))) as {
      success?: boolean;
      error?: string;
    };
    if (!bridgeRes.ok || result.success === false || result.error) {
      return NextResponse.json(
        { error: result.error || "Telegram 管理操作失敗" },
        { status: bridgeRes.ok ? 400 : 502 },
      );
    }

    const now = new Date();
    if (action.kind === "dialog-pin") {
      await prisma.group.updateMany({
        where: { workspaceId, platformGroupId: action.chatId },
        data: { conversationPinnedAt: action.pinned ? now : null },
      });
    } else if (action.kind === "channel-title") {
      await prisma.group.updateMany({
        where: { workspaceId, platformGroupId: action.chatId },
        data: { title: action.title },
      });
    } else if (action.kind === "pin-message") {
      await prisma.group.updateMany({
        where: { workspaceId, platformGroupId: action.chatId },
        data: {
          pinnedPlatformMessageId: action.unpin ? null : String(action.messageId),
          pinnedRefreshedAt: now,
        },
      });
    }

    await logAudit({
      workspaceId,
      userId: auth.userId,
      action: `telegram_admin.${action.kind}`,
      entityType: "CommunicationAccount",
      entityId: accountId,
      details: { action },
    });

    return NextResponse.json({ success: true });
  } catch (err) {
    log.warn("bridge telegram-admin-action failed", {
      accountId,
      kind: action.kind,
      error: String(err).slice(0, 200),
    });
    return NextResponse.json(
      { error: "bridge 連線失敗" },
      { status: 502 },
    );
  }
}
