import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireSystemAdmin } from "@/lib/auth/middleware";
import { logAudit } from "@/lib/audit/logger";

type RouteParams = { params: Promise<{ workspaceId: string }> };

// GET /api/admin/workspaces/:workspaceId
export async function GET(_request: Request, { params }: RouteParams) {
  const auth = await requireSystemAdmin();
  if (auth instanceof NextResponse) return auth;

  const { workspaceId } = await params;

  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: {
      id: true,
      name: true,
      slug: true,
      isActive: true,
      createdAt: true,
      updatedAt: true,
      _count: {
        select: {
          memberships: { where: { isActive: true } },
          groups: { where: { isActive: true } },
          communicationAccounts: true,
        },
      },
    },
  });

  if (!workspace) {
    return NextResponse.json(
      { error: "找不到工作區" },
      { status: 404 }
    );
  }

  return NextResponse.json({
    workspace: {
      id: workspace.id,
      name: workspace.name,
      slug: workspace.slug,
      isActive: workspace.isActive,
      createdAt: workspace.createdAt,
      updatedAt: workspace.updatedAt,
      memberCount: workspace._count.memberships,
      activeGroupCount: workspace._count.groups,
      accountCount: workspace._count.communicationAccounts,
    },
  });
}

// PATCH /api/admin/workspaces/:workspaceId
export async function PATCH(request: Request, { params }: RouteParams) {
  const auth = await requireSystemAdmin();
  if (auth instanceof NextResponse) return auth;

  const { workspaceId } = await params;

  let body: { name?: string; isActive?: boolean };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "無效的請求內容" },
      { status: 400 }
    );
  }

  const { name, isActive } = body;

  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { id: true, name: true, isActive: true },
  });

  if (!workspace) {
    return NextResponse.json(
      { error: "找不到工作區" },
      { status: 404 }
    );
  }

  const updateData: Record<string, unknown> = {};
  const changedFields: Record<string, { from: unknown; to: unknown }> = {};

  if (name !== undefined && name !== workspace.name) {
    if (typeof name !== "string" || name.trim().length === 0) {
      return NextResponse.json(
        { error: "工作區名稱不可為空" },
        { status: 400 }
      );
    }
    updateData.name = name.trim();
    changedFields.name = { from: workspace.name, to: name.trim() };
  }

  if (isActive !== undefined && isActive !== workspace.isActive) {
    updateData.isActive = isActive;
    changedFields.isActive = { from: workspace.isActive, to: isActive };
  }

  if (Object.keys(updateData).length === 0) {
    return NextResponse.json(
      { error: "沒有需要更新的欄位" },
      { status: 400 }
    );
  }

  const updated = await prisma.workspace.update({
    where: { id: workspaceId },
    data: updateData,
    select: {
      id: true,
      name: true,
      slug: true,
      isActive: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  // Audit log
  try {
    await logAudit({
      workspaceId,
      userId: auth.userId,
      action: isActive === false ? "WORKSPACE_DEACTIVATED" : "workspace.updated",
      entityType: "Workspace",
      entityId: workspaceId,
      details: { changedFields },
      ipAddress:
        request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
        undefined,
    });
  } catch {
    // never block response on audit failure
  }

  return NextResponse.json({ workspace: updated });
}

// DELETE /api/admin/workspaces/:workspaceId
export async function DELETE(_request: Request, { params }: RouteParams) {
  const auth = await requireSystemAdmin();
  if (auth instanceof NextResponse) return auth;

  const { workspaceId } = await params;

  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    include: {
      _count: {
        select: {
          memberships: true,
          groups: true,
          directChatMessages: true,
          auditLogs: true,
        },
      },
    },
  });

  if (!workspace) {
    return NextResponse.json({ error: "找不到此工作空間" }, { status: 404 });
  }

  // "Has data" post broker-strip = DCM / group / membership / audit
  // history. Old broker-flavored signals (pairings / announcements /
  // handovers) dropped along with the tables.
  const hasData =
    workspace._count.directChatMessages > 0 ||
    workspace._count.groups > 0 ||
    workspace._count.memberships > 0;

  if (hasData) {
    await prisma.workspace.update({
      where: { id: workspaceId },
      data: { isActive: false },
    });

    await logAudit({
      workspaceId,
      userId: auth.userId,
      action: "WORKSPACE_DEACTIVATED",
      entityType: "Workspace",
      entityId: workspaceId,
      details: {
        reason: "has_data",
        directChatMessages: workspace._count.directChatMessages,
        groups: workspace._count.groups,
        memberships: workspace._count.memberships,
      },
    }).catch(() => {});

    return NextResponse.json({
      success: true,
      method: "deactivated",
      message: `此工作空間有 ${workspace._count.directChatMessages} 則對話訊息、${workspace._count.groups} 個群組，已停用而非刪除`,
    });
  }

  // Hard-delete: no operational data, cascade will clean up roles/memberships/groups
  await prisma.workspace.delete({ where: { id: workspaceId } });

  await logAudit({
    workspaceId,
    userId: auth.userId,
    action: "WORKSPACE_DELETED",
    entityType: "Workspace",
    entityId: workspaceId,
    details: { name: workspace.name },
  }).catch(() => {});

  return NextResponse.json({ success: true, method: "deleted" });
}

// POST /api/admin/workspaces/:workspaceId/join — Admin joins a workspace
export async function POST(request: Request, { params }: RouteParams) {
  const auth = await requireSystemAdmin();
  if (auth instanceof NextResponse) return auth;

  const { workspaceId } = await params;

  let body: { userId?: string } = {};
  try {
    body = await request.json();
  } catch {
    // No body = admin joining themselves
  }

  const targetUserId = body.userId || auth.userId;

  // Verify workspace exists
  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
  });
  if (!workspace) {
    return NextResponse.json({ error: "找不到此工作空間" }, { status: 404 });
  }

  // Upsert membership (reactivate if previously deactivated)
  const membership = await prisma.workspaceMembership.upsert({
    where: {
      userId_workspaceId: { userId: targetUserId, workspaceId },
    },
    create: { userId: targetUserId, workspaceId },
    update: { isActive: true },
  });

  // 系統管理員把自己加入這個 workspace 時，順便把 workspace 的「工作空間管理員」
  // 身份組也指派給自己（方便操作；可隨時於該 workspace 的身份組頁面取消）。
  // 兼容以前命名的「管理員」row（部分舊 workspace 從 e955db0 之前建立的）。
  if (targetUserId === auth.userId) {
    const adminRole = await prisma.role.findFirst({
      where: {
        workspaceId,
        isActive: true,
        OR: [{ name: "工作空間管理員" }, { name: "管理員" }],
      },
    });
    if (adminRole) {
      await prisma.userRole.upsert({
        where: { userId_roleId: { userId: auth.userId, roleId: adminRole.id } },
        create: { userId: auth.userId, roleId: adminRole.id },
        update: {},
      });
    }
  }

  await logAudit({
    workspaceId,
    userId: auth.userId,
    action: "workspace.member_added",
    entityType: "WorkspaceMembership",
    entityId: membership.id,
    details: { targetUserId, addedBy: auth.userId },
  }).catch(() => {});

  return NextResponse.json({ success: true, membershipId: membership.id });
}
