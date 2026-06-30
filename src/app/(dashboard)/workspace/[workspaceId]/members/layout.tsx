import { requireWorkspacePermissionOrRedirect } from "@/lib/auth/page-guards";

export default async function MembersLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  await requireWorkspacePermissionOrRedirect(workspaceId, "canAssignMemberRoles");
  return <>{children}</>;
}
