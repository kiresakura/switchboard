import Link from "next/link";
import { redirect } from "next/navigation";
import { Users, Building2, ChevronRight } from "lucide-react";
import { getSession } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

// 全域系統設定首頁：列出所有可用的系統管理功能。
// 目前只有「系統帳號管理」、「工作空間管理」是 active；其他卡片是預留位置，
// 用 disabled state 顯示，告訴使用者「之後會有」，避免之後加新功能時 layout 大改。
type AdminSection = {
  key: string;
  title: string;
  description: string;
  href: string | null; // null = 尚未實作
  icon: typeof Users;
  status?: "active" | "coming-soon";
};

const SECTIONS: AdminSection[] = [
  {
    key: "users",
    title: "系統帳號管理",
    description: "管理所有系統帳號、權限與工作空間指派",
    href: "/admin/users",
    icon: Users,
    status: "active",
  },
  {
    key: "workspaces",
    title: "工作空間管理",
    description: "建立、編輯、停用工作空間（多團隊隔離）",
    href: "/admin/workspaces",
    icon: Building2,
    status: "active",
  },
  // 之後新增的全域設定（例：稽核日誌保留期、SMTP、推播設定…）擺在這裡：
  // { key: "audit-retention", title: "稽核日誌設定", description: "...", href: null, icon: ..., status: "coming-soon" },
];

export default async function AdminLandingPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  if (!session.user.isSystemAdmin) redirect("/workspace");

  return (
    <div className="mx-auto max-w-5xl space-y-6 animate-fade-in">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-[var(--foreground)]">
          全域系統設定
        </h1>
        <p className="mt-0.5 text-sm text-[var(--muted-foreground)]">
          系統層級管理（跨所有工作空間）
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {SECTIONS.map((s) => {
          const Icon = s.icon;
          const disabled = s.href === null || s.status === "coming-soon";
          const Inner = (
            <div
              className={
                "group flex h-full flex-col gap-2 rounded-xl border border-[var(--border)] bg-[var(--card)] p-4 transition-[box-shadow,border-color] duration-200 " +
                (disabled
                  ? "opacity-60"
                  : "hover:border-[var(--primary)]/40 hover:shadow-md cursor-pointer")
              }
            >
              <div className="flex items-start justify-between">
                <div className="flex size-10 items-center justify-center rounded-lg bg-[var(--primary)]/10">
                  <Icon className="size-5 text-[var(--primary)]" />
                </div>
                {disabled && (
                  <span className="rounded-full bg-[var(--muted)] px-2 py-0.5 text-[10px] font-medium text-[var(--muted-foreground)]">
                    敬請期待
                  </span>
                )}
                {!disabled && (
                  <ChevronRight className="size-4 text-[var(--muted-foreground)] group-hover:text-[var(--primary)] transition-colors" />
                )}
              </div>
              <div>
                <h3 className="text-sm font-semibold text-[var(--foreground)]">
                  {s.title}
                </h3>
                <p className="mt-1 text-xs text-[var(--muted-foreground)]">
                  {s.description}
                </p>
              </div>
            </div>
          );

          if (disabled) {
            return (
              <div key={s.key}>{Inner}</div>
            );
          }
          return (
            <Link key={s.key} href={s.href as string} className="block">
              {Inner}
            </Link>
          );
        })}
      </div>
    </div>
  );
}
