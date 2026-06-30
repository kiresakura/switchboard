import { requireWorkspacePermissionOrRedirect } from "@/lib/auth/page-guards";

export default async function SchedulesLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  await requireWorkspacePermissionOrRedirect(workspaceId, "canEditWorkspaceSettings");
  return <>{children}</>;
}
