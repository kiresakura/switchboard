import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireWorkspacePermission } from "@/lib/auth/middleware";
import { TelegramAuthFlow } from "@/lib/telegram/auth-flow";
import { logger } from "@/lib/logger";

const log = logger("TelegramVerify");

type RouteParams = { params: Promise<{ workspaceId: string }> };

// POST /api/workspaces/:id/accounts/telegram/verify
export async function POST(req: Request, { params }: RouteParams) {
  const { workspaceId } = await params;
  
  const auth = await requireWorkspacePermission(workspaceId, "canManageCommunicationAccounts");
  if (auth instanceof NextResponse) return auth;

  try {
    const body = await req.json();
    const { accountId, verificationCode, password } = body;

    if (!accountId || !verificationCode) {
      return NextResponse.json(
        { error: "請提供帳號 ID 和驗證碼" },
        { status: 400 }
      );
    }

    // 驗證帳號屬於當前工作空間
    const account = await prisma.communicationAccount.findFirst({
      where: {
        id: accountId,
        workspaceId,
        platform: "telegram"
      }
    });

    if (!account) {
      return NextResponse.json(
        { error: "找不到此帳號" },
        { status: 404 }
      );
    }

    // 執行認證
    const authResult = await TelegramAuthFlow.verifyCode(
      accountId, 
      verificationCode, 
      password
    );

    if (!authResult.success) {
      return NextResponse.json(
        { 
          error: authResult.error,
          passwordRequired: authResult.passwordRequired,
          needsNewCode: authResult.needsNewCode
        },
        { status: 400 }
      );
    }

    // 更新帳號狀態為已連接
    await prisma.communicationAccount.update({
      where: { id: accountId },
      data: {
        status: "ACTIVE",
        telegramUserId: authResult.userId
      }
    });

    // 記錄成功認證
    await prisma.auditLog.create({
      data: {
        workspaceId,
        userId: auth.userId,
        action: "VERIFY_TELEGRAM_ACCOUNT",
        entityType: "CommunicationAccount",
        entityId: accountId,
        details: {
          phoneNumber: account.phoneNumber,
          telegramUserId: authResult.userId,
          success: true
        }
      }
    });

    // Notify bridge to connect the newly verified account.
    // Bridge unreachability is non-fatal here (verification itself succeeded),
    // but ops needs visibility — record an audit log so the failure is queryable.
    const bridgeUrl = process.env.BRIDGE_URL || `http://localhost:${process.env.BRIDGE_PORT || 3001}`;
    fetch(`${bridgeUrl}/reconnect`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.INTERNAL_SECRET ?? ""}`,
      },
      body: JSON.stringify({ accountId }),
      signal: AbortSignal.timeout(5000),
    }).catch((err) => {
      log.warn("bridge not available for auto-reconnect", { error: String(err) });
      prisma.auditLog
        .create({
          data: {
            workspaceId,
            userId: auth.userId,
            action: "BRIDGE_RECONNECT_FAILED",
            entityType: "CommunicationAccount",
            entityId: accountId,
            details: {
              reason: String(err),
              bridgeUrl,
            },
          },
        })
        .catch(() => {});
    });

    return NextResponse.json({
      success: true,
      accountId,
      telegramUserId: authResult.userId,
      message: "帳號驗證成功"
    });

  } catch (error) {
    log.error("failed to verify Telegram account", { error: String(error) });
    return NextResponse.json(
      { error: "帳號驗證失敗，請稍後再試" },
      { status: 500 }
    );
  }
}

// POST /api/workspaces/:id/accounts/telegram/verify/resend - 重新發送驗證碼
export async function PATCH(req: Request, { params }: RouteParams) {
  const { workspaceId } = await params;
  
  const auth = await requireWorkspacePermission(workspaceId, "canManageCommunicationAccounts");
  if (auth instanceof NextResponse) return auth;

  try {
    const body = await req.json();
    const { accountId } = body;

    if (!accountId) {
      return NextResponse.json(
        { error: "請提供帳號 ID" },
        { status: 400 }
      );
    }

    const account = await prisma.communicationAccount.findFirst({
      where: {
        id: accountId,
        workspaceId,
        platform: "telegram"
      }
    });

    if (!account) {
      return NextResponse.json(
        { error: "找不到此帳號" },
        { status: 404 }
      );
    }

    const resendResult = await TelegramAuthFlow.resendCode(accountId);

    if (!resendResult.success) {
      return NextResponse.json(
        { error: resendResult.error },
        { status: 400 }
      );
    }

    // 記錄重新發送
    await prisma.auditLog.create({
      data: {
        workspaceId,
        userId: auth.userId,
        action: "RESEND_TELEGRAM_CODE",
        entityType: "CommunicationAccount",
        entityId: accountId,
        details: {
          phoneNumber: account.phoneNumber
        }
      }
    });

    return NextResponse.json({
      success: true,
      codeSent: true,
      message: "已重新發送驗證碼"
    });

  } catch (error) {
    log.error("failed to resend verification code", { error: String(error) });
    return NextResponse.json(
      { error: "重新發送驗證碼失敗，請稍後再試" },
      { status: 500 }
    );
  }
}