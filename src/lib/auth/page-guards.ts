/**
 * Server-side guards for App Router layouts/pages.
 *
 * The API middleware (`requireWorkspacePermission`) protects the data layer,
 * but a permission-less user with a direct URL (e.g. /workspace/X/accounts)
 * still gets to render the page shell + see whatever the page fetches with
 * looser checks. These guards run inside server layout/page components,
 * verifying the same permission keys before a single render byte ships.
 *
 * Usage in a layout.tsx:
 *
 *   import { requireWorkspacePermissionOrRedirect } from "@/lib/auth/page-guards";
 *
 *   export default async function Layout({ children, params }) {
 *     const { workspaceId } = await params;
 *     await requireWorkspacePermissionOrRedirect(workspaceId, "canManageCommunicationAccounts");
 *     return <>{children}</>;
 *   }
 */
import { redirect } from "next/navigation";
import { cache } from "react";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import type { PermissionKey } from "@/lib/auth/middleware";

/**
 * Cached per request: the same workspace + user combination only hits Prisma
 * once even if multiple nested layouts call this helper.
 */
const loadUserRolesForWorkspace = cache(
  async (userId: string, workspaceId: string) => {
    return prisma.userRole.findMany({
      where: { userId, role: { workspaceId, isActive: true } },
      include: { role: true },
    });
  }
);

/**
 * If the current user is not signed in → redirect to /login.
 * If the user is a system admin → pass.
 * Otherwise check ALL given keys are granted by SOME assigned role
 * (permissions are unioned across roles).
 * On failure → redirect to /workspace/{id} (workspace landing).
 */
export async function requireWorkspacePermissionOrRedirect(
  workspaceId: string,
  ...permissions: PermissionKey[]
): Promise<void> {
  await requireWorkspacePermissionOrRedirectTo(
    workspaceId,
    `/workspace/${workspaceId}`,
    ...permissions,
  );
}

export async function requireWorkspacePermissionOrRedirectTo(
  workspaceId: string,
  redirectTo: string,
  ...permissions: PermissionKey[]
): Promise<void> {
  const session = await getSession();
  if (!session) redirect("/login");
  if (session.user.isSystemAdmin) return;

  const userRoles = await loadUserRolesForWorkspace(session.user.id, workspaceId);
  const granted = (key: PermissionKey) =>
    userRoles.some((ur) => {
      const role = ur.role as unknown as Record<string, unknown>;
      return role[key] === true;
    });

  const missing = permissions.filter((p) => !granted(p));
  if (missing.length > 0) {
    redirect(redirectTo);
  }
}
