import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { ALL_PERMISSIONS } from "@/lib/auth/middleware";
import type { Permissions } from "@/lib/auth/middleware";

export async function GET() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "尚未登入" }, { status: 401 });
  }

  const { user } = session;

  // Fetch user roles grouped by workspace to compute permissions
  const userRoles = await prisma.userRole.findMany({
    where: {
      userId: user.id,
      role: { isActive: true },
    },
    include: {
      role: true,
    },
  });

  // Group roles by workspaceId and compute union permissions
  const workspacePermissions: Record<string, Permissions> = {};
  for (const ur of userRoles) {
    const wid = ur.role.workspaceId;
    if (!workspacePermissions[wid]) {
      const perms = {} as Permissions;
      for (const key of ALL_PERMISSIONS) {
        perms[key] = false;
      }
      workspacePermissions[wid] = perms;
    }
    for (const key of ALL_PERMISSIONS) {
      if ((ur.role as Record<string, unknown>)[key] === true) {
        workspacePermissions[wid][key] = true;
      }
    }
  }

  return NextResponse.json({
    user: {
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      isSystemAdmin: user.isSystemAdmin,
      // Only return workspaces the user can currently access. Deactivated
      // workspaces stay in memberships (for admin re-activation) but they
      // shouldn't appear in the user's working list — middleware blocks
      // access anyway, showing them would just mislead operators.
      workspaces: user.memberships
        .filter((m) => m.workspace.isActive)
        .map((m) => ({
          id: m.workspace.id,
          name: m.workspace.name,
          slug: m.workspace.slug,
          isActive: m.workspace.isActive,
          permissions: workspacePermissions[m.workspace.id] ?? {},
        })),
    },
  });
}
