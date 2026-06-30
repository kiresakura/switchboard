import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { Sidebar } from "@/components/layout/sidebar";
import { BottomNav } from "@/components/layout/bottom-nav";

const LAST_WORKSPACE_COOKIE = "switchboard_last_workspace";

/** All permission keys on the Role model — for building the workspace nav permissions map */
const PERMISSION_KEYS = [
  "canEditWorkspaceSettings",
  "canManageCommunicationAccounts",
  "canManageGroupRegistry",
  "canManageRouting",
  "canManageModerationRules",
  "canManageRoles",
  "canAssignMemberRoles",
  "canModerateMessages",
  "canSendManualMessages",
  "canDirectMessage",
  "canManagePostPermissions",
  "canViewAllAuditLogs",
  "canViewOwnAuditLogs",
] as const;

export const dynamic = "force-dynamic";

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getSession();
  if (!session) redirect("/login");

  const { user } = session;

  if (!user.isSystemAdmin) {
    redirect("/workspace");
  }

  // 工作空間 context 保留邏輯：
  //   進入 /admin 時，如果使用者最近有造訪過某個工作空間（cookie 記錄），
  //   就在 admin 頁面也顯示該工作空間的 sidebar + nav，讓使用者覺得「還在那個工作空間裡」。
  //   沒有 cookie 或工作空間已被停用 → 用乾淨的 admin sidebar（沒有工作空間 nav）。
  const cookieStore = await cookies();
  const lastWorkspaceId = cookieStore.get(LAST_WORKSPACE_COOKIE)?.value;

  let workspaceContext: {
    id: string;
    name: string;
    permissions: Record<string, boolean>;
    roleNames: string[];
  } | null = null;

  if (lastWorkspaceId) {
    const workspace = await prisma.workspace.findFirst({
      where: { id: lastWorkspaceId, isActive: true },
      select: { id: true, name: true },
    });

    if (workspace) {
      // System admin 一律取得所有權限（跟 workspace layout 的邏輯保持一致）
      const permissions: Record<string, boolean> = {};
      for (const key of PERMISSION_KEYS) {
        permissions[key] = true;
      }

      // 取角色名稱清單（純展示用，系統管理員通常會被指派該 workspace 的「工作空間管理員」role）
      const userRoles = await prisma.userRole.findMany({
        where: {
          userId: user.id,
          role: { workspaceId: workspace.id, isActive: true },
        },
        include: { role: { select: { name: true } } },
      });

      workspaceContext = {
        id: workspace.id,
        name: workspace.name,
        permissions,
        roleNames: userRoles.map((r) => r.role.name),
      };
    }
  }

  return (
    <div className="flex h-dvh overflow-hidden bg-[var(--background)]">
      <Sidebar
        workspaceId={workspaceContext?.id}
        workspaceName={workspaceContext?.name}
        permissions={workspaceContext?.permissions}
        isSystemAdmin={user.isSystemAdmin}
        userName={user.displayName}
        userRoles={workspaceContext?.roleNames}
      />
      <main className="flex-1 overflow-y-auto pt-14 md:pt-0 md:pb-0 scrollbar-smooth pb-16 md:pb-0">
        <div
          className="min-h-full px-4 py-4 md:px-6 md:py-5 lg:px-8 lg:py-6"
          style={{ backgroundImage: "var(--gradient-mesh)" }}
        >
          {children}
        </div>
      </main>
      {workspaceContext && <BottomNav workspaceId={workspaceContext.id} />}
    </div>
  );
}
