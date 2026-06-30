/**
 * account-visibility — 四層權限的「我看得到哪些 TG 帳號」解析器。
 * (Backend-first 2026-05-21)
 *
 * 模型:
 *   1. 系統管理員 (User.isSystemAdmin)                — 全部帳號
 *   2. 主管 (canSuperviseTeam + Team.supervisorUserId) — 監督的 Team 內所有帳號
 *   3. 員工 (default)                                    — AccountAssignment 指派的帳號
 *   4. 代理人 (AccountDelegation,時效內)                — 暫時接管的帳號
 *
 * 「可見」= 任一條件成立。函式回傳 `Set<accountId>` 供 API 過濾用。
 *
 * 設計取捨:
 *   - 永遠回傳明確 set(包含 admin),而不是「null = 全部」— 呼叫端不必做特例。
 *   - 委派以「現在時間」判定有效:expiresAt > now AND startsAt <= now AND revokedAt = null。
 *   - 代理人視角下,toUser 取得的權限上限是 fromUser 當下的歸屬(只看到那個帳號,
 *     不會連帶看到 fromUser 的其他帳號 — 委派以帳號為單位,不是以人為單位)。
 */

import { prisma } from "@/lib/db";
import type { Permissions } from "@/lib/auth/middleware";

export type AccountVisibilityContext = {
  userId: string;
  workspaceId: string;
  isSystemAdmin: boolean;
  permissions: Permissions;
};

/**
 * 回傳此使用者在此 workspace 能看見的 CommunicationAccount.id 集合。
 *
 * 注意:此函式只回「可見性」交集 — 並不檢查 account.status (ACTIVE / DISCONNECTED…),
 * 那是業務層 (groups/conversations API) 自己決定要不要過濾的事。
 */
export async function resolveVisibleAccountIds(
  ctx: AccountVisibilityContext
): Promise<Set<string>> {
  const { userId, workspaceId, isSystemAdmin, permissions } = ctx;

  // (1) 系統管理員 / 工作區 admin (canManageCommunicationAccounts) — 全部
  // 把 canManageCommunicationAccounts 也視為「能看全部」,因為 v1 的工作區
  // admin 角色就是用這個 flag 代表「管帳號的人」;不放他全可見會看不到自己沒指派的帳號。
  if (isSystemAdmin || permissions.canManageCommunicationAccounts) {
    const accounts = await prisma.communicationAccount.findMany({
      where: { workspaceId },
      select: { id: true },
    });
    return new Set(accounts.map((a) => a.id));
  }

  const visible = new Set<string>();

  // (2) 主管 — 監督的 Team 內的帳號
  if (permissions.canSuperviseTeam) {
    const supervisedTeams = await prisma.team.findMany({
      where: {
        workspaceId,
        supervisorUserId: userId,
        isActive: true,
      },
      select: { id: true },
    });
    if (supervisedTeams.length > 0) {
      const supervisedAccounts = await prisma.communicationAccount.findMany({
        where: {
          workspaceId,
          teamId: { in: supervisedTeams.map((t) => t.id) },
        },
        select: { id: true },
      });
      for (const a of supervisedAccounts) visible.add(a.id);
    }
  }

  // (3) 員工 — AccountAssignment 指派的帳號
  const assignments = await prisma.accountAssignment.findMany({
    where: {
      userId,
      account: { workspaceId },
    },
    select: { accountId: true },
  });
  for (const a of assignments) visible.add(a.accountId);

  // (4) 代理人 — 時效內的 AccountDelegation
  const now = new Date();
  const delegations = await prisma.accountDelegation.findMany({
    where: {
      toUserId: userId,
      revokedAt: null,
      startsAt: { lte: now },
      expiresAt: { gt: now },
      account: { workspaceId },
    },
    select: { accountId: true },
  });
  for (const d of delegations) visible.add(d.accountId);

  return visible;
}

/**
 * 便利方法:某帳號是否在這個使用者的可見範圍內。
 * 設計給「單筆檢查」用 — 對大量檢查請改用 resolveVisibleAccountIds 一次拿回 set。
 */
export async function canSeeAccount(
  ctx: AccountVisibilityContext,
  accountId: string
): Promise<boolean> {
  const set = await resolveVisibleAccountIds(ctx);
  return set.has(accountId);
}
