import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireAuth, requireSystemAdmin } from "@/lib/auth/middleware";
import { hashPassword } from "@/lib/auth/passwords";

// GET /api/admin/users - Search users (any auth for username search, full list for admin)
export async function GET(request: Request) {
  const auth = await requireAuth();
  if (auth instanceof NextResponse) return auth;

  const url = new URL(request.url);
  const username = url.searchParams.get("username");

  if (username) {
    // Any authenticated user can search by exact username (for member add)
    const users = await prisma.user.findMany({
      where: { username: username.toLowerCase() },
      select: { id: true, username: true, displayName: true, isActive: true },
    });
    return NextResponse.json({ users });
  }

  // Full user list requires system admin
  if (!auth.isSystemAdmin) {
    return NextResponse.json({ error: "權限不足" }, { status: 403 });
  }

  const page = Math.max(1, parseInt(url.searchParams.get("page") || "1") || 1);
  const limit = Math.min(parseInt(url.searchParams.get("limit") || "50") || 50, 100);

  const [users, total] = await Promise.all([
    prisma.user.findMany({
      select: {
        id: true,
        username: true,
        displayName: true,
        isSystemAdmin: true,
        isActive: true,
        createdAt: true,
      },
      orderBy: { createdAt: "asc" },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.user.count(),
  ]);

  return NextResponse.json({ users, total, page, limit });
}

// POST /api/admin/users - Create user (System Admin only)
export async function POST(request: Request) {
  const auth = await requireSystemAdmin();
  if (auth instanceof NextResponse) return auth;

  let body: {
    username?: string;
    password?: string;
    displayName?: string;
    isSystemAdmin?: boolean;
    workspaceAssignments?: Array<{ workspaceId: string; roleIds?: string[] }>;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "無效的請求內容" }, { status: 400 });
  }
  const { username, password, displayName, isSystemAdmin, workspaceAssignments } = body;

  if (!username || !password || !displayName) {
    return NextResponse.json(
      { error: "username、password、displayName 為必填" },
      { status: 400 }
    );
  }

  if (typeof username !== "string" || username.length < 2 || username.length > 50) {
    return NextResponse.json(
      { error: "帳號長度須介於 2 至 50 字元" },
      { status: 400 }
    );
  }
  if (typeof displayName !== "string" || displayName.trim().length === 0 || displayName.length > 100) {
    return NextResponse.json(
      { error: "顯示名稱長度須介於 1 至 100 字元" },
      { status: 400 }
    );
  }

  if (typeof password !== "string" || password.length < 8 || password.length > 200) {
    return NextResponse.json(
      { error: "密碼長度須介於 8 至 200 字元" },
      { status: 400 }
    );
  }

  // Validate workspaceAssignments shape
  if (workspaceAssignments !== undefined) {
    if (!Array.isArray(workspaceAssignments)) {
      return NextResponse.json(
        { error: "workspaceAssignments 必須為陣列" },
        { status: 400 }
      );
    }
    for (const a of workspaceAssignments) {
      if (!a || typeof a !== "object" || typeof a.workspaceId !== "string" || !a.workspaceId) {
        return NextResponse.json(
          { error: "每個 workspaceAssignment 必須含有 workspaceId" },
          { status: 400 }
        );
      }
      if (a.roleIds !== undefined) {
        if (!Array.isArray(a.roleIds) || a.roleIds.some((r) => typeof r !== "string" || !r)) {
          return NextResponse.json(
            { error: "roleIds 必須為非空字串陣列" },
            { status: 400 }
          );
        }
      }
    }
  }

  const existing = await prisma.user.findUnique({
    where: { username: username.toLowerCase() },
  });
  if (existing) {
    return NextResponse.json(
      { error: "此帳號已存在" },
      { status: 409 }
    );
  }

  // Pre-validate referenced workspaces + roles before starting the transaction
  const assignments = workspaceAssignments ?? [];
  if (assignments.length > 0) {
    const workspaceIds = Array.from(new Set(assignments.map((a) => a.workspaceId)));
    const workspaces = await prisma.workspace.findMany({
      where: { id: { in: workspaceIds } },
      select: { id: true },
    });
    const existingWorkspaceIds = new Set(workspaces.map((w) => w.id));
    for (const wsId of workspaceIds) {
      if (!existingWorkspaceIds.has(wsId)) {
        return NextResponse.json(
          { error: `找不到工作區：${wsId}` },
          { status: 400 }
        );
      }
    }

    const allRoleIds = Array.from(
      new Set(assignments.flatMap((a) => a.roleIds ?? []))
    );
    if (allRoleIds.length > 0) {
      const roles = await prisma.role.findMany({
        where: { id: { in: allRoleIds } },
        select: { id: true, workspaceId: true },
      });
      const roleMap = new Map(roles.map((r) => [r.id, r.workspaceId] as const));
      for (const assignment of assignments) {
        for (const roleId of assignment.roleIds ?? []) {
          const roleWs = roleMap.get(roleId);
          if (!roleWs) {
            return NextResponse.json(
              { error: `找不到身份組：${roleId}` },
              { status: 400 }
            );
          }
          if (roleWs !== assignment.workspaceId) {
            return NextResponse.json(
              {
                error: `身份組 ${roleId} 不屬於工作區 ${assignment.workspaceId}`,
              },
              { status: 400 }
            );
          }
        }
      }
    }
  }

  const passwordHash = await hashPassword(password);

  const user = await prisma.$transaction(async (tx) => {
    const created = await tx.user.create({
      data: {
        username: username.toLowerCase(),
        passwordHash,
        displayName,
        isSystemAdmin: isSystemAdmin ?? false,
      },
    });

    for (const assignment of assignments) {
      await tx.workspaceMembership.create({
        data: {
          userId: created.id,
          workspaceId: assignment.workspaceId,
        },
      });
      for (const roleId of assignment.roleIds ?? []) {
        await tx.userRole.create({
          data: {
            userId: created.id,
            roleId,
          },
        });
      }
    }

    return tx.user.findUnique({
      where: { id: created.id },
      select: {
        id: true,
        username: true,
        displayName: true,
        isSystemAdmin: true,
        isActive: true,
        createdAt: true,
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
  });

  return NextResponse.json({ user }, { status: 201 });
}
