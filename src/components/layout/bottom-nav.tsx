"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  ClipboardCheck,
  ListTodo,
  Settings,
} from "lucide-react";
import { cn } from "@/lib/utils";

type BottomNavProps = {
  workspaceId: string;
};

export function BottomNav({ workspaceId }: BottomNavProps) {
  const pathname = usePathname();
  const wsBase = `/workspace/${workspaceId}`;

  const items = [
    {
      label: "主控台",
      href: wsBase,
      icon: LayoutDashboard,
      match: (p: string) => p === wsBase,
    },
    {
      label: "佇列",
      href: `${wsBase}/review`,
      icon: ClipboardCheck,
      match: (p: string) => p.startsWith(`${wsBase}/review`),
    },
    {
      label: "公佈欄",
      href: `${wsBase}/board`,
      icon: ListTodo,
      match: (p: string) => p.startsWith(`${wsBase}/board`),
    },
    {
      label: "管理",
      href: `${wsBase}/roles`,
      icon: Settings,
      match: (p: string) =>
        p.startsWith(`${wsBase}/roles`) ||
        p.startsWith(`${wsBase}/members`) ||
        p.startsWith(`${wsBase}/accounts`) ||
        p.startsWith(`${wsBase}/audit`) ||
        p.startsWith(`${wsBase}/groups`) ||
        p.startsWith(`${wsBase}/schedules`) ||
        p.startsWith(`${wsBase}/pairings`),
    },
  ];

  return (
    <nav className="fixed bottom-0 left-0 right-0 z-40 border-t border-[var(--border)] bg-[var(--card)]/95 backdrop-blur-xl pb-[env(safe-area-inset-bottom)] md:hidden shadow-[0_-1px_12px_rgba(0,0,0,0.04)]">
      <div className="flex items-center justify-around px-1">
        {items.map((item) => {
          const isActive = item.match(pathname);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "relative flex flex-1 flex-col items-center gap-0.5 px-1 py-2 text-[11px] font-medium transition-all duration-150",
                isActive
                  ? "text-[var(--primary)]"
                  : "text-[var(--muted-foreground)] active:text-[var(--foreground)]"
              )}
            >
              {isActive && (
                <span className="absolute -top-px left-1/2 -translate-x-1/2 h-0.5 w-8 rounded-full bg-[var(--primary)]" />
              )}
              <item.icon
                size={21}
                className={cn(
                  "shrink-0 transition-all duration-150",
                  isActive && "scale-110"
                )}
              />
              <span className="mt-0.5">{item.label}</span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
