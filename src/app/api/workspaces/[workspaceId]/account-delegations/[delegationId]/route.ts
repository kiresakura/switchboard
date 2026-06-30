import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireWorkspacePermission } from "@/lib/auth/middleware";
import { logAudit } from "@/lib/audit/logger";

type RouteParams = {
  params: Promise<{ workspaceId: string; delegationId: string }>;
};

/**
 * DELETE /api/workspaces/:ws/account-delegations/:id
 *
 * 「撤銷」一筆委派(soft revoke,寫 revokedAt = now)。
 * 不真的 DELETE row — 保留稽核軌跡;account-visibility 已用 revokedAt = null
 * 過濾,設定後立刻失效。可以由 grantedBy 本人 / admin / 有 canDelegateAccounts
 * 的人撤銷(避免 grantedBy 離職 / 休假時其他主管無法收回)。
 */
export async function DELETE(_req: Request, { params }: RouteParams) {
  const { workspaceId, delegationId } = await params;
  const auth = await requireWorkspacePermission(workspaceId, "canDelegateAccounts");
  if (auth instanceof NextResponse) return auth;

  const delegation = await prisma.accountDelegation.findFirst({
    where: {
      id: delegationId,
      account: { workspaceId },
    },
  });
  if (!delegation) {
    return NextResponse.json({ error: "找不到委派紀錄" }, { status: 404 });
  }
  if (delegation.revokedAt) {
    return NextResponse.json({ error: "此委派已撤銷" }, { status: 409 });
  }

  const revoked = await prisma.accountDelegation.update({
    where: { id: delegationId },
    data: { revokedAt: new Date() },
  });

  await logAudit({
    workspaceId,
    userId: auth.userId,
    action: "account_delegation.revoke",
    entityType: "AccountDelegation",
    entityId: delegationId,
    details: {
      accountId: delegation.accountId,
      toUserId: delegation.toUserId,
      originalExpiresAt: delegation.expiresAt.toISOString(),
      revokedAt: revoked.revokedAt!.toISOString(),
    },
  });

  return NextResponse.json({ success: true, delegation: revoked });
}
