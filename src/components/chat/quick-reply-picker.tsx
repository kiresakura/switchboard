"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Loader2, Search, X } from "lucide-react";
import { cn } from "@/lib/utils";
import type { QuickReply } from "@/components/chat/quick-reply-autocomplete";

type Props = {
  workspaceId: string;
  open: boolean;
  onClose(): void;
  onSelect(reply: QuickReply): void;
};

const SCOPE_LABEL: Record<QuickReply["scope"], string> = {
  PRIVATE: "私人",
  TEAM: "團隊",
  WORKSPACE: "工作區",
};

function rankReply(reply: QuickReply, query: string): number {
  const q = query.trim().toLowerCase();
  if (!q) return 1;

  const shortcut = reply.shortcut.toLowerCase();
  const title = reply.title.toLowerCase();
  const body = reply.body.toLowerCase();
  const tags = reply.tags.map((tag) => tag.toLowerCase());

  if (shortcut.startsWith(q)) return 100;
  if (shortcut.includes(q)) return 80;
  if (title.startsWith(q)) return 60;
  if (title.includes(q)) return 50;
  if (tags.some((tag) => tag.includes(q))) return 40;
  if (body.includes(q)) return 20;
  return 0;
}

export function QuickReplyPicker({ workspaceId, open, onClose, onSelect }: Props) {
  const [replies, setReplies] = useState<QuickReply[]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const searchRef = useRef<HTMLInputElement | null>(null);

  const fetchReplies = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const res = await fetch(
        `/api/workspaces/${workspaceId}/quick-replies?scope=all`,
      );
      if (!res.ok) throw new Error("Failed to load quick replies");
      const data = await res.json();
      const list = Array.isArray(data.quickReplies) ? data.quickReplies : [];
      setReplies(list as QuickReply[]);
      setLoaded(true);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActiveIndex(0);
    requestAnimationFrame(() => searchRef.current?.focus());
    if (!loaded && !loading) void fetchReplies();
  }, [fetchReplies, loaded, loading, open]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const ranked = replies
      .map((reply) => ({ reply, rank: rankReply(reply, q) }))
      .filter((item) => !q || item.rank > 0)
      .sort((a, b) => {
        if (b.rank !== a.rank) return b.rank - a.rank;
        return a.reply.shortcut.localeCompare(b.reply.shortcut);
      });
    return ranked.map((item) => item.reply);
  }, [query, replies]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query, open]);

  const choose = useCallback(
    (reply: QuickReply) => {
      onSelect(reply);
      onClose();
    },
    [onClose, onSelect],
  );

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (visible.length === 0) return;
      setActiveIndex((index) => (index + 1) % visible.length);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      if (visible.length === 0) return;
      setActiveIndex((index) => (index - 1 + visible.length) % visible.length);
      return;
    }
    if (event.key === "Enter") {
      const selected = visible[activeIndex];
      if (!selected) return;
      event.preventDefault();
      choose(selected);
    }
  };

  if (!open) return null;

  return (
    <div
      className="absolute bottom-full left-0 z-50 mb-2 flex max-h-[min(28rem,70vh)] w-[min(30rem,calc(100vw-2rem))] flex-col overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--bg-primary)] shadow-2xl"
      role="dialog"
      aria-label="快選回覆"
      onKeyDown={onKeyDown}
    >
      <div className="flex items-center gap-2 border-b border-[var(--border)] px-3 py-2">
        <Search className="size-4 shrink-0 text-[var(--muted-foreground)]" />
        <input
          ref={searchRef}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜尋快選回覆…"
          className="min-w-0 flex-1 bg-transparent text-sm text-[var(--foreground)] outline-none placeholder:text-[var(--muted-foreground)]"
          aria-label="搜尋快選回覆"
        />
        <button
          type="button"
          className="rounded p-1 text-[var(--muted-foreground)] hover:bg-[var(--bg-secondary)] hover:text-[var(--foreground)]"
          onClick={onClose}
          aria-label="關閉快選回覆"
          title="關閉"
        >
          <X className="size-4" />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-1.5" role="listbox">
        {loading && replies.length === 0 ? (
          <div className="flex items-center gap-2 px-3 py-5 text-sm text-[var(--muted-foreground)]">
            <Loader2 className="size-4 animate-spin" />
            載入快選回覆…
          </div>
        ) : error ? (
          <div className="space-y-2 px-3 py-5 text-sm text-[var(--muted-foreground)]">
            <div>快選回覆載入失敗</div>
            <button
              type="button"
              onClick={() => void fetchReplies()}
              className="rounded-md bg-[var(--accent-bg)] px-2.5 py-1 text-xs font-medium text-[var(--accent)] hover:opacity-90"
            >
              重試
            </button>
          </div>
        ) : visible.length === 0 ? (
          <div className="px-3 py-5 text-sm text-[var(--muted-foreground)]">
            {query.trim()
              ? `沒有符合「${query.trim()}」的快選回覆`
              : "尚未建立任何快選回覆"}
          </div>
        ) : (
          <ul className="space-y-1">
            {visible.map((reply, index) => (
              <li key={reply.id}>
                <button
                  type="button"
                  role="option"
                  aria-selected={index === activeIndex}
                  onMouseEnter={() => setActiveIndex(index)}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    choose(reply);
                  }}
                  className={cn(
                    "w-full rounded-lg px-3 py-2 text-left transition-colors",
                    index === activeIndex
                      ? "bg-[var(--accent-bg)]"
                      : "hover:bg-[var(--bg-secondary)]",
                  )}
                >
                  <div className="flex items-start gap-2">
                    <span className="mt-0.5 shrink-0 font-mono text-[11px] font-medium text-[var(--accent)]">
                      /{reply.shortcut}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-[var(--foreground)]">
                        {reply.title}
                      </span>
                      <span className="mt-0.5 block line-clamp-2 whitespace-pre-wrap text-xs leading-5 text-[var(--muted-foreground)]">
                        {reply.body}
                      </span>
                      {reply.tags.length > 0 && (
                        <span className="mt-1 flex flex-wrap gap-1">
                          {reply.tags.slice(0, 4).map((tag) => (
                            <span
                              key={tag}
                              className="rounded bg-[var(--bg-secondary)] px-1.5 py-0.5 text-[10px] text-[var(--text-muted)]"
                            >
                              {tag}
                            </span>
                          ))}
                        </span>
                      )}
                    </span>
                    <span
                      className={cn(
                        "shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium",
                        reply.scope === "PRIVATE" &&
                          "bg-[var(--bg-secondary)] text-[var(--text-muted)]",
                        reply.scope === "TEAM" &&
                          "bg-[var(--accent-bg)] text-[var(--accent)]",
                        reply.scope === "WORKSPACE" &&
                          "bg-[var(--primary)]/15 text-[var(--primary)]",
                      )}
                    >
                      {SCOPE_LABEL[reply.scope]}
                    </span>
                  </div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="border-t border-[var(--border)] px-3 py-1.5 text-[10px] text-[var(--muted-foreground)]">
        ↑↓ 選 · Enter 插入 · Esc 關閉
      </div>
    </div>
  );
}
