import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireWorkspacePermission } from "@/lib/auth/middleware";
import { TelegramAuthFlow } from "@/lib/telegram/auth-flow";
import { logger } from "@/lib/logger";
import { validatePhone } from "@/lib/validation/phone";

const log = logger("TelegramRegister");

type RouteParams = { params: Promise<{ workspaceId: string }> };

// POST /api/workspaces/:id/accounts/telegram/register
export async function POST(req: Request, { params }: RouteParams) {
  const { workspaceId } = await params;

  // 需要管理 Telegram 帳號的權限
  const auth = await requireWorkspacePermission(workspaceId, "canManageCommunicationAccounts");
  if (auth instanceof NextResponse) return auth;

  try {
    const body = await req.json();
    const { phoneNumber: rawPhone, displayName } = body;

    if (!rawPhone) {
      return NextResponse.json(
        { error: "請填寫電話號碼" },
        { status: 400 }
      );
    }

    // 後端二次驗證：UI 端會送 E.164，但別人可能直接呼叫 API。確保進
    // DB 的號碼一律是 +<country><number> 格式，方便後續查重 + bridge 認證。
    const phoneCheck = validatePhone(rawPhone);
    if (!phoneCheck.ok) {
      return NextResponse.json({ error: phoneCheck.error }, { status: 400 });
    }
    const phoneNumber = phoneCheck.e164;

    // displayName 為可選自訂暱稱；空白時 UI 會 fallback 使用 telegramFirstName/LastName
    const cleanDisplayName: string | null = displayName?.trim() || null;

    // 檢查電話號碼是否已存在
    const existingAccount = await prisma.communicationAccount.findFirst({
      where: {
        workspaceId,
        phoneNumber,
        platform: "telegram"
      }
    });

    // 如果已存在且非 PENDING_AUTH（已完成驗證），拒絕重複註冊
    if (existingAccount && existingAccount.status !== "PENDING_AUTH") {
      const existingLabel =
        existingAccount.displayName ||
        [existingAccount.telegramFirstName, existingAccount.telegramLastName]
          .filter(Boolean)
          .join(" ") ||
        existingAccount.phoneNumber ||
        "(未命名)";
      return NextResponse.json(
        { error: `此電話號碼已被帳號「${existingLabel}」使用` },
        { status: 409 }
      );
    }

    // 重用現有 PENDING_AUTH 記錄或建立新的
    const account = existingAccount
      ? await prisma.communicationAccount.update({
          where: { id: existingAccount.id },
          data: {
            displayName: cleanDisplayName, // 允許更新自訂暱稱（可為 null）
            status: "PENDING_AUTH",
            updatedAt: new Date(),
          },
        })
      : await prisma.communicationAccount.create({
          data: {
            workspaceId,
            platform: "telegram",
            displayName: cleanDisplayName,
            phoneNumber,
            status: "PENDING_AUTH"
          }
        });

    // 初始化認證流程
    const authResult = await TelegramAuthFlow.initializeAuth(account.id, phoneNumber);

    // 記錄操作
    await prisma.auditLog.create({
      data: {
        workspaceId,
        userId: auth.userId,
        action: "REGISTER_TELEGRAM_ACCOUNT",
        entityType: "CommunicationAccount",
        entityId: account.id,
        details: {
          phoneNumber,
          displayName,
          authRequired: authResult.authRequired
        }
      }
    });

    return NextResponse.json({
      accountId: account.id,
      authRequired: authResult.authRequired,
      codeSent: authResult.codeSent,
      mockMode: authResult.mockMode || false,
      message: authResult.authRequired
        ? "驗證碼已發送到您的手機"
        : "帳號註冊成功"
    });

  } catch (error) {
    log.error("failed to register Telegram account", { error: String(error) });
    return NextResponse.json(
      { error: "帳號註冊失敗，請稍後再試" },
      { status: 500 }
    );
  }
}

// GET /api/workspaces/:id/accounts/telegram/register - 獲取註冊狀態
export async function GET(req: Request, { params }: RouteParams) {
  const { workspaceId } = await params;
  const auth = await requireWorkspacePermission(workspaceId, "canManageCommunicationAccounts");
  if (auth instanceof NextResponse) return auth;

  const url = new URL(req.url);
  const accountId = url.searchParams.get('accountId');

  if (!accountId) {
    return NextResponse.json(
      { error: "請提供帳號 ID" },
      { status: 400 }
    );
  }

  try {
    const account = await prisma.communicationAccount.findFirst({
      where: {
        id: accountId,
        workspaceId,
        platform: "telegram"
      },
      include: {
        telegramSession: true
      }
    });

    if (!account) {
      return NextResponse.json(
        { error: "找不到此帳號" },
        { status: 404 }
      );
    }

    const authStatus = await TelegramAuthFlow.getAuthStatus(accountId);

    return NextResponse.json({
      accountId: account.id,
      displayName: account.displayName,
      phoneNumber: account.phoneNumber,
      status: account.status,
      authStatus: authStatus,
      hasSession: !!account.telegramSession
    });

  } catch (error) {
    log.error("failed to get registration status", { error: String(error) });
    return NextResponse.json(
      { error: "無法取得註冊狀態" },
      { status: 500 }
    );
  }
}