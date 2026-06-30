"use client";

/**
 * ScrollToBottomFAB — Telegram-style floating action button that:
 *   1. Shows up when the user scrolls away from the bottom of a chat
 *   2. Displays an unread counter for messages that arrived while away
 *   3. Returns the user to the bottom on click
 *
 * Uses an IntersectionObserver on a sentinel at the list tail to cheaply
 * detect "at bottom" without binding a scroll listener. The component is
 * layout-only — the caller owns the scrollable container and the unread
 * count state (reset when the sentinel intersects).
 */

import { useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

export type ScrollToBottomFABProps = {
  /** Ref to the scrollable container holding the chat list. */
  scrollRef: React.RefObject<HTMLElement | null>;
  /** Current unread count — controlled by the parent. Render as badge. */
  unreadCount?: number;
  /** Called when the user's latest view reaches the bottom (atBottom=true). */
  onReachBottom?: () => void;
  /** Called when the user leaves the bottom (atBottom=false). */
  onLeaveBottom?: () => void;
  className?: string;
};

export function ScrollToBottomFAB({
  scrollRef,
  unreadCount = 0,
  onReachBottom,
  onLeaveBottom,
  className,
}: ScrollToBottomFABProps) {
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const [atBottom, setAtBottom] = useState(true);

  // Mount a sentinel div at the end of the scroll container and observe it.
  useEffect(() => {
    const container = scrollRef.current;
    const sentinel = sentinelRef.current;
    if (!container || !sentinel) return;

    // Ensure the sentinel sits at the very bottom of the scrollable content,
    // so IntersectionObserver fires only when it's in view.
    container.appendChild(sentinel);

    const observer = new IntersectionObserver(
      (entries) => {
        const atBottomNow = entries[0]?.isIntersecting ?? false;
        setAtBottom(atBottomNow);
        if (atBottomNow) onReachBottom?.();
        else onLeaveBottom?.();
      },
      {
        root: container,
        // A bit of slack so "nearly at bottom" still counts as at bottom
        // (TG does the same — the FAB doesn't fight small scroll twitches).
        rootMargin: "0px 0px 150px 0px",
        threshold: 0,
      },
    );
    observer.observe(sentinel);

    return () => {
      observer.disconnect();
      if (sentinel.parentNode === container) container.removeChild(sentinel);
    };
  }, [scrollRef, onLeaveBottom, onReachBottom]);

  const scrollToBottom = () => {
    const container = scrollRef.current;
    if (!container) return;
    container.scrollTo({ top: container.scrollHeight, behavior: "smooth" });
  };

  return (
    <>
      <div ref={sentinelRef} aria-hidden="true" className="h-px w-full" />
      <button
        onClick={scrollToBottom}
        aria-label={unreadCount > 0 ? `回到最新訊息（${unreadCount} 則未讀）` : "回到最新訊息"}
        className={cn(
          "absolute bottom-4 right-4 z-20 flex size-11 items-center justify-center rounded-full border border-[var(--border)] bg-[var(--card)] text-[var(--foreground)] shadow-lg transition-all duration-200",
          "hover:scale-105 hover:shadow-xl",
          atBottom ? "pointer-events-none translate-y-4 opacity-0" : "translate-y-0 opacity-100",
          className,
        )}
      >
        <ChevronDown className="size-5" strokeWidth={2.5} />
        {unreadCount > 0 && (
          <span className="absolute -top-1 -right-1 min-w-[20px] rounded-full bg-[var(--primary)] px-1.5 py-0.5 text-center text-[10px] font-bold leading-none text-[var(--primary-foreground)] shadow-sm">
            {unreadCount > 99 ? "99+" : unreadCount}
          </span>
        )}
      </button>
    </>
  );
}
