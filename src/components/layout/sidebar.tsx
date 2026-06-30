"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  Users,
  MessageSquare,
  Shield,
  MonitorSmartphone,
  FileText,
  Settings,
  LogOut,
  Menu,
  X,
  PanelLeftClose,
  PanelLeftOpen,
  UserCog,
  MessageSquareText,
  Tag,
  CalendarClock,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useState, useEffect } from "react";
import { ThemeToggle } from "./ThemeToggle";
import { useSSE } from "@/hooks/use-sse";
import type { PermissionKey } from "@/lib/auth/middleware";

const SIDEBAR_COLLAPSED_KEY = "sidebar_collapsed";

type NavItem = {
  label: string;
  href: string;
  icon: typeof LayoutDashboard;
  requiredPermissions: PermissionKey[];
  /** If true, show when user has ANY of the listed permissions (OR logic) */
  anyPermission?: boolean;
};

type NavGroup = {
  label: string;
  items: NavItem[];
};

type SidebarProps = {
  workspaceId?: string;
  workspaceName?: string;
  permissions?: Record<string, boolean>;
  isSystemAdmin?: boolean;
  userName: string;
  userRoles?: string[];
};

export function Sidebar({
  workspaceId,
  workspaceName,
  permissions = {},
  isSystemAdmin,
  userName,
  userRoles = [],
}: SidebarProps) {
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);

  // ─── Unread badges ─────────────────────────────────────────────
  // Spec 2026-04-24 (meeting action #3): CS needs visible notification
  // when new activity arrives while they're on another page. Badge per
  // nav key, resets when user lands on the corresponding page.
  //
  // We deliberately scope this to a few high-signal navs — "審核佇列" and
  // the two chat entrances. Tasks/audit/etc. don't need live counts.
  // unread 持久化到 sessionStorage — 避免 sidebar 重新 mount（跨 layout 切換 / 重整）
  // 時 badge 莫名其妙消失。Key 帶 workspaceId 隔離，不同工作空間的 unread 不會混。
  const unreadStorageKey = workspaceId ? `switchboard_unread_${workspaceId}` : null;
  const [unread, setUnread] = useState<Record<string, number>>(() => {
    if (typeof window === "undefined" || !unreadStorageKey) return {};
    try {
      const raw = sessionStorage.getItem(unreadStorageKey);
      return raw ? (JSON.parse(raw) as Record<string, number>) : {};
    } catch {
      return {};
    }
  });
  useEffect(() => {
    if (!unreadStorageKey) return;
    try {
      sessionStorage.setItem(unreadStorageKey, JSON.stringify(unread));
    } catch {
      // sessionStorage 滿 / 不可用 → 安靜略過
    }
  }, [unread, unreadStorageKey]);
  // (Broker badges — pendingReview / boardUnread — removed with the H1
  // broker strip. Only chat:message updates the per-conversation unread
  // counters below.)

  useSSE({
    workspaceId: workspaceId ?? "",
    onMessage: (msg) => {
      if (!workspaceId) return;
      const directHref = `/workspace/${workspaceId}/direct-chat`;

      // chat:message 路由規則(internal-chat 移除後簡化):
      //   - 直面對話 badge:對所有 chatType 觸發(PRIVATE / GROUP / CHANNEL 都歸這裡)
      //   - 隱藏群組:整個忽略
      // per-group sessionStorage 仍維護 direct kind,讓 direct-chat page 顯示
      // 每個對話的獨立 badge。
      if (msg.type === "chat:message") {
        const data = msg.data as {
          chatType?: string;
          groupId?: string;
          direction?: string;
          isHidden?: boolean;
          isMuted?: boolean;
        };
        if (data.isHidden) return;
        const isOutgoing = data.direction === "OUTBOUND";
        const groupId = data.groupId;

        // 收進來的(非自己發送)才累加 sidebar 整體 badge。
        // P2 靜音中的對話不累加整體 badge — TG 行為:靜音 = 不要打擾,但
        // 訊息仍 archive 進 DB,使用者進對話頁仍能看到 per-chat badge。
        if (!isOutgoing && !data.isMuted) {
          setUnread((u) => ({ ...u, [directHref]: (u[directHref] ?? 0) + 1 }));
        }

        // Per-group:自己發的不算;存到 direct sessionStorage 鍵。
        // 靜音對話這層仍累加 — 進直面對話頁時使用者仍會看到 N 未讀,
        // 只是整個 sidebar 圓圈不會閃紅點。
        if (groupId && !isOutgoing) {
          const key = `switchboard_direct_unread_${workspaceId}`;
          try {
            const raw = sessionStorage.getItem(key);
            const map = (raw ? JSON.parse(raw) : {}) as Record<string, number>;
            map[groupId] = (map[groupId] ?? 0) + 1;
            sessionStorage.setItem(key, JSON.stringify(map));
            window.dispatchEvent(
              new CustomEvent("switchboard:unread-updated", {
                detail: { kind: "direct", groupId },
              }),
            );
          } catch {
            // storage 滿 / 不可用 → 安靜略過
          }
        }
      }
    },
  });

  // 自動清 badge 規則：
  //   - 直面對話:只逛到 listing 不算「看過」，不能清。等使用者真的點進某個
  //     對話才清(透過下方 switchboard:chat-viewed 事件)。
  //   - 其他 nav:抵達該頁就視為已看到內容，清掉。
  useEffect(() => {
    if (!workspaceId) return;
    const directHref = `/workspace/${workspaceId}/direct-chat`;
    if (pathname === directHref) return;
    if (unread[pathname]) {
      setUnread((u) => {
        const next = { ...u };
        delete next[pathname];
        return next;
      });
    }
    // Only care about pathname changes; unread is intentionally omitted.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname, workspaceId]);

  // (Broker board-read-changed listener removed with H1 — Board module
  // deleted along with the rest of the broker UI.)

  // 監聽「使用者真的點進某個對話」事件 — 點進去才清對應 badge。
  // 由 direct-chat 頁的 chat-row click handler 觸發 window.dispatchEvent。
  useEffect(() => {
    if (!workspaceId) return;
    const directHref = `/workspace/${workspaceId}/direct-chat`;
    function handler(e: Event) {
      const detail = (e as CustomEvent).detail as { kind?: "direct" };
      if (detail.kind !== "direct") return;
      setUnread((u) => {
        if (!u[directHref]) return u;
        const next = { ...u };
        delete next[directHref];
        return next;
      });
    }
    window.addEventListener("switchboard:chat-viewed", handler);
    return () => window.removeEventListener("switchboard:chat-viewed", handler);
  }, [workspaceId]);

  // Restore collapsed state from localStorage on mount
  useEffect(() => {
    try {
      const saved = localStorage.getItem(SIDEBAR_COLLAPSED_KEY);
      if (saved !== null) {
         
        setCollapsed(saved === "true");
      }
    } catch {
      // localStorage unavailable, use default
    }
  }, []);

  // Persist collapsed state to localStorage
  const toggleCollapsed = () => {
    const next = !collapsed;
    setCollapsed(next);
    try {
      localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(next));
    } catch {
      // localStorage unavailable
    }
  };

  const wsBase = workspaceId ? `/workspace/${workspaceId}` : "";

  const hasPermission = (item: NavItem): boolean => {
    if (item.requiredPermissions.length === 0) return true;
    if (isSystemAdmin) return true;
    if (item.anyPermission) {
      return item.requiredPermissions.some((p) => permissions[p]);
    }
    return item.requiredPermissions.every((p) => permissions[p]);
  };

  // Post broker-strip (2026-05-20) — sidebar collapses to two groups:
  //   「對話」 = the product (direct-chat — internal-chat 移除於 2026-05-20)
  //   「設定」 = supervisor + admin chrome (accounts, groups, roles,
  //              members, audit + the new dashboard at workspace root)
  // No more 「轉傳佇列」 (broker world). No 主控台 entry — landing on
  // /workspace/[id] is the supervisor dashboard and is only visible to
  // canSuperviseTeam/system-admin users. Members without that permission land
  // on direct-chat instead.
  const wsNavGroups: NavGroup[] = workspaceId
    ? [
        {
          label: "對話",
          items: [
            {
              label: "直面對話",
              href: `${wsBase}/direct-chat`,
              icon: MessageSquare,
              requiredPermissions: ["canDirectMessage"],
            },
            {
              label: "快選回覆",
              href: `${wsBase}/quick-replies`,
              icon: MessageSquareText,
              requiredPermissions: ["canDirectMessage"],
            },
          ],
        },
        {
          label: "設定",
          items: [
            {
              label: "主管儀表板",
              href: wsBase,
              icon: LayoutDashboard,
              requiredPermissions: ["canSuperviseTeam"],
            },
            {
              label: "Telegram 帳號",
              href: `${wsBase}/accounts`,
              icon: MonitorSmartphone,
              requiredPermissions: ["canManageCommunicationAccounts"],
            },
            {
              // 2026-05-21 重命名:此頁不只管「群組」,也涵蓋 1:1 私訊、channel 等所有
              // 對話來源(Group.chatType 三種)— 以「帳號」為主體的同步入口更貼近事實。
              label: "帳號管理",
              href: `${wsBase}/groups`,
              icon: Users,
              requiredPermissions: ["canManageGroupRegistry"],
            },
            {
              label: "身份組管理",
              href: `${wsBase}/roles`,
              icon: UserCog,
              requiredPermissions: ["canManageRoles"],
            },
            {
              label: "成員管理",
              href: `${wsBase}/members`,
              icon: Shield,
              requiredPermissions: ["canAssignMemberRoles"],
            },
            {
              label: "標籤管理",
              href: `${wsBase}/workspace-tags`,
              icon: Tag,
              requiredPermissions: ["canEditWorkspaceSettings"],
            },
            {
              label: "排程模組",
              href: `${wsBase}/schedules`,
              icon: CalendarClock,
              requiredPermissions: ["canEditWorkspaceSettings"],
            },
            {
              label: "操作紀錄",
              href: `${wsBase}/audit`,
              icon: FileText,
              requiredPermissions: ["canViewAllAuditLogs"],
            },
          ],
        },
      ]
    : [];

  // 過濾 — 隱藏整組沒任何項目通過權限檢查的 group。
  const visibleWsNavGroups = wsNavGroups
    .map((g) => ({ ...g, items: g.items.filter(hasPermission) }))
    .filter((g) => g.items.length > 0);

  const handleLogout = async () => {
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } catch {
      // Continue to login page even if logout request fails
    }
    window.location.href = "/login";
  };

  const closeMobile = () => setMobileOpen(false);

  const navContent = (
    <>
      {/* Header — editorial brand block. Mark icon is a small flat square
          in terracotta (single-accent rule); wordmark uses serif. No
          shadow rings, no rounded-2xl. The bottom border carries the
          divider rather than any background lift. */}
      <div className="flex items-center gap-3 border-b border-[var(--sidebar-border)] px-3 py-4">
        {!collapsed && (
          <div className="flex items-center gap-2.5 min-w-0 flex-1">
            <div className="flex size-7 shrink-0 items-center justify-center rounded-md bg-[var(--accent)]">
              <MessageSquareText className="size-3.5 text-white" strokeWidth={2} />
            </div>
            <div className="min-w-0">
              <h2 className="font-serif text-[15px] font-medium tracking-[-0.01em] text-[var(--sidebar-text-active)]">
                Switchboard
              </h2>
              {workspaceName && (
                <p className="truncate text-[11px] text-[var(--sidebar-text)]">
                  {workspaceName}
                </p>
              )}
            </div>
          </div>
        )}
        {collapsed && (
          <div className="flex size-7 mx-auto items-center justify-center rounded-md bg-[var(--accent)]">
            <MessageSquareText className="size-3.5 text-white" strokeWidth={2} />
          </div>
        )}
        <div className="flex items-center gap-0.5 shrink-0">
          <ThemeToggle collapsed={collapsed} />
          {/* 手機版關閉 */}
          <button
            onClick={closeMobile}
            aria-label="關閉選單"
            className="rounded-md p-2 text-[var(--sidebar-text)] transition-colors hover:bg-[var(--sidebar-hover)] hover:text-[var(--sidebar-text-active)] md:hidden"
          >
            <X size={16} />
          </button>
          {/* 桌面版收合切換 */}
          <button
            onClick={toggleCollapsed}
            className="hidden rounded-md p-1.5 text-[var(--sidebar-text)] transition-colors hover:bg-[var(--sidebar-hover)] hover:text-[var(--sidebar-text-active)] md:block"
            title={collapsed ? "展開選單" : "收合選單"}
            aria-label={collapsed ? "展開選單" : "收合選單"}
          >
            {collapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
          </button>
        </div>
      </div>

      {/* Navigation */}
      <nav className="flex-1 space-y-0.5 overflow-y-auto px-2 py-3 scrollbar-smooth">
        {!workspaceId && (
          <Link
            href="/workspace"
            className={cn(
              "flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-[background-color,color] duration-150",
              collapsed && "justify-center px-2",
              pathname === "/workspace"
                ? "bg-[var(--sidebar-active-bg)] text-[var(--sidebar-active)] font-medium"
                : "text-[var(--sidebar-text)] hover:bg-[var(--sidebar-hover)] hover:text-[var(--sidebar-text-active)]"
            )}
            onClick={closeMobile}
            title={collapsed ? "選擇工作空間" : undefined}
          >
            <LayoutDashboard size={17} className="shrink-0" />
            {!collapsed && "選擇工作空間"}
          </Link>
        )}

        {visibleWsNavGroups.map((group, gi) => (
          <div key={group.label} className={cn(gi > 0 && "mt-5")}>
            {!collapsed && (
              <div className="ui-label px-3 mb-1.5 text-[var(--text-muted)]">
                {group.label}
              </div>
            )}
            {collapsed && gi > 0 && (
              <div className="my-2 mx-2 border-t border-[var(--sidebar-border)]/60" />
            )}
            {group.items.map((item) => {
              const isActive =
                item.href === wsBase
                  ? pathname === wsBase
                  : pathname.startsWith(item.href);
              // Broker badges (pendingReview / boardUnread) gone with H1 —
              // per-conversation chat unread is the only badge signal left.
              const badgeCount = unread[item.href] ?? 0;
              const badgeColor = "bg-[var(--reject)]";
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={cn(
                    // Flat row, no background fill at rest. Active state is
                    // an accent-tinted left bar + ink text, matching the
                    // "navigation = underline on hover, accent on active"
                    // rule in §4 (translated to the vertical sidebar form).
                    "relative flex items-center gap-2.5 rounded-md px-3 py-1.5 text-[14px] transition-[background-color,color] duration-150",
                    collapsed && "justify-center px-2",
                    isActive
                      ? "bg-[var(--sidebar-active-bg)] text-[var(--sidebar-active)] font-medium"
                      : "text-[var(--sidebar-text)] hover:bg-[var(--sidebar-hover)] hover:text-[var(--sidebar-text-active)]",
                  )}
                  onClick={closeMobile}
                  title={collapsed ? item.label : undefined}
                >
                  {isActive && !collapsed && (
                    <span
                      aria-hidden
                      className="absolute left-0 top-1/2 h-4 w-[2px] -translate-y-1/2 rounded-r bg-[var(--accent)]"
                    />
                  )}
                  <span className="relative shrink-0">
                    <item.icon size={17} />
                    {collapsed && badgeCount > 0 && (
                      <span className={`absolute -right-1.5 -top-1.5 flex size-4 items-center justify-center rounded-full ${badgeColor} text-[10px] font-bold text-white`}>
                        {badgeCount > 9 ? "9+" : badgeCount}
                      </span>
                    )}
                  </span>
                  {!collapsed && (
                    <>
                      <span className="flex-1">{item.label}</span>
                      {badgeCount > 0 && (
                        <span className={`ml-auto inline-flex min-w-[20px] items-center justify-center rounded-full ${badgeColor} px-1.5 py-0.5 text-[10px] font-bold text-white`}>
                          {badgeCount > 99 ? "99+" : badgeCount}
                        </span>
                      )}
                    </>
                  )}
                </Link>
              );
            })}
          </div>
        ))}

        {isSystemAdmin && (
          <>
            <div className="my-3 mx-2 border-t border-[var(--sidebar-border)]" />
            <Link
              href="/admin"
              className={cn(
                "flex items-center gap-2.5 rounded-md px-3 py-1.5 text-[14px] transition-[background-color,color] duration-150",
                collapsed && "justify-center px-2",
                pathname.startsWith("/admin")
                  ? "bg-[var(--sidebar-active-bg)] text-[var(--sidebar-active)] font-medium"
                  : "text-[var(--sidebar-text)] hover:bg-[var(--sidebar-hover)] hover:text-[var(--sidebar-text-active)]"
              )}
              onClick={closeMobile}
              title={collapsed ? "全域系統設定" : undefined}
            >
              <Settings size={17} className="shrink-0" />
              {!collapsed && "全域系統設定"}
            </Link>
          </>
        )}
      </nav>

      {/* User section — flat avatar (no shadow ring); role chips use the
          cream `bg-primary` against the slightly-darker sidebar surface so
          they read without their own border. */}
      <div className="border-t border-[var(--sidebar-border)] px-3 py-3">
        {!collapsed && (
          <div className="mb-2.5">
            <div className="flex items-center gap-2">
              <div className="flex size-7 items-center justify-center rounded-full border border-[var(--border)] bg-[var(--bg-primary)] text-[var(--text-secondary)]">
                <span className="text-[11px] font-medium">{userName.charAt(0).toUpperCase()}</span>
              </div>
              <span className="truncate text-[13px] font-medium text-[var(--sidebar-text-active)]">
                {userName}
              </span>
            </div>
            {userRoles.length > 0 && (
              <div className="mt-1.5 flex flex-wrap gap-1 pl-9">
                {userRoles.slice(0, 3).map((role) => (
                  <span
                    key={role}
                    className="inline-block rounded-sm bg-[var(--bg-primary)] px-1.5 py-0.5 text-[10px] leading-tight text-[var(--sidebar-text)]"
                  >
                    {role}
                  </span>
                ))}
                {userRoles.length > 3 && (
                  <span className="text-[10px] text-[var(--sidebar-text)]">
                    +{userRoles.length - 3}
                  </span>
                )}
              </div>
            )}
          </div>
        )}
        {collapsed && (
          <div className="flex justify-center mb-2">
            <div className="flex size-7 items-center justify-center rounded-full border border-[var(--border)] bg-[var(--bg-primary)] text-[var(--text-secondary)]">
              <span className="text-[11px] font-medium">{userName.charAt(0).toUpperCase()}</span>
            </div>
          </div>
        )}
        <div className="flex flex-col gap-0.5">
          {workspaceId && (
            <Link
              href="/workspace"
              className={cn(
                "flex items-center gap-2 rounded-md px-2.5 py-2 md:py-1.5 text-[12px] transition-colors text-[var(--sidebar-text)] hover:bg-[var(--sidebar-hover)] hover:text-[var(--sidebar-text-active)]",
                collapsed && "justify-center"
              )}
              onClick={closeMobile}
              title={collapsed ? "切換工作空間" : undefined}
            >
              <LayoutDashboard size={14} className="shrink-0" />
              {!collapsed && "切換工作空間"}
            </Link>
          )}
          <button
            onClick={handleLogout}
            className={cn(
              "flex w-full items-center gap-2 rounded-md px-2.5 py-2 md:py-1.5 text-[12px] transition-colors text-[var(--text-muted)] hover:bg-[var(--sidebar-hover)] hover:text-[var(--danger)]",
              collapsed && "justify-center"
            )}
            title={collapsed ? "登出" : undefined}
          >
            <LogOut size={14} className="shrink-0" />
            {!collapsed && "登出"}
          </button>
        </div>
      </div>
    </>
  );

  return (
    <>
      {/* 手機版漢堡選單按鈕 — flat, no shadow */}
      <button
        onClick={() => setMobileOpen(true)}
        aria-label="開啟選單"
        className="fixed top-3 left-3 z-40 rounded-md border border-[var(--border)] bg-[var(--bg-primary)] p-2 md:hidden"
      >
        <Menu size={18} />
      </button>

      {/* 桌面版收合狀態下的展開按鈕 */}
      {collapsed && (
        <button
          onClick={toggleCollapsed}
          aria-label="展開選單"
          className="fixed top-3 left-3 z-30 hidden rounded-md border border-[var(--border)] bg-[var(--bg-primary)] p-2 md:block"
          title="展開選單"
        >
          <PanelLeftOpen size={18} />
        </button>
      )}

      {/* 手機版遮罩 — solid ink overlay, no backdrop blur (anti-glass) */}
      {mobileOpen && (
        <div
          className="fixed inset-0 z-40 bg-[var(--bg-inverse)]/60 md:hidden animate-fade-in"
          onClick={closeMobile}
        />
      )}

      {/* Sidebar */}
      <aside
        className={cn(
          "fixed inset-y-0 left-0 z-50 flex flex-col border-r border-[var(--sidebar-border)] bg-[var(--sidebar-bg)] transition-[width,transform] duration-200 ease-out",
          // 手機版
          mobileOpen ? "translate-x-0" : "-translate-x-full",
          // 桌面版
          "md:static md:translate-x-0",
          collapsed ? "md:w-14" : "md:w-60",
          // 手機版固定寬度
          "w-64"
        )}
      >
        {navContent}
      </aside>
    </>
  );
}
