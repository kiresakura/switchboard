"use client";

import { useState } from "react";
import { HandIcon, Sparkles, Zap, ChevronDown, Info } from "lucide-react";
import { cn } from "@/lib/utils";

export type ReviewLevel = "L0" | "L1" | "L_AUTO";

type LevelMeta = {
  value: ReviewLevel;
  label: string;
  subtitle: string;
  description: string;
  behavior: {
    autoForward: string;
    enterReview: string;
    showSuggestion: string;
  };
  useCase: string;
  Icon: typeof HandIcon;
  /** Tailwind utility base — picks the text/border/bg classes */
  tone: "amber" | "blue" | "green";
};

export const REVIEW_LEVELS: readonly LevelMeta[] = [
  {
    value: "L0",
    label: "L0 全人工審核",
    subtitle: "所有訊息都需人工放行",
    description:
      "每則訊息都進入審核佇列，規則完全不執行。審核員逐則決定放行/攔截。最安全，流量大時最慢。",
    behavior: {
      autoForward: "不會",
      enterReview: "全部",
      showSuggestion: "不顯示",
    },
    useCase: "新開通的配對、高敏感通道、或規則尚未設定完成",
    Icon: HandIcon,
    tone: "amber",
  },
  {
    value: "L1",
    label: "L1 半自動（規則建議）",
    subtitle: "規則評估但不執行，由審核員決定",
    description:
      "訊息仍全部進入審核佇列；規則評估結果顯示為系統建議（放行 / 攔截 + 原因），審核員可一鍵採納或覆蓋。用於驗證規則準確度。",
    behavior: {
      autoForward: "不會",
      enterReview: "全部（附建議）",
      showSuggestion: "顯示（可採納 / 覆蓋）",
    },
    useCase: "規則調校期、驗證規則命中率、準備升級到 L_AUTO 之前",
    Icon: Sparkles,
    tone: "blue",
  },
  {
    value: "L_AUTO",
    label: "L_AUTO 全自動",
    subtitle: "規則直接執行",
    description:
      "符合規則的訊息自動轉發到目標群組；觸發規則（方向限制、敏感詞、auto-reject pattern）的才進入審核佇列。",
    behavior: {
      autoForward: "符合規則時自動",
      enterReview: "僅觸發規則時",
      showSuggestion: "不顯示（直接執行）",
    },
    useCase: "規則已驗證穩定、大量或常規流量的配對",
    Icon: Zap,
    tone: "green",
  },
] as const;

const TONE_CLASSES: Record<LevelMeta["tone"], {
  badge: string;
  iconBg: string;
  iconText: string;
  cardActive: string;
  cardIdle: string;
}> = {
  amber: {
    badge: "bg-amber-50 text-amber-700 border-amber-200",
    iconBg: "bg-amber-100",
    iconText: "text-amber-600",
    cardActive: "border-amber-400 bg-amber-50/50 ring-2 ring-amber-200",
    cardIdle: "border-[var(--border)] hover:border-amber-200",
  },
  blue: {
    badge: "bg-blue-50 text-blue-700 border-blue-200",
    iconBg: "bg-blue-100",
    iconText: "text-blue-600",
    cardActive: "border-blue-400 bg-blue-50/50 ring-2 ring-blue-200",
    cardIdle: "border-[var(--border)] hover:border-blue-200",
  },
  green: {
    badge: "bg-emerald-50 text-emerald-700 border-emerald-200",
    iconBg: "bg-emerald-100",
    iconText: "text-emerald-600",
    cardActive: "border-emerald-400 bg-emerald-50/50 ring-2 ring-emerald-200",
    cardIdle: "border-[var(--border)] hover:border-emerald-200",
  },
};

export function getReviewLevelMeta(value: string | null | undefined): LevelMeta {
  return REVIEW_LEVELS.find((l) => l.value === value) ?? REVIEW_LEVELS[0];
}

// ──────────────────────────────────────────────────────────────
// Badge — compact pill for list / read-only views, tooltip on hover
// ──────────────────────────────────────────────────────────────

export function ReviewLevelBadge({
  level,
  size = "sm",
}: {
  level: string | null | undefined;
  size?: "xs" | "sm";
}) {
  const meta = getReviewLevelMeta(level);
  const tone = TONE_CLASSES[meta.tone];
  const sizing = size === "xs"
    ? "px-1.5 py-0.5 text-[10px]"
    : "px-2 py-0.5 text-xs";
  return (
    <span
      title={`${meta.label} — ${meta.subtitle}`}
      className={cn(
        "inline-flex items-center gap-1 rounded-full border font-medium",
        sizing,
        tone.badge,
      )}
    >
      <meta.Icon className={size === "xs" ? "size-2.5" : "size-3"} />
      {meta.value}
    </span>
  );
}

// ──────────────────────────────────────────────────────────────
// Selector — card-based radio group for edit mode
// ──────────────────────────────────────────────────────────────

export function ReviewLevelSelector({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (next: ReviewLevel) => void;
  disabled?: boolean;
}) {
  return (
    <div className="space-y-2" role="radiogroup" aria-label="審核等級">
      {REVIEW_LEVELS.map((meta) => {
        const active = value === meta.value;
        const tone = TONE_CLASSES[meta.tone];
        return (
          <button
            key={meta.value}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={disabled}
            onClick={() => onChange(meta.value)}
            className={cn(
              "w-full rounded-lg border p-3 text-left transition-all",
              active ? tone.cardActive : tone.cardIdle,
              disabled && "opacity-60 cursor-not-allowed",
            )}
          >
            <div className="flex items-start gap-3">
              <div
                className={cn(
                  "mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md",
                  tone.iconBg,
                )}
              >
                <meta.Icon className={cn("size-4", tone.iconText)} />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold text-[var(--foreground)]">
                    {meta.label}
                  </span>
                  {active && (
                    <span className={cn("rounded-full px-1.5 py-0.5 text-[10px] border", tone.badge)}>
                      目前
                    </span>
                  )}
                </div>
                <p className="mt-0.5 text-xs text-[var(--muted-foreground)]">
                  {meta.subtitle}
                </p>
                <p className="mt-1.5 text-xs leading-relaxed text-[var(--foreground)]">
                  {meta.description}
                </p>
                <div className="mt-2 grid grid-cols-1 gap-1 text-[11px] text-[var(--muted-foreground)] sm:grid-cols-3">
                  <div>自動轉發：<span className="text-[var(--foreground)]">{meta.behavior.autoForward}</span></div>
                  <div>進入審核：<span className="text-[var(--foreground)]">{meta.behavior.enterReview}</span></div>
                  <div>系統建議：<span className="text-[var(--foreground)]">{meta.behavior.showSuggestion}</span></div>
                </div>
                <p className="mt-1.5 text-[11px] text-[var(--muted-foreground)]">
                  <span className="font-medium">適用情境：</span>{meta.useCase}
                </p>
              </div>
            </div>
          </button>
        );
      })}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────
// Guide — collapsible comparison table, drop anywhere as a help block
// ──────────────────────────────────────────────────────────────

export function ReviewLevelGuide({ defaultOpen = false }: { defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--muted)]/40">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs font-medium text-[var(--foreground)] hover:bg-[var(--bg-secondary)]/50"
      >
        <Info className="size-3.5 text-[var(--muted-foreground)]" />
        審核等級是什麼？看三個等級的比較
        <ChevronDown className={cn("ml-auto size-4 transition-transform", open && "rotate-180")} />
      </button>
      {open && (
        <div className="border-t border-[var(--border)] p-3">
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-[var(--border)] text-left text-[var(--muted-foreground)]">
                  <th className="pb-2 pr-3 font-medium">等級</th>
                  <th className="pb-2 pr-3 font-medium">自動轉發</th>
                  <th className="pb-2 pr-3 font-medium">進入審核</th>
                  <th className="pb-2 pr-3 font-medium">系統建議</th>
                  <th className="pb-2 font-medium">適用情境</th>
                </tr>
              </thead>
              <tbody>
                {REVIEW_LEVELS.map((meta) => (
                  <tr key={meta.value} className="border-b border-[var(--border)]/50 last:border-0">
                    <td className="py-2 pr-3">
                      <ReviewLevelBadge level={meta.value} />
                    </td>
                    <td className="py-2 pr-3 text-[var(--foreground)]">{meta.behavior.autoForward}</td>
                    <td className="py-2 pr-3 text-[var(--foreground)]">{meta.behavior.enterReview}</td>
                    <td className="py-2 pr-3 text-[var(--foreground)]">{meta.behavior.showSuggestion}</td>
                    <td className="py-2 text-[var(--muted-foreground)]">{meta.useCase}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-3 text-[11px] text-[var(--muted-foreground)]">
            提示：建議新配對從 <span className="font-medium">L0</span> 開始累積規則，調到 <span className="font-medium">L1</span> 驗證命中率，確認穩定後才切 <span className="font-medium">L_AUTO</span>。
          </p>
        </div>
      )}
    </div>
  );
}
