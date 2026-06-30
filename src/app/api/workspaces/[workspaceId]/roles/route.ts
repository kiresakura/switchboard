import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireWorkspacePermission, ALL_PERMISSIONS } from "@/lib/auth/middleware";
import { logAudit } from "@/lib/audit/logger";

type RouteParams = { params: Promise<{ workspaceId: string }> };

// GET /api/workspaces/:id/roles
export async function GET(_req: Request, { params }: RouteParams) {
  const { workspaceId } = await params;
  const auth = await requireWorkspacePermission(workspaceId, "canManageRoles");
  if (auth instanceof NextResponse) return auth;

  const roles = await prisma.role.findMany({
    where: { workspaceId, isActive: true },
    include: {
      _count: { select: { userRoles: true } },
    },
    orderBy: { createdAt: "asc" },
  });

  return NextResponse.json({ roles });
}

// POST /api/workspaces/:id/roles
export async function POST(req: Request, { params }: RouteParams) {
  const { workspaceId } = await params;
  const auth = await requireWorkspacePermission(workspaceId, "canManageRoles");
  if (auth instanceof NextResponse) return auth;

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "無效的請求內容" }, { status: 400 });
  }

  const name = (body.name as string | undefined)?.trim();
  const description = (body.description as string | undefined)?.trim() || null;
  const permissions = body.permissions as Record<string, boolean> | undefined;

  if (!name) {
    return NextResponse.json(
      { error: "身份組名稱為必填" },
      { status: 400 }
    );
  }

  // Validate name uniqueness per workspace
  const existing = await prisma.role.findUnique({
    where: { workspaceId_name: { workspaceId, name } },
  });
  if (existing) {
    return NextResponse.json(
      { error: "此工作空間已存在相同名稱的身份組" },
      { status: 409 }
    );
  }

  // 權限欄位:只有系統管理員可在建立時設 true(同 PATCH 的 spec)。
  // 非系統管理員傳 permissions={ canManageRoles: true } 之類嘗試自我擴權
  // 一律忽略 — 全部 false 建空殼身份組。
  const permissionData: Record<string, boolean> = {};
  if (permissions && auth.isSystemAdmin) {
    for (const key of ALL_PERMISSIONS) {
      if (key in permissions) {
        permissionData[key] = Boolean(permissions[key]);
      }
    }
  }

  const role = await prisma.role.create({
    data: {
      workspaceId,
      name,
      description,
      ...permissionData,
    },
    include: {
      _count: { select: { userRoles: true } },
    },
  });

  await logAudit({
    workspaceId,
    userId: auth.userId,
    action: "role.create",
    entityType: "Role",
    entityId: role.id,
    details: { name, permissions: permissionData },
  });

  return NextResponse.json({ role }, { status: 201 });
}
