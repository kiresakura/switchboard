import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireWorkspaceMember, requireWorkspacePermission } from "@/lib/auth/middleware";
import { logAudit } from "@/lib/audit/logger";

type RouteParams = { params: Promise<{ workspaceId: string }> };

// GET /api/workspaces/:id - Workspace detail
export async function GET(_req: Request, { params }: RouteParams) {
  const { workspaceId } = await params;
  const auth = await requireWorkspaceMember(workspaceId);
  if (auth instanceof NextResponse) return auth;

  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    include: {
      _count: {
        select: {
          communicationAccounts: true,
          groups: true,
          memberships: { where: { isActive: true } },
        },
      },
    },
  });

  // M3 fix: check workspace is active
  if (!workspace || !workspace.isActive) {
    return NextResponse.json({ error: "找不到工作區" }, { status: 404 });
  }

  return NextResponse.json({ workspace, permissions: auth.permissions });
}

// PATCH /api/workspaces/:id - Update workspace (Admin only)
export async function PATCH(req: Request, { params }: RouteParams) {
  const { workspaceId } = await params;
  const auth = await requireWorkspacePermission(workspaceId, "canEditWorkspaceSettings");
  if (auth instanceof NextResponse) return auth;

  let body: { name?: string; isActive?: boolean };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "無效的請求內容" }, { status: 400 });
  }
  const { name, isActive } = body;

  const workspace = await prisma.workspace.update({
    where: { id: workspaceId },
    data: {
      ...(name !== undefined && { name }),
      ...(isActive !== undefined && { isActive }),
    },
  });

  await logAudit({
    workspaceId,
    userId: auth.userId,
    action: "workspace.update",
    entityType: "Workspace",
    entityId: workspaceId,
    details: { name, isActive },
  });

  return NextResponse.json({ workspace });
}
