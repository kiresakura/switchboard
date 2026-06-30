import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireAuth, requireSystemAdmin } from "@/lib/auth/middleware";

// GET /api/workspaces - List user's workspaces (system admin sees ALL)
export async function GET() {
  const auth = await requireAuth();
  if (auth instanceof NextResponse) return auth;

  // System admin sees ALL active workspaces, even ones they haven't joined
  if (auth.isSystemAdmin) {
    const allWorkspaces = await prisma.workspace.findMany({
      where: { isActive: true },
      include: {
        _count: { select: { memberships: { where: { isActive: true } } } },
      },
      orderBy: { name: "asc" },
    });

    // Check which ones admin is a member of
    const adminMemberships = await prisma.workspaceMembership.findMany({
      where: { userId: auth.userId, isActive: true },
      select: { workspaceId: true },
    });
    const memberOf = new Set(adminMemberships.map((m) => m.workspaceId));

    return NextResponse.json({
      workspaces: allWorkspaces.map((ws) => ({
        id: ws.id,
        name: ws.name,
        slug: ws.slug,
        roles: ["系統管理員"],
        memberCount: ws._count.memberships,
        isMember: memberOf.has(ws.id),
      })),
    });
  }

  const memberships = await prisma.workspaceMembership.findMany({
    where: { userId: auth.userId, isActive: true },
    include: {
      workspace: true,
    },
  });

  // Fetch role names for display
  const workspaceIds = memberships
    .filter((m) => m.workspace.isActive)
    .map((m) => m.workspace.id);

  const userRoles = await prisma.userRole.findMany({
    where: {
      userId: auth.userId,
      role: {
        workspaceId: { in: workspaceIds },
        isActive: true,
      },
    },
    include: {
      role: { select: { workspaceId: true, name: true } },
    },
  });

  const rolesByWorkspace: Record<string, string[]> = {};
  for (const ur of userRoles) {
    const wid = ur.role.workspaceId;
    if (!rolesByWorkspace[wid]) rolesByWorkspace[wid] = [];
    rolesByWorkspace[wid].push(ur.role.name);
  }

  return NextResponse.json({
    workspaces: memberships
      .filter((m) => m.workspace.isActive)
      .map((m) => ({
        id: m.workspace.id,
        name: m.workspace.name,
        slug: m.workspace.slug,
        roles: rolesByWorkspace[m.workspace.id] || [],
      })),
  });
}

// POST /api/workspaces - Create workspace (System Admin only)
export async function POST(request: Request) {
  const auth = await requireSystemAdmin();
  if (auth instanceof NextResponse) return auth;

  let body: { name?: string; slug?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "無效的請求內容" }, { status: 400 });
  }
  const { name, slug: clientSlug } = body;

  if (!name || !name.trim()) {
    return NextResponse.json(
      { error: "工作空間名稱為必填" },
      { status: 400 }
    );
  }

  // 自動產生 slug（內部欄位，不暴露給使用者）：
  //   1. 從 name 推一個 base slug（小寫英數 + 中文，其他換 -）
  //   2. 若 base 為空（純符號名稱）→ fallback 用 "ws-" + 短亂碼
  //   3. 與既有 slug 衝突 → 後綴遞增（base, base-2, base-3 ...）
  // 接受 client 傳的 slug 但只當 fallback；正常 UI 不傳
  function buildBaseSlug(input: string): string {
    return input
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9一-鿿]+/g, "-")
      .replace(/^-+|-+$/g, "");
  }
  const baseSlug =
    (clientSlug?.trim() && buildBaseSlug(clientSlug)) ||
    buildBaseSlug(name) ||
    `ws-${Math.random().toString(36).slice(2, 8)}`;

  let slug = baseSlug;
  let attempt = 1;
  // 最多試 50 次防止極端衝突造成無限迴圈（理論上不會發生）
  while (attempt <= 50) {
    const conflict = await prisma.workspace.findUnique({ where: { slug } });
    if (!conflict) break;
    attempt += 1;
    slug = `${baseSlug}-${attempt}`;
  }

  const workspace = await prisma.$transaction(async (tx) => {
    // Create the workspace with admin membership
    const ws = await tx.workspace.create({
      data: {
        name,
        slug,
        memberships: {
          create: {
            userId: auth.userId,
          },
        },
      },
    });

    // Create 3 default roles
    // 「工作空間管理員」= 該 workspace 內的最高權限角色，但仍只限本工作空間。
    // 跟 User.isSystemAdmin 的「系統管理員」是不同層級（系統管理員跨所有工作空間）。
    const adminRole = await tx.role.create({
      data: {
        workspaceId: ws.id,
        name: "工作空間管理員",
        isSystemDefault: true,
        canEditWorkspaceSettings: true,
        canManageCommunicationAccounts: true,
        canManageGroupRegistry: true,
        canManageRouting: true,
        canManageModerationRules: true,
        canManageRoles: true,
        canAssignMemberRoles: true,
        canModerateMessages: true,
        canSendManualMessages: true,
        canDirectMessage: true,
        canManagePostPermissions: true,
        canViewAllAuditLogs: true,
        canViewOwnAuditLogs: true,
      },
    });

    await tx.role.create({
      data: {
        workspaceId: ws.id,
        name: "轉傳客服",
        isSystemDefault: true,
        canModerateMessages: true,
        canSendManualMessages: true,
        canViewOwnAuditLogs: true,
      },
    });

    await tx.role.create({
      data: {
        workspaceId: ws.id,
        name: "直面客服",
        isSystemDefault: true,
        canDirectMessage: true,
        canViewOwnAuditLogs: true,
      },
    });

    // Assign the creator to the 管理員 role
    await tx.userRole.create({
      data: {
        userId: auth.userId,
        roleId: adminRole.id,
      },
    });

    // (Default shifts dropped in H4 — Shift table is gone with the broker.)

    return ws;
  });

  return NextResponse.json({ workspace }, { status: 201 });
}
