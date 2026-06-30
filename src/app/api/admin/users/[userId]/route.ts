import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireSystemAdmin } from "@/lib/auth/middleware";
import { hashPassword } from "@/lib/auth/passwords";
import { logAudit } from "@/lib/audit/logger";
import { deleteAllUserSessions } from "@/lib/auth/session";

type RouteParams = { params: Promise<{ userId: string }> };

// GET /api/admin/users/:userId
export async function GET(_request: Request, { params }: RouteParams) {
  const auth = await requireSystemAdmin();
  if (auth instanceof NextResponse) return auth;

  const { userId } = await params;

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      username: true,
      displayName: true,
      isSystemAdmin: true,
      isActive: true,
      lastActiveAt: true,
      createdAt: true,
      updatedAt: true,
      memberships: {
        select: {
          id: true,
          workspaceId: true,
          isActive: true,
          workspace: { select: { id: true, name: true, slug: true } },
        },
      },
      userRoles: {
        select: {
          id: true,
          role: {
            select: { id: true, name: true, workspaceId: true },
          },
        },
      },
    },
  });

  if (!user) {
    return NextResponse.json({ error: "找不到使用者" }, { status: 404 });
  }

  return NextResponse.json({ user });
}

// PATCH /api/admin/users/:userId
export async function PATCH(request: Request, { params }: RouteParams) {
  const auth = await requireSystemAdmin();
  if (auth instanceof NextResponse) return auth;

  const { userId } = await params;

  let body: {
    displayName?: string;
    isActive?: boolean;
    isSystemAdmin?: boolean;
    password?: string;
    /**
     * 若提供（即使為空陣列），server 會把 user 的工作空間指派改成這份清單：
     *   - 已在清單中的：membership 設 isActive=true、UserRole 替換成清單裡的 roleIds
     *   - 不在清單中的：membership 設 isActive=false、清掉對應的 UserRole
     * 不提供（undefined）→ 完全不動 memberships（讓「只改顯示名」這類局部更新保持原狀）
     */
    workspaceAssignments?: Array<{ workspaceId: string; roleIds?: string[] }>;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "無效的請求內容" },
      { status: 400 }
    );
  }

  const { displayName, isActive, isSystemAdmin, password, workspaceAssignments } = body;

  // Fetch the target user
  const targetUser = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      displayName: true,
      isSystemAdmin: true,
      isActive: true,
    },
  });

  if (!targetUser) {
    return NextResponse.json({ error: "找不到使用者" }, { status: 404 });
  }

  // Prevent self-demotion of isSystemAdmin
  if (isSystemAdmin !== undefined && userId === auth.userId) {
    return NextResponse.json(
      { error: "無法變更自己的管理員狀態，請由其他管理員操作" },
      { status: 400 }
    );
  }

  // Guard: cannot demote the last system admin
  if (isSystemAdmin === false && targetUser.isSystemAdmin) {
    const otherAdminCount = await prisma.user.count({
      where: {
        isSystemAdmin: true,
        isActive: true,
        id: { not: userId },
      },
    });
    if (otherAdminCount === 0) {
      return NextResponse.json(
        { error: "無法取消最後一位系統管理員的權限" },
        { status: 400 }
      );
    }
  }

  // Guard: cannot deactivate the last system admin
  if (isActive === false && targetUser.isSystemAdmin) {
    const otherAdminCount = await prisma.user.count({
      where: {
        isSystemAdmin: true,
        isActive: true,
        id: { not: userId },
      },
    });
    if (otherAdminCount === 0) {
      return NextResponse.json(
        { error: "無法停用最後一位系統管理員" },
        { status: 400 }
      );
    }
  }

  // Validate displayName if provided (symmetric with POST /admin/users)
  if (displayName !== undefined) {
    if (
      typeof displayName !== "string" ||
      displayName.trim().length === 0 ||
      displayName.length > 100
    ) {
      return NextResponse.json(
        { error: "顯示名稱長度須介於 1 至 100 字元" },
        { status: 400 }
      );
    }
  }

  // Validate workspaceAssignments shape (mirror POST /admin/users)
  if (workspaceAssignments !== undefined) {
    if (!Array.isArray(workspaceAssignments)) {
      return NextResponse.json(
        { error: "workspaceAssignments 必須為陣列" },
        { status: 400 }
      );
    }
    const seen = new Set<string>();
    for (const a of workspaceAssignments) {
      if (!a || typeof a !== "object" || typeof a.workspaceId !== "string" || !a.workspaceId) {
        return NextResponse.json(
          { error: "每個 workspaceAssignment 必須含有 workspaceId" },
          { status: 400 }
        );
      }
      if (seen.has(a.workspaceId)) {
        return NextResponse.json(
          { error: "工作空間不可重複指派" },
          { status: 400 }
        );
      }
      seen.add(a.workspaceId);
      if (a.roleIds !== undefined) {
        if (!Array.isArray(a.roleIds) || a.roleIds.some((r) => typeof r !== "string" || !r)) {
          return NextResponse.json(
            { error: "roleIds 必須為非空字串陣列" },
            { status: 400 }
          );
        }
      }
    }

    // 預先檢查 referenced workspaces / roles 存在且關聯正確
    const wsIds = Array.from(seen);
    if (wsIds.length > 0) {
      const wsRows = await prisma.workspace.findMany({
        where: { id: { in: wsIds } },
        select: { id: true },
      });
      const existingWs = new Set(wsRows.map((w) => w.id));
      for (const wsId of wsIds) {
        if (!existingWs.has(wsId)) {
          return NextResponse.json(
            { error: `找不到工作區：${wsId}` },
            { status: 400 }
          );
        }
      }
      const allRoleIds = Array.from(
        new Set(workspaceAssignments.flatMap((a) => a.roleIds ?? []))
      );
      if (allRoleIds.length > 0) {
        const roles = await prisma.role.findMany({
          where: { id: { in: allRoleIds } },
          select: { id: true, workspaceId: true },
        });
        const roleMap = new Map(roles.map((r) => [r.id, r.workspaceId] as const));
        for (const a of workspaceAssignments) {
          for (const roleId of a.roleIds ?? []) {
            const roleWs = roleMap.get(roleId);
            if (!roleWs) {
              return NextResponse.json(
                { error: `找不到身份組：${roleId}` },
                { status: 400 }
              );
            }
            if (roleWs !== a.workspaceId) {
              return NextResponse.json(
                { error: `身份組 ${roleId} 不屬於工作區 ${a.workspaceId}` },
                { status: 400 }
              );
            }
          }
        }
      }
    }
  }

  // Validate password if provided
  if (password !== undefined) {
    if (
      typeof password !== "string" ||
      password.length < 8 ||
      password.length > 200
    ) {
      return NextResponse.json(
        { error: "密碼長度須介於 8 至 200 字元" },
        { status: 400 }
      );
    }
  }

  // Build update data + track which fields changed
  const updateData: Record<string, unknown> = {};
  const changedFields: Record<string, { from: unknown; to: unknown }> = {};

  if (displayName !== undefined && displayName !== targetUser.displayName) {
    updateData.displayName = displayName;
    changedFields.displayName = {
      from: targetUser.displayName,
      to: displayName,
    };
  }

  if (isActive !== undefined && isActive !== targetUser.isActive) {
    updateData.isActive = isActive;
    changedFields.isActive = { from: targetUser.isActive, to: isActive };
  }

  if (
    isSystemAdmin !== undefined &&
    isSystemAdmin !== targetUser.isSystemAdmin
  ) {
    updateData.isSystemAdmin = isSystemAdmin;
    changedFields.isSystemAdmin = {
      from: targetUser.isSystemAdmin,
      to: isSystemAdmin,
    };
  }

  if (password !== undefined) {
    updateData.passwordHash = await hashPassword(password);
    changedFields.passwordReset = { from: "***", to: "***" };
  }

  // 「沒有需要更新的欄位」judgment 也要把 workspaceAssignments 算進去
  if (Object.keys(updateData).length === 0 && workspaceAssignments === undefined) {
    return NextResponse.json(
      { error: "沒有需要更新的欄位" },
      { status: 400 }
    );
  }

  const updatedUser = await prisma.$transaction(async (tx) => {
    if (Object.keys(updateData).length > 0) {
      await tx.user.update({ where: { id: userId }, data: updateData });
    }

    if (workspaceAssignments !== undefined) {
      // 取現有 memberships (包含 isActive=false 的)
      const currentMemberships = await tx.workspaceMembership.findMany({
        where: { userId },
        select: { id: true, workspaceId: true, isActive: true },
      });
      const currentByWs = new Map(
        currentMemberships.map((m) => [m.workspaceId, m] as const),
      );
      const targetWsIds = new Set(workspaceAssignments.map((a) => a.workspaceId));

      // 1. 不在清單中 → 軟停用 (isActive=false) + 刪掉該 workspace 的 UserRole
      for (const m of currentMemberships) {
        if (targetWsIds.has(m.workspaceId)) continue;
        if (m.isActive) {
          await tx.workspaceMembership.update({
            where: { id: m.id },
            data: { isActive: false },
          });
        }
        // 移除此 workspace 的 UserRole（無論 membership 原本啟不啟用）
        await tx.userRole.deleteMany({
          where: { userId, role: { workspaceId: m.workspaceId } },
        });
      }

      // 2. 在清單中 → ensure membership（建或啟用）+ 替換 UserRole
      for (const a of workspaceAssignments) {
        const existing = currentByWs.get(a.workspaceId);
        if (!existing) {
          await tx.workspaceMembership.create({
            data: { userId, workspaceId: a.workspaceId },
          });
        } else if (!existing.isActive) {
          await tx.workspaceMembership.update({
            where: { id: existing.id },
            data: { isActive: true },
          });
        }
        // 把該 workspace 的 UserRole 換成新清單
        await tx.userRole.deleteMany({
          where: { userId, role: { workspaceId: a.workspaceId } },
        });
        for (const roleId of a.roleIds ?? []) {
          await tx.userRole.create({ data: { userId, roleId } });
        }
      }
    }

    return tx.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        username: true,
        displayName: true,
        isSystemAdmin: true,
        isActive: true,
        createdAt: true,
        updatedAt: true,
      },
    });
  });

  // If user was deactivated, force logout by deleting all sessions.
  // (Review queue lock-release dropped in H4 — no review queue any more.)
  if (isActive === false && targetUser.isActive) {
    await deleteAllUserSessions(userId);
  }

  // Audit log
  try {
    const membership = await prisma.workspaceMembership.findFirst({
      where: { userId: auth.userId, isActive: true },
      select: { workspaceId: true },
    });
    if (membership) {
      await logAudit({
        workspaceId: membership.workspaceId,
        userId: auth.userId,
        action: "user.updated",
        entityType: "User",
        entityId: userId,
        details: {
          changedFields,
          ...(workspaceAssignments !== undefined && {
            workspaceAssignmentsCount: workspaceAssignments.length,
          }),
        },
        ipAddress:
          request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
          undefined,
      });
    }
  } catch {
    // never block response on audit failure
  }

  return NextResponse.json({ user: updatedUser });
}
