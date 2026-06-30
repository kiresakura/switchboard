import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireWorkspacePermission } from "@/lib/auth/middleware";
import { logAudit } from "@/lib/audit/logger";
import { logger } from "@/lib/logger";

const log = logger("AccountDelegation");

type RouteParams = { params: Promise<{ workspaceId: string }> };

/**
 * 帳號代理人 — 主管(canDelegateAccounts)讓另一名使用者「時效內」接管自己歸屬的 TG 帳號。
 *
 * 設計重點:
 *   - 時效 = [startsAt, expiresAt];expiresAt 必填,到期後自動失效(account-visibility
 *     已用 expiresAt > now 過濾,不需 cron 也能正確收尾)。
 *   - revokedAt 提前撤銷(grantedBy 才能撤);保留紀錄供稽核。
 *   - 不直接刪除 row,避免「我以為撤銷了但其實沒有」這種失誤難回溯。
 *
 * GET   /api/workspaces/:ws/account-delegations         — 列出 (active=true 只看有效的)
 * POST  /api/workspaces/:ws/account-delegations          — 建立 (簽核者 = grantedBy = 自己)
 * (撤銷 / 刪除走 /[id] 的 DELETE,未寫在此檔)
 */

export async function GET(req: Request, { params }: RouteParams) {
  const { workspaceId } = await params;
  const auth = await requireWorkspacePermission(workspaceId);
  if (auth instanceof NextResponse) return auth;

  const url = new URL(req.url);
  const activeOnly = url.searchParams.get("active") === "true";

  const now = new Date();
  const delegations = await prisma.accountDelegation.findMany({
    where: {
      account: { workspaceId },
      ...(activeOnly
        ? {
            revokedAt: null,
            startsAt: { lte: now },
            expiresAt: { gt: now },
          }
        : {}),
    },
    orderBy: { createdAt: "desc" },
    include: {
      account: { select: { id: true, displayName: true, telegramFirstName: true } },
      fromUser: { select: { id: true, displayName: true, username: true } },
      toUser: { select: { id: true, displayName: true, username: true } },
      grantedBy: { select: { id: true, displayName: true, username: true } },
    },
  });

  return NextResponse.json({
    delegations: delegations.map((d) => ({
      id: d.id,
      accountId: d.accountId,
      account: {
        id: d.account.id,
        name: d.account.displayName ?? d.account.telegramFirstName ?? "(未命名)",
      },
      fromUserId: d.fromUserId,
      fromUser: d.fromUser,
      toUserId: d.toUserId,
      toUser: d.toUser,
      grantedById: d.grantedById,
      grantedBy: d.grantedBy,
      reason: d.reason,
      startsAt: d.startsAt.toISOString(),
      expiresAt: d.expiresAt.toISOString(),
      revokedAt: d.revokedAt?.toISOString() ?? null,
      createdAt: d.createdAt.toISOString(),
      isActive:
        d.revokedAt == null &&
        d.startsAt.getTime() <= now.getTime() &&
        d.expiresAt.getTime() > now.getTime(),
    })),
  });
}

export async function POST(req: Request, { params }: RouteParams) {
  const { workspaceId } = await params;
  // 必須有 canDelegateAccounts 才能建立委派;admin 自動 bypass。
  const auth = await requireWorkspacePermission(workspaceId, "canDelegateAccounts");
  if (auth instanceof NextResponse) return auth;

  let body: {
    accountId?: string;
    toUserId?: string;
    /** 委派起始;省略 = 立即生效(now)。 */
    startsAt?: string;
    /** 委派截止 ISO 字串,必填且必須在 startsAt 之後。 */
    expiresAt?: string;
    /** 簡述原因(自由文字,稽核用)。 */
    reason?: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "無效的請求內容" }, { status: 400 });
  }

  const { accountId, toUserId, reason } = body;
  if (!accountId || !toUserId) {
    return NextResponse.json(
      { error: "accountId, toUserId 為必填" },
      { status: 400 }
    );
  }

  // 解析時間區間
  const startsAt = body.startsAt ? new Date(body.startsAt) : new Date();
  const expiresAt = body.expiresAt ? new Date(body.expiresAt) : null;
  if (!expiresAt || Number.isNaN(expiresAt.getTime())) {
    return NextResponse.json({ error: "expiresAt 為必填且需為合法 ISO 時間" }, { status: 400 });
  }
  if (expiresAt.getTime() <= startsAt.getTime()) {
    return NextResponse.json({ error: "expiresAt 必須在 startsAt 之後" }, { status: 400 });
  }
  if (expiresAt.getTime() <= Date.now()) {
    return NextResponse.json({ error: "expiresAt 必須在未來" }, { status: 400 });
  }

  // 驗證帳號屬於此 workspace + 找出 fromUser(帳號目前的 primary assignment)
  const account = await prisma.communicationAccount.findFirst({
    where: { id: accountId, workspaceId },
    include: {
      assignments: {
        where: { isPrimary: true },
        select: { userId: true },
        take: 1,
      },
    },
  });
  if (!account) {
    return NextResponse.json({ error: "找不到帳號" }, { status: 404 });
  }

  // fromUser 預設 = primary assignment(若無則 = 自己作為簽核者也是名義上的 fromUser,
  // admin 直接委派工作區帳號時這是合理的)。
  const fromUserId = account.assignments[0]?.userId ?? auth.userId;

  // 驗證 toUser 是同 workspace 的 active member
  const toMembership = await prisma.workspaceMembership.findUnique({
    where: { userId_workspaceId: { userId: toUserId, workspaceId } },
  });
  if (!toMembership || !toMembership.isActive) {
    return NextResponse.json({ error: "接管人不是此工作區的成員" }, { status: 404 });
  }
  if (toUserId === fromUserId) {
    return NextResponse.json({ error: "不能委派給自己" }, { status: 400 });
  }

  const delegation = await prisma.accountDelegation.create({
    data: {
      accountId,
      fromUserId,
      toUserId,
      grantedById: auth.userId,
      reason: reason ?? null,
      startsAt,
      expiresAt,
    },
  });

  await logAudit({
    workspaceId,
    userId: auth.userId,
    action: "account_delegation.create",
    entityType: "AccountDelegation",
    entityId: delegation.id,
    details: {
      accountId,
      fromUserId,
      toUserId,
      startsAt: startsAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
      reason: reason ?? null,
    },
  });

  log.info("delegation created", {
    workspaceId,
    accountId,
    fromUserId,
    toUserId,
    grantedById: auth.userId,
  });

  return NextResponse.json({ success: true, delegation });
}
