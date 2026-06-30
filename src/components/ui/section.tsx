// 注意：故意不寫 "use client"。
// Section 是純佈局元件（無 hooks / 無 event handler），標成「universal 共享元件」
// 可以同時被 Server Component 和 Client Component 引用而不踩 RSC 邊界 bug。
//
// 為什麼這個重要：page.tsx 是 Server Component，當它寫 <Section icon={<ClipboardList />}>
// 時，如果 Section 是 Client Component，React 19 + Turbopack 在跨界傳 lucide forwardRef
// 元件時會把 svg 元素誤認為元件型別，產生「got: <svg />」執行期錯誤。
// 共享元件直接被 page.tsx 同 server context 渲染，沒有跨界問題。

/**
 * Section — visual container for a page's major module.
 *
 * Design system (spec 2026-04-24 "模塊區分"):
 *
 *   Page ─┬─ Section (module)                  ← this component
 *         │    ├─ SectionRow (sub-module)      ← SectionRow below
 *         │    ├─ SectionRow
 *         │    └─ ...
 *         └─ Section
 *
 * Modernist minimalism choices:
 *   • rounded-xl (bigger radius feels current, not 2015 flat)
 *   • single hairline border, no box-shadow by default
 *   • optional 3px left accent stripe — the cleanest way to differentiate
 *     modules on a long page without competing with content
 *   • header bar has a subtle bg tint when accent is set (ties the stripe
 *     to the title visually)
 *   • no icon background plate — icon sits inline with title, size-matched
 */

import * as React from "react";
import { type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * 同時支援兩種 icon 寫法：
 * - LucideIcon 函式參考（client 元件用 `icon={Foo}`）
 * - 已渲染的 ReactElement（server 元件用 `icon={<Foo />}`，避免 RSC 跨界傳函式問題）
 */
function renderSectionIcon(icon: LucideIcon | React.ReactElement): React.ReactNode {
  // 已是 ReactElement → 直接渲染
  if (React.isValidElement(icon)) {
    return icon;
  }
  // 否則當成元件函式來呼叫
  const Icon = icon as LucideIcon;
  return (
    <Icon
      className="size-4 shrink-0 text-[var(--muted-foreground)]"
      strokeWidth={2}
    />
  );
}

const ACCENT_STYLES = {
  none: { bar: "", tint: "" },
  blue: { bar: "before:bg-blue-500", tint: "bg-blue-500/[0.03]" },
  green: { bar: "before:bg-green-500", tint: "bg-green-500/[0.03]" },
  orange: { bar: "before:bg-orange-500", tint: "bg-orange-500/[0.03]" },
  purple: { bar: "before:bg-purple-500", tint: "bg-purple-500/[0.03]" },
  red: { bar: "before:bg-red-500", tint: "bg-red-500/[0.03]" },
  cyan: { bar: "before:bg-cyan-500", tint: "bg-cyan-500/[0.03]" },
  gray: { bar: "before:bg-gray-400", tint: "bg-gray-500/[0.03]" },
} as const;

export type SectionAccent = keyof typeof ACCENT_STYLES;

export type SectionProps = {
  title: string;
  description?: string;
  /**
   * Icon for the section header.
   * - 傳 LucideIcon（函式參考）：客戶端元件可用，Section 自動套預設樣式
   * - 傳 ReactElement（已渲染好的 JSX）：伺服器元件必須用這種，避免 Server→Client 傳函式錯誤
   */
  icon?: LucideIcon | React.ReactElement;
  /** Right-aligned actions (buttons, badges). */
  actions?: React.ReactNode;
  /** Left accent stripe — categorical marker. "none" removes the stripe. */
  accent?: SectionAccent;
  /** Class for the outer card; use for width / margin control. */
  className?: string;
  /** Class for the body region (e.g. `p-0` for flush lists). */
  bodyClassName?: string;
  children?: React.ReactNode;
};

export function Section({
  title,
  description,
  icon: Icon,
  actions,
  accent = "none",
  className,
  bodyClassName,
  children,
}: SectionProps) {
  const a = ACCENT_STYLES[accent];
  const hasAccent = accent !== "none";

  return (
    <section
      className={cn(
        "relative rounded-xl border border-[var(--border)] bg-[var(--card)]",
        // Left accent stripe (only when accent !== none)
        hasAccent &&
          `overflow-hidden before:absolute before:left-0 before:top-0 before:h-full before:w-[3px] before:content-[''] ${a.bar}`,
        className,
      )}
    >
      <header
        className={cn(
          "flex items-center justify-between gap-3 border-b border-[var(--border)] px-5 py-3",
          hasAccent && a.tint,
        )}
      >
        <div className="flex min-w-0 items-center gap-2">
          {Icon && renderSectionIcon(Icon)}
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold text-[var(--foreground)]">
              {title}
            </h2>
            {description && (
              <p className="mt-0.5 truncate text-xs text-[var(--muted-foreground)]">
                {description}
              </p>
            )}
          </div>
        </div>
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </header>
      <div className={cn("p-5", bodyClassName)}>{children}</div>
    </section>
  );
}

// ──────────────────────────────────────────────────────────────────

export type SectionRowProps = {
  /** Title label for the sub-module. */
  title?: string;
  description?: string;
  /** Optional right-aligned actions. */
  actions?: React.ReactNode;
  className?: string;
  children?: React.ReactNode;
  /** When true, no top border — use for the first SectionRow in a Section. */
  first?: boolean;
};

/**
 * SectionRow — a titled sub-module inside a `Section`.
 *
 * Visual hierarchy: a thin top divider + small label header + indented content.
 * Using `first` on the first row removes the leading divider so it doesn't
 * double up with the parent Section's header border.
 */
export function SectionRow({
  title,
  description,
  actions,
  className,
  children,
  first = false,
}: SectionRowProps) {
  return (
    <div
      className={cn(
        !first && "border-t border-[var(--border)]/60 pt-4 mt-4",
        className,
      )}
    >
      {(title || actions) && (
        <div className="mb-2 flex items-center justify-between gap-3">
          <div className="min-w-0">
            {title && (
              <h3 className="text-[11px] font-medium uppercase tracking-wider text-[var(--muted-foreground)]">
                {title}
              </h3>
            )}
            {description && (
              <p className="mt-0.5 text-xs text-[var(--muted-foreground)]">
                {description}
              </p>
            )}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </div>
      )}
      <div>{children}</div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────

/**
 * PageHeader — consistent top-of-page title area.
 *
 * Use above a set of Sections. Keeps h1 sizing + breadcrumb alignment
 * identical across pages.
 */
export function PageHeader({
  title,
  description,
  actions,
  className,
}: {
  title: string;
  description?: string;
  actions?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex items-start justify-between gap-3", className)}>
      <div className="min-w-0">
        <h1 className="text-xl font-bold tracking-tight text-[var(--foreground)]">
          {title}
        </h1>
        {description && (
          <p className="mt-0.5 text-sm text-[var(--muted-foreground)]">
            {description}
          </p>
        )}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}
