"use client";

/**
 * VirtualChatList — TG-style chat scroller on top of react-virtuoso.
 *
 * Handles the annoying-but-essential chat list behaviors:
 *   - "Stick to bottom" when new messages arrive AND the user was already at
 *     the bottom. If they've scrolled up, new messages don't jerk them back.
 *   - Scroll-to-bottom FAB with live unread counter.
 *   - Infinite scroll upwards when `onLoadOlder` is supplied (reaches top).
 *   - Smooth initial scroll to the newest message on mount.
 *
 * The caller provides `items[]` sorted oldest → newest and a `renderItem`
 * function. Height per item is measured automatically by virtuoso.
 */

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import { ScrollToBottomFAB } from "./scroll-to-bottom";

export type VirtualChatListProps<T> = {
  items: T[];
  /** Stable key for each item (used to detect new arrivals). */
  getItemKey: (item: T) => string;
  renderItem: (item: T, index: number) => React.ReactNode;
  /** Called when the scroller reaches the top — typically load older messages. */
  onLoadOlder?: () => void;
  /** When true, disables the load-older trigger (e.g. still fetching). */
  loadingOlder?: boolean;
  /** ClassName for the outer wrapper. The wrapper is relative+overflow-hidden. */
  className?: string;
  /** Render before the first message, e.g. a "load older" spinner. */
  topSlot?: React.ReactNode;
};

/**
 * 暴露給外部的 imperative API。用 forwardRef + useImperativeHandle 是因為
 * jump-to-reply / in-chat search 需要主動把指定訊息捲到視野中,純宣告 props
 * 表達不出來。Virtuoso 自己的 ref 不暴露,我們在中間包一層只露 `scrollToKey`。
 */
export type VirtualChatListHandle = {
  /** 找到對應 key 的 item 並 smooth-scroll 到該 row。找不到就 no-op。 */
  scrollToKey: (key: string, options?: { align?: "start" | "center" | "end" }) => void;
};

function VirtualChatListInner<T>(
  {
    items,
    getItemKey,
    renderItem,
    onLoadOlder,
    loadingOlder,
    className,
    topSlot,
  }: VirtualChatListProps<T>,
  forwardedRef: React.ForwardedRef<VirtualChatListHandle>,
) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const virtuosoRef = useRef<VirtuosoHandle | null>(null);

  const [atBottom, setAtBottom] = useState(true);
  const [unread, setUnread] = useState(0);
  const prevLastKey = useRef<string | null>(null);

  // Track unread count: new tail items that arrived while NOT at bottom.
  useEffect(() => {
    if (items.length === 0) {
      prevLastKey.current = null;
      return;
    }
    const newest = getItemKey(items[items.length - 1]);
    if (prevLastKey.current === null) {
      prevLastKey.current = newest;
      return;
    }
    if (newest !== prevLastKey.current) {
      // Count how many new items appended since last seen tail.
      const lastIndex = items.findIndex((it) => getItemKey(it) === prevLastKey.current);
      const added = lastIndex >= 0 ? items.length - 1 - lastIndex : 1;
      // eslint-disable-next-line react-hooks/set-state-in-effect -- counter derived from external prop changes
      if (!atBottom && added > 0) setUnread((n) => n + added);
      prevLastKey.current = newest;
    }
  }, [items, getItemKey, atBottom]);

  const followOutput: "smooth" | "auto" | false = useMemo(
    () => (atBottom ? "smooth" : false),
    [atBottom],
  );

  const onStartReached = useCallback(() => {
    if (!onLoadOlder || loadingOlder) return;
    onLoadOlder();
  }, [onLoadOlder, loadingOlder]);

  useImperativeHandle(
    forwardedRef,
    () => ({
      scrollToKey: (key, options) => {
        const idx = items.findIndex((it) => getItemKey(it) === key);
        if (idx < 0) return;
        virtuosoRef.current?.scrollToIndex({
          index: idx,
          behavior: "smooth",
          align: options?.align ?? "center",
        });
      },
    }),
    [items, getItemKey],
  );

  return (
    <div
      className={`relative h-full w-full overflow-hidden ${className ?? ""}`}
      ref={scrollRef}
    >
      <Virtuoso
        ref={virtuosoRef}
        data={items}
        followOutput={followOutput}
        initialTopMostItemIndex={items.length > 0 ? items.length - 1 : 0}
        startReached={onStartReached}
        increaseViewportBy={{ top: 600, bottom: 600 }}
        atBottomStateChange={(b) => {
          setAtBottom(b);
          if (b) setUnread(0);
        }}
        itemContent={(index, item) => (
          <div key={getItemKey(item)} className="px-2">
            {renderItem(item, index)}
          </div>
        )}
        components={{
          Header: () => (topSlot ? <div className="px-2 py-2">{topSlot}</div> : null),
          Footer: () => <div className="h-4" />,
        }}
        className="h-full"
        style={{ height: "100%" }}
      />

      <FABWrapper
        atBottom={atBottom}
        unread={unread}
        onClick={() => {
          virtuosoRef.current?.scrollToIndex({
            index: items.length - 1,
            behavior: "smooth",
          });
          setUnread(0);
        }}
      />
    </div>
  );
}

/**
 * forwardRef + 泛型在 TS 裡需要 cast 一次型別。runtime 行為跟 VirtualChatListInner
 * 完全相同,只是 React.forwardRef 的 type 推論會把 T 吃成 unknown。
 */
export const VirtualChatList = forwardRef(VirtualChatListInner) as <T>(
  props: VirtualChatListProps<T> & {
    ref?: React.ForwardedRef<VirtualChatListHandle>;
  },
) => React.ReactElement | null;

// Virtuoso replaces the scroll container internally, so we render our FAB
// as an absolutely positioned sibling rather than relying on ScrollToBottomFAB
// observing the Virtuoso container. We still import the component's visuals
// by rendering a parallel button with the same styling.
function FABWrapper({
  atBottom,
  unread,
  onClick,
}: {
  atBottom: boolean;
  unread: number;
  onClick: () => void;
}) {
  if (atBottom) return null;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={unread > 0 ? `回到最新訊息（${unread} 則未讀）` : "回到最新訊息"}
      className="absolute bottom-4 right-4 z-20 flex size-11 items-center justify-center rounded-full border border-[var(--border)] bg-[var(--card)] text-[var(--foreground)] shadow-lg transition-transform hover:scale-105 hover:shadow-xl"
    >
      <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="m6 9 6 6 6-6" />
      </svg>
      {unread > 0 && (
        <span className="absolute -top-1 -right-1 min-w-[20px] rounded-full bg-[var(--primary)] px-1.5 py-0.5 text-center text-[10px] font-bold leading-none text-[var(--primary-foreground)] shadow-sm">
          {unread > 99 ? "99+" : unread}
        </span>
      )}
    </button>
  );
}

// Re-export for direct usage (non-virtualized lists can reuse this FAB).
export { ScrollToBottomFAB };
