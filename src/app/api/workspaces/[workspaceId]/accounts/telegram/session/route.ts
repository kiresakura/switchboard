import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireWorkspacePermission } from "@/lib/auth/middleware";
import { TelegramAuthFlow } from "@/lib/telegram/auth-flow";
import { logger } from "@/lib/logger";

const log = logger("TelegramSessionLogin");

type RouteParams = { params: Promise<{ workspaceId: string }> };

/**
 * 2026-05-21 Batch 4 — Session 字串登入。
 *
 * POST /api/workspaces/:id/accounts/telegram/session
 *   body: { accountId, sessionString, apiId, apiHash }
 *
 * 手機 / 驗證碼流程的替代入口。已能在他處正常連線的帳號可匯出 GramJS
 * StringSession 字串貼進來直接登入 —— 避開 phoneCodeHash 過期 / FLOOD_WAIT /
 * PendingAuthSession 30 分鐘視窗等不穩定因素。
 */
export async function POST(req: Request, { params }: RouteParams) {
  const { workspaceId } = await params;

  const auth = await requireWorkspacePermission(
    workspaceId,
    "canManageCommunicationAccounts",
  );
  if (auth instanceof NextResponse) return auth;

  try {
    const body = await req.json();
    const { accountId, sessionString, apiId, apiHash } = body;

    if (!accountId || !sessionString || !apiId || !apiHash) {
      return NextResponse.json(
        { error: "請提供帳號 ID、Session 字串、API ID 與 API Hash" },
        { status: 400 },
      );
    }
    const apiIdNum = Number(apiId);
    if (!Number.isInteger(apiIdNum) || apiIdNum <= 0) {
      return NextResponse.json({ error: "API ID 必須為正整數" }, { status: 400 });
    }

    const account = await prisma.communicationAccount.findFirst({
      where: { id: accountId, workspaceId, platform: "telegram" },
    });
    if (!account) {
      return NextResponse.json({ error: "找不到此帳號" }, { status: 404 });
    }

    const result = await TelegramAuthFlow.loginWithSessionString(
      accountId,
      String(sessionString),
      apiIdNum,
      String(apiHash),
    );
    if (!result.success) {
      return NextResponse.json({ error: result.error }, { status: 400 });
    }

    await prisma.communicationAccount.update({
      where: { id: accountId },
      data: { status: "ACTIVE", telegramUserId: result.userId },
    });

    await prisma.auditLog.create({
      data: {
        workspaceId,
        userId: auth.userId,
        action: "SESSION_STRING_LOGIN_TELEGRAM",
        entityType: "CommunicationAccount",
        entityId: accountId,
        details: { telegramUserId: result.userId, success: true },
      },
    });

    // 通知 bridge 連線新驗證的帳號;bridge 不可用時非致命(同 verify route)。
    const bridgeUrl =
      process.env.BRIDGE_URL ||
      `http://localhost:${process.env.BRIDGE_PORT || 3001}`;
    fetch(`${bridgeUrl}/reconnect`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.INTERNAL_SECRET ?? ""}`,
      },
      body: JSON.stringify({ accountId }),
      signal: AbortSignal.timeout(5000),
    }).catch((err) => {
      log.warn("bridge not available for auto-reconnect", {
        error: String(err),
      });
    });

    return NextResponse.json({
      success: true,
      accountId,
      telegramUserId: result.userId,
      message: "Session 登入成功",
    });
  } catch (error) {
    log.error("session-string login failed", { error: String(error) });
    return NextResponse.json(
      { error: "Session 登入失敗,請稍後再試" },
      { status: 500 },
    );
  }
}
