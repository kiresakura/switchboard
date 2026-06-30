import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireWorkspacePermission } from "@/lib/auth/middleware";
import { logAudit } from "@/lib/audit/logger";

type RouteParams = { params: Promise<{ workspaceId: string }> };

// 清除超過 5 分鐘仍 PENDING_AUTH 的帳號（使用者放棄/失敗）。
// 5 分鐘是 Telegram 驗證碼的有效期上限參考；超過代表流程不可能還在進行中。
// 配合 POST 的 takeover 邏輯（見下），就算 cutoff 沒到、使用者重試同一支電話，
// 也不會撞到「明明列表沒有但加不進去」的 ghost row 問題。
const STALE_PENDING_AUTH_MS = 5 * 60 * 1000;

async function cleanupStalePendingAuth(workspaceId: string) {
  const cutoff = new Date(Date.now() - STALE_PENDING_AUTH_MS);
  // 同步刪掉對應的 PendingAuthSession（沒 FK 級聯）
  const stale = await prisma.communicationAccount.findMany({
    where: {
      workspaceId,
      status: "PENDING_AUTH",
      createdAt: { lt: cutoff },
    },
    select: { id: true },
  });
  if (stale.length === 0) return;
  const ids = stale.map((a) => a.id);
  await prisma.$transaction([
    prisma.pendingAuthSession.deleteMany({ where: { accountId: { in: ids } } }),
    prisma.communicationAccount.deleteMany({ where: { id: { in: ids } } }),
  ]);
}

// GET /api/workspaces/:id/accounts
// 預設只回傳已完成認證/可運作的帳號；加 ?includePending=true 才會包含 PENDING_AUTH
export async function GET(req: Request, { params }: RouteParams) {
  const { workspaceId } = await params;
  const auth = await requireWorkspacePermission(workspaceId, "canManageCommunicationAccounts");
  if (auth instanceof NextResponse) return auth;

  // 機會性清理：過期未完成的註冊帳號
  await cleanupStalePendingAuth(workspaceId);

  const url = new URL(req.url);
  const includePending = url.searchParams.get("includePending") === "true";

  const accounts = await prisma.communicationAccount.findMany({
    where: {
      workspaceId,
      ...(includePending ? {} : { status: { not: "PENDING_AUTH" } }),
    },
    select: {
      id: true,
      workspaceId: true,
      platform: true,
      displayName: true,
      phoneNumber: true,
      telegramUserId: true,
      telegramFirstName: true,
      telegramLastName: true,
      telegramUsername: true,
      status: true,
      createdAt: true,
      updatedAt: true,
      _count: { select: { groupMemberships: true } },
    },
    orderBy: { createdAt: "asc" },
  });

  return NextResponse.json({ accounts });
}

// POST /api/workspaces/:id/accounts
export async function POST(req: Request, { params }: RouteParams) {
  const { workspaceId } = await params;
  const auth = await requireWorkspacePermission(workspaceId, "canManageCommunicationAccounts");
  if (auth instanceof NextResponse) return auth;

  let body: { displayName?: string; phoneNumber?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "無效的請求內容" }, { status: 400 });
  }
  const { displayName, phoneNumber } = body;

  // displayName 改為可選（自訂暱稱）；驗證完成後 UI 會 fallback 使用 telegramFirstName/LastName
  const cleanDisplayName = displayName?.trim() || null;

  // Check for duplicate phone number in this workspace.
  //
  // Special case: if the conflicting row is a PENDING_AUTH ghost (no session,
  // no messages, no DCM, no group memberships, no forwards), the user clearly
  // wants to retry with the same phone after a previous attempt failed.
  // Take it over instead of forcing the user to find & delete it manually —
  // PENDING_AUTH rows are also hidden from the GET listing, so the ghost is
  // invisible to the user and can't be deleted via the UI anyway.
  if (phoneNumber) {
    const existing = await prisma.communicationAccount.findFirst({
      where: { workspaceId, phoneNumber },
      include: {
        telegramSession: { select: { id: true } },
        _count: {
          select: {
            directChatMessages: true,
            groupMemberships: true,
          },
        },
      },
    });
    if (existing) {
      // (Broker _count.messages / _count.forwards dropped in H4.)
      const isGhost =
        existing.status === "PENDING_AUTH" &&
        !existing.telegramSession &&
        existing._count.directChatMessages === 0 &&
        existing._count.groupMemberships === 0;
      if (isGhost) {
        await prisma.$transaction([
          prisma.pendingAuthSession.deleteMany({ where: { accountId: existing.id } }),
          prisma.communicationAccount.delete({ where: { id: existing.id } }),
        ]);
        await logAudit({
          workspaceId,
          userId: auth.userId,
          action: "account.ghost_takeover",
          entityType: "CommunicationAccount",
          entityId: existing.id,
          details: { phoneNumber, replacedBy: "new account in same request" },
        });
      } else {
        const existingLabel =
          existing.displayName ||
          [existing.telegramFirstName, existing.telegramLastName]
            .filter(Boolean)
            .join(" ") ||
          existing.phoneNumber ||
          "(未命名)";
        return NextResponse.json(
          { error: `此手機號碼已被帳號「${existingLabel}」使用` },
          { status: 409 }
        );
      }
    }
  }

  try {
    const account = await prisma.communicationAccount.create({
      data: {
        workspaceId,
        displayName: cleanDisplayName,
        phoneNumber,
      },
    });

    await logAudit({
      workspaceId,
      userId: auth.userId,
      action: "account.create",
      entityType: "CommunicationAccount",
      entityId: account.id,
      details: { displayName, phoneNumber },
    });

    return NextResponse.json({ account }, { status: 201 });
  } catch (error: unknown) {
    // Handle unique constraint violation (TOCTOU race safety net)
    const code =
      error && typeof error === "object" && "code" in error
        ? (error as { code?: unknown }).code
        : undefined;
    if (code === "P2002") {
      return NextResponse.json(
        { error: "此手機號碼已在此工作區中使用" },
        { status: 409 }
      );
    }
    throw error;
  }
}
