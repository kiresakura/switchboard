import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import Link from "next/link";
import MenuConfigSection from "@/components/workspace/MenuConfigSection";
import { requireWorkspacePermissionOrRedirectTo } from "@/lib/auth/page-guards";

/**
 * Workspace overview — supervisor dashboard.
 *
 * 2026-05-21:移除「案件管理」框架。Switchboard 的使命是 TG-client + 直面對話為核心 +
 * 主管監看 —— 每個 TG 帳號同步自己的對話,沒有「結案 / 指派承接者 / 未指派」
 * 這套流程。原本的三個數字(進行中 / 未指派 / 已結案)與「員工負載(依
 * conversationOwner 計)」都建立在那套已廢除的概念上,一併拿掉。
 *
 * 改成單純的工作區現況:
 *   - 追蹤中的對話總數
 *   - 連線中的 TG 帳號數
 *   - 工作區成員數
 *   - 目前在線的成員(5 分鐘內活躍)
 *
 * 「主管看員工負載」未來會改用 AccountAssignment(帳號歸屬)來算,不是
 * conversationOwner — 等該功能接 UI 時再補。
 */
export const dynamic = "force-dynamic";

export default async function WorkspaceOverviewPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  await requireWorkspacePermissionOrRedirectTo(
    workspaceId,
    `/workspace/${workspaceId}/direct-chat`,
    "canSuperviseTeam",
  );
  const session = await getSession();
  if (!session) redirect("/login");

  const { user } = session;

  // Track last-seen for "active members" later in this same page.
  // Fire-and-forget — DB write must NOT block render.
  void prisma.user
    .update({
      where: { id: user.id },
      data: { lastActiveAt: new Date() },
    })
    .catch(() => {});

  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: {
      id: true,
      name: true,
      _count: {
        select: {
          communicationAccounts: { where: { status: "ACTIVE" } },
          groups: { where: { isActive: true } },
          memberships: { where: { isActive: true } },
        },
      },
    },
  });
  if (!workspace) redirect("/workspace");

  // Determine if the current user is allowed to see the admin sections
  // (workspace settings + menu config).
  let isAdmin = user.isSystemAdmin;
  if (!isAdmin) {
    const userRoles = await prisma.userRole.findMany({
      where: { userId: user.id, role: { workspaceId } },
      include: { role: true },
    });
    isAdmin = userRoles.some((ur) => ur.role.canEditWorkspaceSettings);
  }

  const [activeConversations, activeMembers] = await Promise.all([
    // 追蹤中的對話 = active + 非隱藏。沒有 status 過濾(結案概念已移除)。
    prisma.group.count({
      where: {
        workspaceId,
        isActive: true,
        isHidden: false,
      },
    }),
    prisma.workspaceMembership.findMany({
      where: { workspaceId, isActive: true },
      include: {
        user: {
          select: {
            id: true,
            displayName: true,
            lastActiveAt: true,
            isActive: true,
          },
        },
      },
      orderBy: { user: { lastActiveAt: "desc" } },
      take: 10,
    }),
  ]);

  const ACTIVE_WINDOW_MS = 5 * 60 * 1000;
  const now = Date.now();
  const onlineMembers = activeMembers.filter(
    (m) =>
      m.user.lastActiveAt &&
      now - m.user.lastActiveAt.getTime() < ACTIVE_WINDOW_MS,
  );

  return (
    <div className="mx-auto max-w-[1180px] space-y-10 px-6 py-8 animate-fade-in">
      {/* Editorial header */}
      <header className="space-y-1.5">
        <p className="ui-label text-[var(--text-muted)]">Workspace</p>
        <h1 className="font-serif text-[34px] font-medium tracking-[-0.02em] text-[var(--text-primary)]">
          {workspace.name}
        </h1>
        <p className="max-w-[640px] text-[15px] leading-relaxed text-[var(--text-secondary)]">
          這個工作區的當下現況 — 追蹤中的對話、連線的 Telegram 帳號、團隊成員。
        </p>
      </header>

      {/* Three signals — workspace scale, no case-management framing. */}
      <section>
        <p className="ui-label mb-4 text-[var(--text-muted)]">工作區現況</p>
        <div className="grid gap-x-12 gap-y-8 sm:grid-cols-3">
          <DashboardFigure
            value={activeConversations}
            label="追蹤中的對話"
            href={`/workspace/${workspaceId}/direct-chat`}
            tone="primary"
          />
          <DashboardFigure
            value={workspace._count.communicationAccounts}
            label="連線中的 TG 帳號"
            href={`/workspace/${workspaceId}/accounts`}
            tone="muted"
          />
          <DashboardFigure
            value={workspace._count.memberships}
            label="工作區成員"
            href={`/workspace/${workspaceId}/members`}
            tone="muted"
          />
        </div>
      </section>

      <hr className="border-[var(--border)]" />

      {/* Active members — "主管監看員工" 的核心:誰現在真的在線上。
          "Active" = lastActiveAt within 5 min. */}
      <section>
        <p className="ui-label mb-4 text-[var(--text-muted)]">
          目前在線（5 分鐘內）
        </p>
        {onlineMembers.length === 0 ? (
          <p className="text-[14px] text-[var(--text-muted)]">
            目前沒有成員在線。
          </p>
        ) : (
          <ul className="grid gap-x-8 gap-y-2 sm:grid-cols-2 lg:grid-cols-3">
            {onlineMembers.map((m) => (
              <li
                key={m.user.id}
                className="flex items-center gap-2 text-[14px]"
              >
                <span
                  aria-hidden
                  className="inline-block size-2 rounded-full bg-[var(--success)]"
                />
                <span className="text-[var(--text-primary)]">
                  {m.user.displayName}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* ── 工作區操作權限 (管理員 / 主管專屬) ─────────────────────────────
          Controls which ⋮ menu items are visible to ALL workspace members.
          Stored in workspace.uiConfig (DB), applied globally on next page load. */}
      {isAdmin && (
        <>
          <hr className="border-[var(--border)]" />
          <MenuConfigSection workspaceId={workspaceId} />
        </>
      )}

      {/* Footer micro-meta */}
      <footer className="border-t border-[var(--border)] pt-6 text-[13px] text-[var(--text-muted)]">
        {workspace._count.memberships} 位成員 ·{" "}
        {workspace._count.communicationAccounts} 個 TG 帳號 ·{" "}
        {workspace._count.groups} 個追蹤中的對話。
      </footer>
    </div>
  );
}

/**
 * DashboardFigure — flat editorial number + label + optional drill-down.
 */
function DashboardFigure({
  value,
  label,
  href,
  tone = "primary",
  hint,
}: {
  value: number;
  label: string;
  href: string;
  tone?: "primary" | "warning" | "muted";
  hint?: string;
}) {
  const valueColor =
    tone === "warning"
      ? "text-[var(--danger)]"
      : tone === "muted"
        ? "text-[var(--text-secondary)]"
        : "text-[var(--text-primary)]";
  return (
    <Link href={href} className="group block">
      <div
        className={`font-serif text-[52px] leading-[1] tracking-[-0.02em] ${valueColor}`}
      >
        {value}
      </div>
      <div className="mt-2 text-[14px] text-[var(--text-secondary)] group-hover:text-[var(--accent)] group-hover:underline group-hover:underline-offset-2">
        {label}
      </div>
      {hint && (
        <div className="mt-1 text-[12px] text-[var(--text-muted)]">{hint}</div>
      )}
    </Link>
  );
}
