"use client";

/**
 * QuickReplyAutocomplete — composer 內 `/` autocomplete popover。
 *
 * 工作流程:
 *   1. 父元件偵測 textarea 輸入到「目前 token 是 /xxx」(/ 後面跟 0+ 字、不含空白),
 *      把那段 token + textarea 位置 + cursor info 傳進來。
 *   2. 本元件 lazy-fetch /api/workspaces/[ws]/quick-replies(scope=all 員工可見全部),
 *      用 filter prefix 在 client 端過濾(資料量 < 100 筆,不必 server search)。
 *   3. 鍵盤導覽 (↑↓ Enter Tab Esc) 由父元件的 onKeyDown 透過 imperative handle 觸發,
 *      避免 popover 自己搶 focus 導致 textarea 失去輸入狀態。
 *   4. 選定後 onSelect(quickReply) — 父元件用 textarea selectionStart/End 把
 *      `/<shortcut>` 整個 token 替換成 quickReply.body。
 *
 * 為何不用一般 <select> 或 radix combobox:
 *   - composer 已是受控 textarea,介面不能搶 focus
 *   - / 觸發 + token 範圍 + 替換邏輯都在 textarea 上,popover 純展示 + 鍵盤導覽
 *
 * 設計:keyboard-only when open,滑鼠 hover 也能切換選取。
 */

import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useState,
} from "react";
import { cn } from "@/lib/utils";

export type QuickReply = {
  id: string;
  shortcut: string;
  title: string;
  body: string;
  scope: "PRIVATE" | "TEAM" | "WORKSPACE";
  tags: string[];
  ownerName: string | null;
};

export type QuickReplyAutocompleteHandle = {
  /** 向上 / 向下移動選取(父元件 ↑↓ 鍵呼叫)。circular。 */
  move(direction: 1 | -1): void;
  /** 取得目前選中的 QuickReply(父元件 Enter / Tab 時呼叫)。 */
  selected(): QuickReply | null;
};

type Props = {
  workspaceId: string;
  /** 目前 textarea 中 `/` 後面的字串(不含 /)。空字串 = 顯示全部。 */
  filter: string;
  /** 是否顯示。父元件控管 open/close。 */
  open: boolean;
  onSelect(reply: QuickReply): void;
  /** Esc / 點外面 / 失焦 等都會觸發 dismiss。 */
  onClose(): void;
};

export const QuickReplyAutocomplete = forwardRef<
  QuickReplyAutocompleteHandle,
  Props
>(function QuickReplyAutocomplete(
  { workspaceId, filter, open, onSelect, onClose },
  ref,
) {
  const [replies, setReplies] = useState<QuickReply[]>([]);
  const [loading, setLoading] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);

  // Lazy fetch — 第一次 open 時拉,後續切換對話不再重拉(同 workspace 共用)。
  // 對「員工新建 QuickReply」會略過,直到 page 重整。MVP 接受。
  useEffect(() => {
    if (!open || replies.length > 0) return;
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const res = await fetch(
          `/api/workspaces/${workspaceId}/quick-replies?scope=all`,
        );
        if (!res.ok) return;
        const data = await res.json();
        if (cancelled) return;
        const list = Array.isArray(data.quickReplies) ? data.quickReplies : [];
        setReplies(list as QuickReply[]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, workspaceId, replies.length]);

  // 用 filter prefix 過濾 — 大小寫不敏感、優先 prefix-match 再退到 substring。
  // 員工輸入「/he」匹配 shortcut=hello / helper / heyguys 都要出現,
  // 排序:prefix-match shortcut 在前、shortcut 完整包含次之、title/tags 包含再次。
  const visible = useMemo(() => {
    const f = filter.toLowerCase();
    if (!f) return replies.slice(0, 20);
    const scored: Array<{ r: QuickReply; score: number }> = [];
    for (const r of replies) {
      const s = r.shortcut.toLowerCase();
      const t = r.title.toLowerCase();
      let score = 0;
      if (s.startsWith(f)) score = 100;
      else if (s.includes(f)) score = 70;
      else if (t.startsWith(f)) score = 50;
      else if (t.includes(f)) score = 30;
      else if (r.tags.some((tg) => tg.toLowerCase().includes(f))) score = 10;
      else continue;
      scored.push({ r, score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, 20).map((x) => x.r);
  }, [filter, replies]);

  // filter 改變 → 重置選取到第一個
  useEffect(() => {
    setActiveIndex(0);
  }, [filter, open]);

  useImperativeHandle(ref, () => ({
    move(direction) {
      if (visible.length === 0) return;
      setActiveIndex((i) => {
        const next = i + direction;
        if (next < 0) return visible.length - 1;
        if (next >= visible.length) return 0;
        return next;
      });
    },
    selected() {
      return visible[activeIndex] ?? null;
    },
  }));

  if (!open) return null;

  return (
    <div
      // 浮在 textarea 上方;父元件透過 relative wrapper + absolute 定位處理
      // 高度上限 + scroll;loading state 給回饋,empty state 給提示。
      className="absolute bottom-full left-0 right-0 mb-1 max-h-64 overflow-y-auto rounded-lg border border-[var(--border)] bg-[var(--bg-primary)] shadow-lg z-20"
      role="listbox"
      aria-label="快選回覆"
    >
      {loading && replies.length === 0 ? (
        <div className="px-3 py-2 text-xs text-[var(--text-muted)]">
          載入快選回覆…
        </div>
      ) : visible.length === 0 ? (
        <div className="px-3 py-2 text-xs text-[var(--text-muted)]">
          {filter
            ? `沒有符合「/${filter}」的快選回覆`
            : "尚未建立任何快選回覆"}
          <span className="ml-1 opacity-70">— 側邊欄「快選回覆」可新增</span>
        </div>
      ) : (
        <ul>
          {visible.map((r, i) => (
            <li key={r.id}>
              <button
                type="button"
                role="option"
                aria-selected={i === activeIndex}
                onMouseEnter={() => setActiveIndex(i)}
                onMouseDown={(e) => {
                  // 用 mousedown 而非 click — click 會被 textarea blur 搶先觸發 onClose。
                  e.preventDefault();
                  onSelect(r);
                }}
                className={cn(
                  "w-full text-left px-3 py-2 flex items-start gap-2",
                  i === activeIndex
                    ? "bg-[var(--accent-bg)]"
                    : "hover:bg-[var(--bg-secondary)]/40",
                )}
              >
                <span className="shrink-0 mt-0.5 font-mono text-[11px] text-[var(--accent)]">
                  /{r.shortcut}
                </span>
                <span className="flex-1 min-w-0">
                  <span className="block text-sm font-medium text-[var(--foreground)] truncate">
                    {r.title}
                  </span>
                  <span className="block text-xs text-[var(--text-muted)] line-clamp-2 whitespace-pre-wrap">
                    {r.body}
                  </span>
                </span>
                {/* scope chip — 員工一眼看出這條是 私人 / 團隊 / 工作區 共享 */}
                <span
                  className={cn(
                    "shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium",
                    r.scope === "PRIVATE" && "bg-[var(--bg-secondary)] text-[var(--text-muted)]",
                    r.scope === "TEAM" && "bg-[var(--accent-bg)] text-[var(--accent)]",
                    r.scope === "WORKSPACE" && "bg-[var(--primary)]/15 text-[var(--primary)]",
                  )}
                >
                  {r.scope === "PRIVATE" ? "私人" : r.scope === "TEAM" ? "團隊" : "工作區"}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="border-t border-[var(--border)] px-3 py-1.5 text-[10px] text-[var(--text-muted)] flex items-center justify-between">
        <span>↑↓ 選 · Enter / Tab 插入 · Esc 取消</span>
        <button
          type="button"
          onMouseDown={(e) => {
            e.preventDefault();
            onClose();
          }}
          className="hover:text-[var(--foreground)]"
        >
          ✕
        </button>
      </div>
    </div>
  );
});
