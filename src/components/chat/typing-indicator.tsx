"use client";

/**
 * TypingIndicator — TG-style "xxx is typing…" line with animated dots.
 *
 * Pure presentational. Renders nothing when there are no typers.
 * Pass it the array from useTypingIndicator; it takes care of the
 * multi-user wording ("A & B are typing…", "A, B & 2 more…").
 */

import { cn } from "@/lib/utils";

type Typer = {
  platformUserId: string;
  displayName: string | null;
};

export function TypingIndicator({
  typers,
  groupLabel,
  className,
}: {
  typers: Typer[];
  /** Optional prefix, e.g. group title — renders as "[Group] X 正在輸入…". */
  groupLabel?: string | null;
  className?: string;
}) {
  if (typers.length === 0) return null;

  const names = typers.map((t) => t.displayName || "匿名");
  let label: string;
  if (names.length === 1) label = `${names[0]} 正在輸入`;
  else if (names.length === 2) label = `${names[0]} 與 ${names[1]} 正在輸入`;
  else label = `${names[0]}、${names[1]} 與其他 ${names.length - 2} 人正在輸入`;

  return (
    <div
      className={cn(
        "flex items-center gap-1.5 text-[11px] text-[var(--muted-foreground)]",
        className,
      )}
      aria-live="polite"
    >
      <Dots />
      {groupLabel && (
        <span className="max-w-[12rem] truncate rounded bg-[var(--muted)] px-1.5 py-px text-[10px] font-medium text-[var(--foreground)]">
          {groupLabel}
        </span>
      )}
      <span className="truncate">{label}…</span>
    </div>
  );
}

// TG's typing dot animation — three dots rising in sequence.
function Dots() {
  return (
    <span className="inline-flex gap-0.5" aria-hidden="true">
      <span className="size-1 animate-[typing-bounce_1.2s_infinite] rounded-full bg-current [animation-delay:0ms]" />
      <span className="size-1 animate-[typing-bounce_1.2s_infinite] rounded-full bg-current [animation-delay:150ms]" />
      <span className="size-1 animate-[typing-bounce_1.2s_infinite] rounded-full bg-current [animation-delay:300ms]" />
      {/* Keyframes are declared globally in app/globals.css so we can keep
          the component framework-agnostic. */}
    </span>
  );
}
