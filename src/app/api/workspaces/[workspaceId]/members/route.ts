import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireWorkspacePermission } from "@/lib/auth/middleware";
import { logAudit } from "@/lib/audit/logger";

type RouteParams = { params: Promise<{ workspaceId: string }> };

// GET /api/workspaces/:id/members
export async function GET(_req: Request, { params }: RouteParams) {
  const { workspaceId } = await params;
  const auth = await requireWorkspacePermission(workspaceId, "canAssignMemberRoles");
  if (auth instanceof NextResponse) return auth;

  // H6 fix: filter by isActive to exclude deactivated members
  const members = await prisma.workspaceMembership.findMany({
    where: { workspaceId, isActive: true },
    include: {
      user: {
        select: {
          id: true,
          username: true,
          displayName: true,
          isActive: true,
          // Exposed so UI and callers can filter out system admins, matching
          // the server-side rejection when a flow only allows workspace members
          // as selectable collaboration targets.
          isSystemAdmin: true,
          userRoles: {
            where: { role: { workspaceId } },
            include: {
              role: { select: { id: true, name: true } },
            },
          },
        },
      },
    },
    orderBy: { createdAt: "asc" },
  });

  return NextResponse.json({ members });
}

// POST /api/workspaces/:id/members - Add member
export async function POST(req: Request, { params }: RouteParams) {
  const { workspaceId } = await params;
  const auth = await requireWorkspacePermission(workspaceId, "canAssignMemberRoles");
  if (auth instanceof NextResponse) return auth;

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "無效的請求內容" }, { status: 400 });
  }
  const userId = body.userId as string | undefined;
  const roleIds = body.roleIds as string[] | undefined;

  if (!userId) {
    return NextResponse.json(
      { error: "userId 為必填" },
      { status: 400 }
    );
  }

  if (roleIds && !Array.isArray(roleIds)) {
    return NextResponse.json(
      { error: "roleIds 必須為陣列" },
      { status: 400 }
    );
  }

  // Check if user exists
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) {
    return NextResponse.json({ error: "找不到使用者" }, { status: 404 });
  }

  // Validate roleIds belong to this workspace
  if (roleIds && roleIds.length > 0) {
    const roles = await prisma.role.findMany({
      where: { id: { in: roleIds }, workspaceId, isActive: true },
    });
    if (roles.length !== roleIds.length) {
      return NextResponse.json(
        { error: "一個或多個 roleId 無效" },
        { status: 400 }
      );
    }
  }

  // H3: prevent self-privilege-escalation — a non-admin cannot grant themselves
  // roles they do not already hold. Mirrors the identical guard in PATCH.
  if (
    !auth.isSystemAdmin &&
    userId === auth.userId &&
    Array.isArray(roleIds) &&
    roleIds.length > 0
  ) {
    const currentRoles = await prisma.userRole.findMany({
      where: { userId: auth.userId, role: { workspaceId } },
      select: { roleId: true },
    });
    const currentRoleIds = new Set(currentRoles.map((r) => r.roleId));
    const wouldAdd = roleIds.filter((id) => !currentRoleIds.has(id));
    if (wouldAdd.length > 0) {
      return NextResponse.json(
        { error: "無法為自己新增目前未擁有的身份組(防止權限提升)" },
        { status: 403 }
      );
    }
  }

  // Upsert membership and assign roles in a transaction
  const membership = await prisma.$transaction(async (tx) => {
    const m = await tx.workspaceMembership.upsert({
      where: {
        userId_workspaceId: { userId, workspaceId },
      },
      create: {
        userId,
        workspaceId,
      },
      update: {
        isActive: true,
      },
      include: {
        user: {
          select: {
            id: true,
            username: true,
            displayName: true,
          },
        },
      },
    });

    // Assign roles if provided
    if (roleIds && roleIds.length > 0) {
      for (const roleId of roleIds) {
        await tx.userRole.upsert({
          where: {
            userId_roleId: { userId, roleId },
          },
          create: { userId, roleId },
          update: {},
        });
      }
    }

    return m;
  });

  await logAudit({
    workspaceId,
    userId: auth.userId,
    action: "member.add",
    entityType: "WorkspaceMembership",
    entityId: membership.id,
    details: { targetUserId: userId, roleIds },
  });

  return NextResponse.json({ membership }, { status: 201 });
}

// PATCH /api/workspaces/:id/members - Update member (by body)
export async function PATCH(req: Request, { params }: RouteParams) {
  const { workspaceId } = await params;
  const auth = await requireWorkspacePermission(workspaceId, "canAssignMemberRoles");
  if (auth instanceof NextResponse) return auth;

  let patchBody: Record<string, unknown>;
  try {
    patchBody = await req.json();
  } catch {
    return NextResponse.json({ error: "無效的請求內容" }, { status: 400 });
  }
  const membershipId = patchBody.membershipId as string | undefined;
  const roleIds = patchBody.roleIds as string[] | undefined;
  const isActive = typeof patchBody.isActive === "boolean" ? patchBody.isActive : undefined;

  if (!membershipId) {
    return NextResponse.json(
      { error: "membershipId 為必填" },
      { status: 400 }
    );
  }

  if (roleIds && !Array.isArray(roleIds)) {
    return NextResponse.json(
      { error: "roleIds 必須為陣列" },
      { status: 400 }
    );
  }

  // Look up the membership to get the userId
  const existingMembership = await prisma.workspaceMembership.findUnique({
    where: { id: membershipId, workspaceId },
  });

  if (!existingMembership) {
    return NextResponse.json(
      { error: "找不到成員身份" },
      { status: 404 }
    );
  }

  // Prevent self-privilege-escalation: a non-admin cannot add roles to themselves
  // that they do not already hold.
  if (
    !auth.isSystemAdmin &&
    existingMembership.userId === auth.userId &&
    Array.isArray(roleIds)
  ) {
    const currentRoles = await prisma.userRole.findMany({
      where: { userId: auth.userId, role: { workspaceId } },
      select: { roleId: true },
    });
    const currentRoleIds = new Set(currentRoles.map((r) => r.roleId));
    const wouldAdd = roleIds.filter((id: string) => !currentRoleIds.has(id));
    if (wouldAdd.length > 0) {
      return NextResponse.json(
        { error: "無法為自己新增目前未擁有的身份組(防止權限提升)" },
        { status: 403 }
      );
    }
  }

  // Validate roleIds belong to this workspace
  if (roleIds && roleIds.length > 0) {
    const roles = await prisma.role.findMany({
      where: { id: { in: roleIds }, workspaceId, isActive: true },
    });
    if (roles.length !== roleIds.length) {
      return NextResponse.json(
        { error: "一個或多個 roleId 無效" },
        { status: 400 }
      );
    }
  }

  const membership = await prisma.$transaction(async (tx) => {
    const m = await tx.workspaceMembership.update({
      where: { id: membershipId, workspaceId },
      data: {
        ...(isActive !== undefined && { isActive }),
      },
      include: {
        user: {
          select: {
            id: true,
            username: true,
            displayName: true,
          },
        },
      },
    });

    // (Review-queue lock cleanup dropped in H4 — ReviewQueueItem table is
    // gone. No remaining broker-side state belongs to a member that needs
    // releasing on deactivate.)

    // Replace roles if provided
    if (roleIds !== undefined) {
      // Delete existing workspace-scoped roles for this user
      await tx.userRole.deleteMany({
        where: {
          userId: existingMembership.userId,
          role: { workspaceId },
        },
      });

      // Create new role assignments
      if (roleIds.length > 0) {
        for (const roleId of roleIds) {
          await tx.userRole.create({
            data: {
              userId: existingMembership.userId,
              roleId,
            },
          });
        }
      }
    }

    return m;
  });

  await logAudit({
    workspaceId,
    userId: auth.userId,
    action: "member.update",
    entityType: "WorkspaceMembership",
    entityId: membershipId,
    details: { roleIds, isActive },
  });

  return NextResponse.json({ membership });
}
