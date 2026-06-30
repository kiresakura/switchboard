import { NextResponse } from "next/server";
import { getSession } from "./session";
import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";

const log = logger("Auth");

// ─── Permission Keys (maps to Role model boolean columns) ────

export type PermissionKey =
  | "canEditWorkspaceSettings"
  | "canManageCommunicationAccounts"
  | "canManageGroupRegistry"
  | "canManageRouting"
  | "canManageModerationRules"
  | "canManageRoles"
  | "canAssignMemberRoles"
  | "canModerateMessages"
  | "canSendManualMessages"
  | "canDirectMessage"
  | "canManagePostPermissions"
  | "canViewAllAuditLogs"
  | "canViewOwnAuditLogs"
  // ── 四層權限 (Backend-first 2026-05-21) ──
  /// 主管權限:看到所監督 Team 內所有帳號的對話。
  | "canSuperviseTeam"
  /// 主管臨時讓人接管自己的帳號(AccountDelegation)。
  | "canDelegateAccounts";

export const ALL_PERMISSIONS: PermissionKey[] = [
  "canEditWorkspaceSettings",
  "canManageCommunicationAccounts",
  "canManageGroupRegistry",
  "canManageRouting",
  "canManageModerationRules",
  "canManageRoles",
  "canAssignMemberRoles",
  "canModerateMessages",
  "canSendManualMessages",
  "canDirectMessage",
  "canManagePostPermissions",
  "canViewAllAuditLogs",
  "canViewOwnAuditLogs",
  "canSuperviseTeam",
  "canDelegateAccounts",
];

export type Permissions = Record<PermissionKey, boolean>;

// ─── Context Types ───────────────────────────────────────────

export type AuthContext = {
  userId: string;
  username: string;
  displayName: string;
  isSystemAdmin: boolean;
};

export type WorkspaceContext = AuthContext & {
  workspaceId: string;
  permissions: Permissions;
};

// ─── Helper: all permissions true ────────────────────────────

function allPermissions(): Permissions {
  const perms = {} as Permissions;
  for (const key of ALL_PERMISSIONS) {
    perms[key] = true;
  }
  return perms;
}

// ─── Helper: no permissions ──────────────────────────────────

function noPermissions(): Permissions {
  const perms = {} as Permissions;
  for (const key of ALL_PERMISSIONS) {
    perms[key] = false;
  }
  return perms;
}

// ─── Helper: union of role permissions ───────────────────────

function unionPermissions(
  roles: Array<Record<string, unknown>>
): Permissions {
  const perms = noPermissions();
  for (const role of roles) {
    for (const key of ALL_PERMISSIONS) {
      if (role[key] === true) {
        perms[key] = true;
      }
    }
  }
  return perms;
}

// ─── requireAuth ─────────────────────────────────────────────

export async function requireAuth(): Promise<AuthContext | NextResponse> {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "尚未登入" }, { status: 401 });
  }

  return {
    userId: session.user.id,
    username: session.user.username,
    displayName: session.user.displayName,
    isSystemAdmin: session.user.isSystemAdmin,
  };
}

// ─── requireSystemAdmin ──────────────────────────────────────

export async function requireSystemAdmin(): Promise<
  AuthContext | NextResponse
> {
  const auth = await requireAuth();
  if (auth instanceof NextResponse) return auth;

  if (!auth.isSystemAdmin) {
    return NextResponse.json({ error: "權限不足" }, { status: 403 });
  }

  return auth;
}

// ─── requireWorkspacePermission (v2 primary) ─────────────────

export async function requireWorkspacePermission(
  workspaceId: string,
  ...requiredPermissions: PermissionKey[]
): Promise<WorkspaceContext | NextResponse> {
  const auth = await requireAuth();
  if (auth instanceof NextResponse) return auth;

  // Block access to deactivated workspaces for everyone (including system admins)
  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { isActive: true },
  });
  if (!workspace) {
    return NextResponse.json({ error: "找不到工作區" }, { status: 404 });
  }
  if (!workspace.isActive) {
    return NextResponse.json({ error: "工作區已停用" }, { status: 403 });
  }

  // System admins bypass permission checks but we still log cross-workspace access
  if (auth.isSystemAdmin) {
    // Check if admin is actually a member (for audit awareness)
    const adminMembership = await prisma.workspaceMembership.findUnique({
      where: {
        userId_workspaceId: { userId: auth.userId, workspaceId },
      },
    });
    if (!adminMembership) {
      try {
        await prisma.auditLog.create({
          data: {
            action: "SYSTEM_ADMIN_CROSS_WORKSPACE_ACCESS",
            entityType: "Workspace",
            entityId: workspaceId,
            userId: auth.userId,
            workspaceId,
            details: JSON.stringify({ reason: "System admin accessing workspace without direct membership" }),
          },
        });
      } catch (auditError) {
        log.error("failed to log admin cross-workspace access", { error: String(auditError) });
      }
    }
    return {
      ...auth,
      workspaceId,
      permissions: allPermissions(),
    };
  }

  // Check workspace membership
  const membership = await prisma.workspaceMembership.findUnique({
    where: {
      userId_workspaceId: {
        userId: auth.userId,
        workspaceId,
      },
    },
  });

  if (!membership || !membership.isActive) {
    return NextResponse.json({ error: "權限不足" }, { status: 403 });
  }

  // Fetch all active roles for this user in this workspace
  const userRoles = await prisma.userRole.findMany({
    where: {
      userId: auth.userId,
      role: {
        workspaceId,
        isActive: true,
      },
    },
    include: { role: true },
  });

  // Calculate permission union across all roles
  const permissions = unionPermissions(userRoles.map((ur) => ur.role));

  // Check required permissions
  for (const perm of requiredPermissions) {
    if (!permissions[perm]) {
      return NextResponse.json({ error: "權限不足" }, { status: 403 });
    }
  }

  return {
    ...auth,
    workspaceId,
    permissions,
  };
}

// ─── requireWorkspaceMember (any member, no specific permission) ─

export async function requireWorkspaceMember(
  workspaceId: string
): Promise<WorkspaceContext | NextResponse> {
  return requireWorkspacePermission(workspaceId);
}
