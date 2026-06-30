import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireWorkspacePermission } from "@/lib/auth/middleware";
import { logAudit } from "@/lib/audit/logger";
import { TelegramAuthFlow } from "@/lib/telegram/auth-flow";

type RouteParams = {
  params: Promise<{ workspaceId: string; accountId: string }>;
};

// POST /api/workspaces/:id/accounts/:aid/auth
// Step 1: Send verification code
export async function POST(req: Request, { params }: RouteParams) {
  const { workspaceId, accountId } = await params;
  const auth = await requireWorkspacePermission(workspaceId, "canManageCommunicationAccounts");
  if (auth instanceof NextResponse) return auth;

  const { phoneNumber, apiId, apiHash, action, pendingAuthId, code, password } =
    await req.json();

  // Step 2: Verify code
  if (action === "verify") {
    if (!pendingAuthId || !code) {
      return NextResponse.json(
        { error: "請提供認證 ID 和驗證碼" },
        { status: 400 }
      );
    }

    // IDOR guard: pendingAuthId must match the URL accountId. An attacker with
    // workspace-admin rights in workspace B could otherwise pass another
    // workspace's in-progress auth as pendingAuthId and leak/hijack state.
    if (pendingAuthId !== accountId) {
      return NextResponse.json(
        { error: "認證 ID 與帳號不符" },
        { status: 400 }
      );
    }

    // Also verify the account actually belongs to THIS workspace before doing
    // any cross-boundary writes (communicationAccount.update below).
    const verifyAccount = await prisma.communicationAccount.findFirst({
      where: { id: accountId, workspaceId },
      select: { id: true },
    });
    if (!verifyAccount) {
      return NextResponse.json(
        { error: "找不到此帳號" },
        { status: 404 }
      );
    }

    const verifyResult = await TelegramAuthFlow.verifyCode(pendingAuthId, code, password);

    if (verifyResult.passwordRequired) {
      return NextResponse.json({
        success: false,
        needs2FA: true,
        pendingAuthId,
      });
    }

    if (verifyResult.needsNewCode) {
      return NextResponse.json(
        { error: verifyResult.error || "驗證碼已過期，請重新發送" },
        { status: 400 }
      );
    }

    if (!verifyResult.success) {
      return NextResponse.json(
        { error: verifyResult.error || "驗證失敗" },
        { status: 400 }
      );
    }

    // Update account status to ACTIVE
    await prisma.communicationAccount.update({
      where: { id: accountId },
      data: {
        status: "ACTIVE",
        telegramUserId: verifyResult.userId,
      },
    });

    await logAudit({
      workspaceId,
      userId: auth.userId,
      action: "account.auth_complete",
      entityType: "CommunicationAccount",
      entityId: accountId,
    });

    // Notify bridge to connect the new account immediately (no restart needed)
    const bridgeUrl = process.env.BRIDGE_URL || `http://localhost:${process.env.BRIDGE_PORT || 3001}`;
    const internalSecret = process.env.INTERNAL_SECRET;
    fetch(`${bridgeUrl}/reconnect`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${internalSecret}`,
      },
      body: JSON.stringify({ accountId }),
      signal: AbortSignal.timeout(5000),
    }).catch(() => {
      // Non-fatal: bridge will pick up on next periodic scan or restart
    });

    return NextResponse.json({ success: true, status: "ACTIVE" });
  }

  // Step 1: Send code
  if (!phoneNumber) {
    return NextResponse.json(
      { error: "請輸入電話號碼" },
      { status: 400 }
    );
  }

  // Verify account belongs to workspace
  const account = await prisma.communicationAccount.findFirst({
    where: { id: accountId, workspaceId },
  });

  if (!account) {
    return NextResponse.json(
      { error: "找不到此帳號" },
      { status: 404 }
    );
  }

  // Normalise per-account Telegram credentials (as of 2026-04-14 meeting,
  // each Telegram account should own its my.telegram.org app; env creds
  // are legacy fallback only).
  const parsedApiId =
    apiId !== undefined && apiId !== null && `${apiId}`.trim() !== ""
      ? parseInt(`${apiId}`, 10)
      : undefined;
  const normalisedApiHash =
    typeof apiHash === "string" && apiHash.trim() !== "" ? apiHash.trim() : undefined;

  if ((parsedApiId !== undefined) !== (normalisedApiHash !== undefined)) {
    return NextResponse.json(
      { error: "請同時填寫 API ID 與 API Hash,或兩者都留空" },
      { status: 400 }
    );
  }
  if (parsedApiId !== undefined && (!Number.isFinite(parsedApiId) || parsedApiId <= 0)) {
    return NextResponse.json(
      { error: "API ID 必須為正整數" },
      { status: 400 }
    );
  }
  if (normalisedApiHash !== undefined && !/^[a-f0-9]{32}$/i.test(normalisedApiHash)) {
    return NextResponse.json(
      { error: "API Hash 必須為 32 個十六進位字符" },
      { status: 400 }
    );
  }

  try {
    const result = await TelegramAuthFlow.initializeAuth(
      accountId,
      phoneNumber,
      parsedApiId,
      normalisedApiHash
    );

    // Update phone number
    await prisma.communicationAccount.update({
      where: { id: accountId },
      data: { phoneNumber },
    });

    await logAudit({
      workspaceId,
      userId: auth.userId,
      action: "account.auth_start",
      entityType: "CommunicationAccount",
      entityId: accountId,
    });

    if (!result.codeSent) {
      return NextResponse.json(
        { error: result.error || "發送驗證碼失敗" },
        { status: 500 }
      );
    }

    return NextResponse.json({
      pendingAuthId: accountId,
      mockMode: result.mockMode || false,
      message: "驗證碼已發送",
    });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "發送驗證碼失敗，請稍後再試",
      },
      { status: 500 }
    );
  }
}
