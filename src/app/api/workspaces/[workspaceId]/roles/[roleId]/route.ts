import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireWorkspacePermission, ALL_PERMISSIONS } from "@/lib/auth/middleware";
import { logAudit } from "@/lib/audit/logger";

type RouteParams = { params: Promise<{ workspaceId: string; roleId: string }> };

// GET /api/workspaces/:id/roles/:roleId
export async function GET(_req: Request, { params }: RouteParams) {
  const { workspaceId, roleId } = await params;
  const auth = await requireWorkspacePermission(workspaceId, "canManageRoles");
  if (auth instanceof NextResponse) return auth;

  const role = await prisma.role.findFirst({
    where: { id: roleId, workspaceId, isActive: true },
    include: {
      userRoles: {
        include: {
          user: {
            select: {
              id: true,
              username: true,
              displayName: true,
              isActive: true,
            },
          },
        },
      },
      _count: { select: { userRoles: true } },
    },
  });

  if (!role) {
    return NextResponse.json({ error: "找不到身份組" }, { status: 404 });
  }

  return NextResponse.json({ role });
}

// PATCH /api/workspaces/:id/roles/:roleId
//
// 權限模型(2026-05-05 spec):
//   - name / description / 一般 metadata 修改:沿用 workspace-level
//     `canManageRoles`,workspace 管理員可以重新命名身份組。
//   - permissions(13 個 boolean 欄位)修改:**只限系統管理員**
//     (User.isSystemAdmin=true)。修改權限本身屬於特權升級動作,
//     不應該由 workspace 管理員自我擴權。
//
// 「系統預設身份組」(isSystemDefault=true)不再特別保護 — 之前的
// 「不可改權限」鎖移除,使得「實際上沒有預設權限」這件事在 UX 跟
// 後端都對齊。系統管理員可任意修改。
export async function PATCH(req: Request, { params }: RouteParams) {
  const { workspaceId, roleId } = await params;
  const auth = await requireWorkspacePermission(workspaceId, "canManageRoles");
  if (auth instanceof NextResponse) return auth;

  const role = await prisma.role.findFirst({
    where: { id: roleId, workspaceId, isActive: true },
  });
  if (!role) {
    return NextResponse.json({ error: "找不到身份組" }, { status: 404 });
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "無效的請求內容" }, { status: 400 });
  }

  const name = body.name !== undefined ? (body.name as string)?.trim() : undefined;
  const description = body.description !== undefined ? (body.description as string)?.trim() || null : undefined;
  const permissions = body.permissions as Record<string, boolean> | undefined;

  // 限縮 permissions 修改至系統管理員。auth.isSystemAdmin 由
  // requireWorkspacePermission 帶回(系統管理員自動擁有所有 workspace
  // 權限,所以前面 canManageRoles 不會擋他;這裡再做一次顯式檢查)。
  if (permissions) {
    const triedToChangePermissions = ALL_PERMISSIONS.some((k) => {
      if (!(k in permissions)) return false;
      const requested = permissions[k] === true;
      return requested !== (role[k as keyof typeof role] as boolean);
    });
    if (triedToChangePermissions && !auth.isSystemAdmin) {
      return NextResponse.json(
        { error: "只有系統管理員可以修改身份組的權限" },
        { status: 403 }
      );
    }
  }

  // If updating name, check uniqueness
  if (name && name !== role.name) {
    const existing = await prisma.role.findUnique({
      where: { workspaceId_name: { workspaceId, name } },
    });
    if (existing) {
      return NextResponse.json(
        { error: "此工作空間已存在相同名稱的身份組" },
        { status: 409 }
      );
    }
  }

  // Safeguard: prevent removing canManageRoles from the last admin-capable role
  if (permissions && permissions.canManageRoles === false && role.canManageRoles) {
    const adminRolesCount = await prisma.role.count({
      where: {
        workspaceId,
        isActive: true,
        canManageRoles: true,
        id: { not: roleId },
      },
    });
    if (adminRolesCount === 0) {
      return NextResponse.json(
        { error: "無法移除最後一個擁有身份組管理權限的身份組之管理權限" },
        { status: 400 }
      );
    }
  }

  // Build update data
  const updateData: Record<string, unknown> = {};
  if (name !== undefined) updateData.name = name;
  if (description !== undefined) updateData.description = description;

  if (permissions) {
    for (const key of ALL_PERMISSIONS) {
      if (key in permissions) {
        // Explicitly handle both true and false — do not skip falsy values
        updateData[key] = permissions[key] === true;
      }
    }
  }

  const updated = await prisma.role.update({
    where: { id: roleId },
    data: updateData,
    include: {
      _count: { select: { userRoles: true } },
    },
  });

  await logAudit({
    workspaceId,
    userId: auth.userId,
    action: "role.update",
    entityType: "Role",
    entityId: roleId,
    details: { name, permissions },
  });

  return NextResponse.json({ role: updated });
}

// DELETE /api/workspaces/:id/roles/:roleId
export async function DELETE(_req: Request, { params }: RouteParams) {
  const { workspaceId, roleId } = await params;
  const auth = await requireWorkspacePermission(workspaceId, "canManageRoles");
  if (auth instanceof NextResponse) return auth;

  const role = await prisma.role.findFirst({
    where: { id: roleId, workspaceId, isActive: true },
  });
  if (!role) {
    return NextResponse.json({ error: "找不到身份組" }, { status: 404 });
  }

  // 「系統預設」(isSystemDefault) 不再禁止刪除 — 系統沒有所謂的預設權限,
  // 預設身份組只是 seed 出來的 starting point。下方的「最後一個
  // canManageRoles」+「使用者失去所有 role」這兩道保險足以避免誤刪到
  // 不可恢復的狀態。

  // Safeguard: prevent deleting the last admin-capable role
  if (role.canManageRoles) {
    const adminRolesCount = await prisma.role.count({
      where: {
        workspaceId,
        isActive: true,
        canManageRoles: true,
        id: { not: roleId },
      },
    });
    if (adminRolesCount === 0) {
      return NextResponse.json(
        { error: "無法刪除最後一個擁有身份組管理權限的身份組" },
        { status: 400 }
      );
    }
  }

  // C7 fix: check if any user would lose ALL roles
  const affectedUserIds = await prisma.userRole.findMany({
    where: { roleId },
    select: { userId: true },
  });
  for (const { userId } of affectedUserIds) {
    const otherRolesCount = await prisma.userRole.count({
      where: {
        userId,
        roleId: { not: roleId },
        role: { workspaceId, isActive: true },
      },
    });
    if (otherRolesCount === 0) {
      return NextResponse.json(
        { error: `無法刪除：使用者將失去所有身份組（userId: ${userId}）。請先為其指派其他身份組。` },
        { status: 400 }
      );
    }
  }

  // Soft-delete the role and cascade-delete UserRole entries
  await prisma.$transaction([
    prisma.userRole.deleteMany({ where: { roleId } }),
    prisma.role.update({
      where: { id: roleId },
      data: { isActive: false },
    }),
  ]);

  await logAudit({
    workspaceId,
    userId: auth.userId,
    action: "role.delete",
    entityType: "Role",
    entityId: roleId,
    details: { name: role.name },
  });

  return NextResponse.json({ success: true });
}
