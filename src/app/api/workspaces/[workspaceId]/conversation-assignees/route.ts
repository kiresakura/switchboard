import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireWorkspaceMember } from "@/lib/auth/middleware";

const CAN_ASSIGN_KEYS = [
  "canManageGroupRegistry",
  "canSuperviseTeam",
  "canDelegateAccounts",
] as const;

type RouteParams = { params: Promise<{ workspaceId: string }> };

export async function GET(_req: Request, { params }: RouteParams) {
  const { workspaceId } = await params;
  const auth = await requireWorkspaceMember(workspaceId);
  if (auth instanceof NextResponse) return auth;

  const canAssign =
    auth.isSystemAdmin || CAN_ASSIGN_KEYS.some((key) => auth.permissions[key]);
  if (!canAssign) {
    return NextResponse.json({ error: "權限不足" }, { status: 403 });
  }

  const memberships = await prisma.workspaceMembership.findMany({
    where: { workspaceId, isActive: true, user: { isActive: true } },
    select: {
      user: {
        select: {
          id: true,
          username: true,
          displayName: true,
          isSystemAdmin: true,
        },
      },
    },
    orderBy: { createdAt: "asc" },
  });

  return NextResponse.json({
    members: memberships.map((m) => ({
      id: m.user.id,
      username: m.user.username,
      displayName: m.user.displayName,
      isSystemAdmin: m.user.isSystemAdmin,
    })),
  });
}
