import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { Sidebar } from "@/components/layout/sidebar";
import { BottomNav } from "@/components/layout/bottom-nav";
import { WorkspacePermissionsProvider } from "@/components/layout/workspace-permissions";
import { LastWorkspaceCookieSetter } from "@/components/layout/last-workspace-cookie";
import { UserProfileModalHost } from "@/components/chat/user-profile-modal-host";
import { ALL_PERMISSIONS } from "@/lib/auth/middleware";
// 2026-05-21 移除 UnassignedGroupsBanner — 每個 TG 帳號同步自己的對話,不需要
// 「分配對話給自己」這層動作。新使命下 conversationOwnerId 仍可用於主管接管 /
// 跨員工轉派,但「未指派」不應該變成 alarming banner。需要時去帳號管理頁查就好。
//
// 既存 server-side query 也一併拿掉,減少每次 layout render 一次 DB COUNT。
export const dynamic = "force-dynamic";

type PermissionMap = Record<string, boolean>;

function buildPermissions(
  roles: Array<Record<string, unknown>>,
  isSystemAdmin: boolean
): PermissionMap {
  const perms: PermissionMap = {};
  for (const key of ALL_PERMISSIONS) {
    // System admins get all permissions
    if (isSystemAdmin) {
      perms[key] = true;
    } else {
      // Union: if ANY assigned role grants this permission, it's true
      perms[key] = roles.some((r) => r[key] === true);
    }
  }
  return perms;
}

export default async function WorkspaceLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  const session = await getSession();
  if (!session) redirect("/login");
  // 「最後造訪 workspace」cookie 在下面 client component 寫入（Next.js 16 不允許
  // server component 改 cookie）— 用於之後進入 admin layout 時保留 workspace context

  const { user } = session;

  // Find membership for this workspace
  const membership = user.memberships.find(
    (m) => m.workspaceId === workspaceId && m.isActive
  );

  // System admins can access any workspace
  if (!membership && !user.isSystemAdmin) {
    redirect("/workspace");
  }

  // 效能注意:這三個 query 全部 parallelize。
  //
  // 原本 sequential (workspace → userRoles → 條件式 group.count) 在每次切頁
  // 都會疊加 ~3 個 round-trip,Railway WAN 條件下 ~100-300ms 純 layout 等待。
  // 2026-05-21 移除 unassigned groups COUNT 查詢(隨 banner 一起拿掉)— 每個 TG 帳號
  // 同步自己的對話,不存在「分配給自己」的概念。
  const [workspace, userRoles] = await Promise.all([
    prisma.workspace.findUnique({
      where: { id: workspaceId },
    }),
    prisma.userRole.findMany({
      where: {
        userId: user.id,
        role: {
          workspaceId,
          isActive: true,
        },
      },
      include: { role: true },
    }),
  ]);

  if (!workspace || !workspace.isActive) {
    redirect("/workspace");
  }

  const permissions = buildPermissions(
    userRoles.map((ur) => ur.role as unknown as Record<string, unknown>),
    user.isSystemAdmin
  );

  const roleNames = userRoles.map((ur) => ur.role.name);

  return (
    <div className="flex h-dvh overflow-hidden bg-[var(--background)]">
      <LastWorkspaceCookieSetter workspaceId={workspaceId} />
      <UserProfileModalHost workspaceId={workspaceId} />
      <Sidebar
        workspaceId={workspaceId}
        workspaceName={workspace.name}
        permissions={permissions}
        isSystemAdmin={user.isSystemAdmin}
        userName={user.displayName}
        userRoles={roleNames}
      />
      <main className="flex-1 overflow-y-auto pt-14 pb-16 md:pt-0 md:pb-0 scrollbar-smooth">
        <div
          className="min-h-full px-4 py-4 md:px-6 md:py-5 lg:px-8 lg:py-6"
          style={{ backgroundImage: "var(--gradient-mesh)" }}
        >
          <WorkspacePermissionsProvider permissions={permissions}>
            {children}
          </WorkspacePermissionsProvider>
        </div>
      </main>
      <BottomNav workspaceId={workspaceId} />
    </div>
  );
}
