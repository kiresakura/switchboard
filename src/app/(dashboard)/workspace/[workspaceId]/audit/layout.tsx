import { requireWorkspacePermissionOrRedirect } from "@/lib/auth/page-guards";

export default async function AuditLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  await requireWorkspacePermissionOrRedirect(workspaceId, "canViewAllAuditLogs");
  return <>{children}</>;
}
