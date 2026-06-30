import { requireWorkspacePermissionOrRedirect } from "@/lib/auth/page-guards";

export default async function GroupsLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  await requireWorkspacePermissionOrRedirect(
    workspaceId,
    "canManageGroupRegistry"
  );
  return <>{children}</>;
}
