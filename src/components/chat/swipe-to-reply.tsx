"use client";

/**
 * SwipeToReply — wraps a chat bubble and fires `onReply` when the user
 * horizontally swipes it past a threshold (Telegram convention).
 *
 * Pointer-event based so it works for touch, pen, and mouse without separate
 * handlers. The direction of the swipe that "counts" is towards the center
 * of the screen: left-side (incoming) bubbles trigger on right-swipe;
 * right-side (own) bubbles trigger on left-swipe. This matches TG exactly.
 *
 * Visual affordance: a small arrow-in-circle fades in as the user drags;
 * reaches full opacity at the threshold; release beyond threshold →
 * callback, release below threshold → snap back.
 */

import { useRef, useState } from "react";
import { Reply } from "lucide-react";
import { cn } from "@/lib/utils";

type Side = "left" | "right";

export function SwipeToReply({
  side,
  onReply,
  children,
  disabled = false,
}: {
  side: Side;
  onReply: () => void;
  children: React.ReactNode;
  disabled?: boolean;
}) {
  const [dx, setDx] = useState(0);
  const [dragging, setDragging] = useState(false);
  const startX = useRef(0);
  const pointerId = useRef<number | null>(null);

  // Positive numbers = pixels past threshold; cap so extreme drags don't
  // throw the bubble offscreen.
  const THRESHOLD = 60;
  const MAX = 100;
  // Bubble only moves in the ALLOWED direction — incoming bubbles move
  // right when pulled left, etc. We flip sign at render time.
  const allowedDirection: 1 | -1 = side === "left" ? 1 : -1;

  const onPointerDown = (e: React.PointerEvent) => {
    if (disabled) return;
    // Ignore right-click / middle-click and pen eraser.
    if (e.pointerType === "mouse" && e.button !== 0) return;
    // 不要對 interactive 子元素（按鈕、連結、文字輸入、emoji picker）啟動 swipe —
    // setPointerCapture 會把後續 pointer events 抓到外層 wrapper，導致內層
    // button 的 native click 收不到 pointerup → 整個 click 不觸發。
    // 用戶反應「點 emoji / 編輯 / 刪除 icon 完全沒反應」就是因為這個。
    const target = e.target as HTMLElement | null;
    if (
      target?.closest(
        "button, a, input, textarea, select, [role='button'], [role='menu'], [role='menuitem']",
      )
    ) {
      return;
    }
    startX.current = e.clientX;
    pointerId.current = e.pointerId;
    setDragging(true);
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!dragging || pointerId.current !== e.pointerId) return;
    const raw = e.clientX - startX.current;
    // Only allow the bubble to move in the correct direction.
    const bounded = raw * allowedDirection > 0 ? raw : 0;
    const clamped = allowedDirection === 1
      ? Math.max(0, Math.min(bounded, MAX))
      : Math.min(0, Math.max(bounded, -MAX));
    setDx(clamped);
  };

  const end = (e: React.PointerEvent) => {
    if (pointerId.current !== e.pointerId) return;
    pointerId.current = null;
    setDragging(false);
    if (Math.abs(dx) >= THRESHOLD) onReply();
    setDx(0);
  };

  // Indicator opacity ramps from 0 at start to 1 at threshold.
  const progress = Math.min(Math.abs(dx) / THRESHOLD, 1);

  return (
    <div
      className="relative touch-pan-y"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onPointerCancel={end}
    >
      {/* Reply affordance — sits just outside the bubble on the outer side
          (the side the user is swiping TOWARDS). */}
      <div
        aria-hidden="true"
        className={cn(
          "pointer-events-none absolute top-1/2 -translate-y-1/2",
          side === "left" ? "left-1" : "right-1",
        )}
        style={{
          opacity: progress,
          transform: `translateY(-50%) scale(${0.6 + progress * 0.5})`,
          transition: dragging ? "none" : "opacity 120ms, transform 120ms",
        }}
      >
        <Reply className="size-5 rounded-full bg-[var(--primary)]/80 p-0.5 text-[var(--primary-foreground)]" />
      </div>

      <div
        style={{
          transform: `translateX(${dx}px)`,
          transition: dragging ? "none" : "transform 150ms ease-out",
        }}
      >
        {children}
      </div>
    </div>
  );
}
