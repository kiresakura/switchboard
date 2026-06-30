"use client";

/**
 * BroadcastPanel — slide-in overlay for composing + sending group broadcasts.
 *
 * Features:
 *  - Group selector with 私聊 / 群組 tabs + name search + select-all
 *  - Textarea composer (same styling as main chat)
 *  - Optional schedule datetime (reuses TG scheduled message path)
 *  - Per-group result toast after send
 */
import { useState, useCallback, useMemo, useRef, useEffect } from "react";
import { X, Search, CheckSquare, Square, Send, Clock, Users, MessageSquare } from "lucide-react";
import { cn } from "@/lib/utils";

export type BroadcastGroup = {
  id: string;
  title: string;
  chatType: "GROUP" | "PRIVATE" | "CHANNEL";
  customerName?: string;
  tags?: string[];
  lastMessage?: { timestamp: string } | null;
};

type Props = {
  workspaceId: string;
  groups: BroadcastGroup[];
  accounts: { id: string; displayName: string }[];
  defaultAccountId: string;
  onClose: () => void;
  onSuccess?: (successCount: number, total: number) => void;
};

type BroadcastTab = "private" | "group";
type SendState = "idle" | "sending" | "done" | "error";

export default function BroadcastPanel({
  workspaceId,
  groups,
  accounts,
  defaultAccountId,
  onClose,
  onSuccess,
}: Props) {
  const [tab, setTab] = useState<BroadcastTab>("private");
  const [nameFilter, setNameFilter] = useState("");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [accountId, setAccountId] = useState(defaultAccountId || accounts[0]?.id || "");
  const [content, setContent] = useState("");
  const [scheduleAt, setScheduleAt] = useState("");
  const [sendState, setSendState] = useState<SendState>("idle");
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [resultSummary, setResultSummary] = useState<string>("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Auto-resize textarea
  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, 140) + "px";
  }, [content]);

  // Filtered list by tab + name search
  const filteredGroups = useMemo(() => {
    const q = nameFilter.trim().toLowerCase();
    return groups.filter((g) => {
      const typeOk =
        tab === "private"
          ? g.chatType === "PRIVATE"
          : g.chatType === "GROUP" || g.chatType === "CHANNEL";
      if (!typeOk) return false;
      if (!q) return true;
      return (
        g.title.toLowerCase().includes(q) ||
        (g.customerName?.toLowerCase().includes(q) ?? false)
      );
    });
  }, [groups, tab, nameFilter]);

  const allSelected =
    filteredGroups.length > 0 &&
    filteredGroups.every((g) => selectedIds.has(g.id));

  const toggleGroup = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const toggleAll = () => {
    if (allSelected) {
      // Deselect all currently visible
      setSelectedIds((prev) => {
        const next = new Set(prev);
        filteredGroups.forEach((g) => next.delete(g.id));
        return next;
      });
    } else {
      setSelectedIds((prev) => {
        const next = new Set(prev);
        filteredGroups.forEach((g) => next.add(g.id));
        return next;
      });
    }
  };

  const tabPrivateCount = groups.filter((g) => g.chatType === "PRIVATE").length;
  const tabGroupCount = groups.filter(
    (g) => g.chatType === "GROUP" || g.chatType === "CHANNEL",
  ).length;
  const selectedCount = selectedIds.size;

  const canSend =
    selectedCount > 0 && content.trim().length > 0 && accountId && sendState === "idle";

  const handleSend = async () => {
    if (!canSend) return;
    const ids = [...selectedIds];
    setSendState("sending");
    setProgress({ done: 0, total: ids.length });

    try {
      const res = await fetch(
        `/api/workspaces/${workspaceId}/direct-chat/broadcast`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            groupIds: ids,
            accountId,
            content: content.trim(),
            ...(scheduleAt ? { scheduleDate: scheduleAt } : {}),
          }),
        },
      );
      const data = await res.json();
      if (res.ok) {
        setProgress({ done: data.successCount, total: data.total });
        setSendState("done");
        setResultSummary(
          data.scheduled
            ? `已排程 ${data.successCount} / ${data.total} 個對話`
            : `成功發送至 ${data.successCount} / ${data.total} 個對話${data.failCount > 0 ? `，${data.failCount} 個失敗` : ""}`,
        );
        onSuccess?.(data.successCount, data.total);
      } else {
        setSendState("error");
        setResultSummary(data.error ?? "發送失敗");
      }
    } catch (e) {
      setSendState("error");
      setResultSummary(e instanceof Error ? e.message : "網路錯誤");
    }
  };

  const handleReset = () => {
    setSendState("idle");
    setResultSummary("");
    setContent("");
    setScheduleAt("");
    setSelectedIds(new Set());
  };

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-40 bg-black/30 backdrop-blur-[1px]"
        onClick={onClose}
        aria-hidden
      />
      {/* Panel */}
      <div className="fixed inset-y-0 right-0 z-50 flex w-full max-w-[520px] flex-col bg-[var(--card)] shadow-2xl animate-[slide-in-right_200ms_ease-out]">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-[var(--border)] px-5 py-4">
          <div>
            <h2 className="text-[16px] font-semibold text-[var(--text-primary)]">群發訊息</h2>
            <p className="mt-0.5 text-[12px] text-[var(--text-muted)]">
              選擇目標對話，輸入訊息後同時發送
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full p-1.5 text-[var(--text-muted)] hover:bg-[var(--bg-secondary)] hover:text-[var(--text-primary)]"
            aria-label="關閉群發"
          >
            <X className="size-4" />
          </button>
        </div>

        {sendState === "done" || sendState === "error" ? (
          /* ── Result screen ─────────────────────────────────── */
          <div className="flex flex-1 flex-col items-center justify-center gap-5 px-8 text-center">
            <div
              className={`text-[48px] ${sendState === "done" ? "text-[var(--success)]" : "text-[var(--danger)]"}`}
            >
              {sendState === "done" ? "✓" : "✗"}
            </div>
            <p className="text-[15px] font-medium text-[var(--text-primary)]">
              {resultSummary}
            </p>
            <div className="flex gap-3">
              <button
                type="button"
                onClick={handleReset}
                className="rounded-lg bg-[var(--accent)] px-4 py-2 text-[13px] font-medium text-white hover:opacity-90"
              >
                再次群發
              </button>
              <button
                type="button"
                onClick={onClose}
                className="rounded-lg border border-[var(--border)] px-4 py-2 text-[13px] font-medium text-[var(--text-secondary)] hover:bg-[var(--bg-secondary)]"
              >
                關閉
              </button>
            </div>
          </div>
        ) : (
          <>
            {/* ── Group selector ──────────────────────────────── */}
            <div className="flex flex-1 flex-col overflow-hidden">
              {/* Account selector */}
              <div className="border-b border-[var(--border)] px-4 py-2.5">
                <div className="flex items-center gap-2">
                  <span className="shrink-0 text-[12px] text-[var(--text-muted)]">帳號</span>
                  <select
                    value={accountId}
                    onChange={(e) => setAccountId(e.target.value)}
                    className="flex-1 rounded-md border border-[var(--border)] bg-[var(--background)] px-2 py-1 text-[13px] outline-none focus:ring-1 focus:ring-[var(--ring)]"
                  >
                    {accounts.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.displayName}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              {/* Tabs */}
              <div className="flex border-b border-[var(--border)]">
                {(
                  [
                    { key: "private" as const, label: "私聊", count: tabPrivateCount, icon: MessageSquare },
                    { key: "group" as const, label: "群組", count: tabGroupCount, icon: Users },
                  ] as const
                ).map(({ key, label, count, icon: Icon }) => (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setTab(key)}
                    className={cn(
                      "flex flex-1 items-center justify-center gap-1.5 py-2.5 text-[13px] font-medium transition-colors",
                      tab === key
                        ? "border-b-2 border-[var(--accent)] text-[var(--accent)]"
                        : "text-[var(--text-muted)] hover:text-[var(--text-primary)]",
                    )}
                  >
                    <Icon className="size-3.5" />
                    {label}
                    <span className="text-[11px] opacity-70">({count})</span>
                  </button>
                ))}
              </div>

              {/* Search + select-all */}
              <div className="flex items-center gap-2 border-b border-[var(--border)] px-3 py-2">
                <div className="relative flex-1">
                  <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-[var(--text-muted)]" />
                  <input
                    type="text"
                    placeholder="搜尋名稱…"
                    value={nameFilter}
                    onChange={(e) => setNameFilter(e.target.value)}
                    className="w-full rounded-md border border-[var(--border)] bg-[var(--background)] py-1.5 pl-8 pr-3 text-[12px] outline-none focus:ring-1 focus:ring-[var(--ring)]"
                  />
                </div>
                <button
                  type="button"
                  onClick={toggleAll}
                  className="flex shrink-0 items-center gap-1 text-[11px] text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                  title={allSelected ? "取消全選" : "全選"}
                >
                  {allSelected ? (
                    <CheckSquare className="size-3.5 text-[var(--accent)]" />
                  ) : (
                    <Square className="size-3.5" />
                  )}
                  {allSelected ? "取消全選" : "全選"}
                </button>
              </div>

              {/* Group list */}
              <div className="flex-1 overflow-y-auto">
                {filteredGroups.length === 0 ? (
                  <div className="px-4 py-6 text-center text-[12px] text-[var(--text-muted)]">
                    此類別沒有符合的對話
                  </div>
                ) : (
                  filteredGroups.map((g) => {
                    const checked = selectedIds.has(g.id);
                    return (
                      <button
                        key={g.id}
                        type="button"
                        onClick={() => toggleGroup(g.id)}
                        className={cn(
                          "flex w-full items-center gap-3 border-b border-[var(--border)] px-4 py-2.5 text-left transition-colors last:border-0 hover:bg-[var(--bg-secondary)]",
                          checked && "bg-[var(--accent-bg)]",
                        )}
                      >
                        <span
                          className={cn(
                            "flex size-5 shrink-0 items-center justify-center rounded border transition-colors",
                            checked
                              ? "border-[var(--accent)] bg-[var(--accent)] text-white"
                              : "border-[var(--border)] bg-[var(--background)]",
                          )}
                        >
                          {checked && (
                            <svg
                              viewBox="0 0 12 12"
                              className="size-3"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2"
                            >
                              <polyline points="2,6 5,9 10,3" />
                            </svg>
                          )}
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-[13px] font-medium text-[var(--text-primary)]">
                            {g.title}
                          </div>
                          {g.customerName && (
                            <div className="truncate text-[11px] text-[var(--text-muted)]">
                              {g.customerName}
                            </div>
                          )}
                        </div>
                        {g.tags && g.tags.length > 0 && (
                          <span className="shrink-0 rounded-full bg-[var(--accent-bg)] px-1.5 py-0.5 text-[9px] text-[var(--accent)]">
                            {g.tags[0]}
                          </span>
                        )}
                      </button>
                    );
                  })
                )}
              </div>

              {/* Selection summary bar */}
              {selectedCount > 0 && (
                <div className="flex items-center gap-2 border-t border-[var(--border)] bg-[var(--accent-bg)] px-4 py-2">
                  <span className="text-[12px] font-medium text-[var(--accent)]">
                    已選 {selectedCount} 個對話
                  </span>
                  <button
                    type="button"
                    onClick={() => setSelectedIds(new Set())}
                    className="ml-auto text-[11px] text-[var(--text-muted)] hover:text-[var(--danger)]"
                  >
                    清除
                  </button>
                </div>
              )}
            </div>

            {/* ── Composer ────────────────────────────────────── */}
            <div className="shrink-0 border-t border-[var(--border)] p-4 space-y-3">
              <textarea
                ref={textareaRef}
                value={content}
                onChange={(e) => setContent(e.target.value)}
                placeholder="輸入群發訊息…"
                rows={3}
                className="w-full resize-none rounded-lg border border-[var(--border)] bg-[var(--background)] px-3 py-2.5 text-[13px] leading-relaxed outline-none focus:ring-2 focus:ring-[var(--ring)] placeholder:text-[var(--text-muted)]"
                style={{ minHeight: 72, maxHeight: 140 }}
              />

              {/* Schedule row */}
              <div className="flex items-center gap-2">
                <Clock className="size-3.5 shrink-0 text-[var(--text-muted)]" />
                <input
                  type="datetime-local"
                  value={scheduleAt}
                  onChange={(e) => setScheduleAt(e.target.value)}
                  className="flex-1 rounded-md border border-[var(--border)] bg-[var(--background)] px-2 py-1 text-[12px] outline-none focus:ring-1 focus:ring-[var(--ring)] text-[var(--text-secondary)]"
                />
                {scheduleAt && (
                  <button
                    type="button"
                    onClick={() => setScheduleAt("")}
                    className="text-[11px] text-[var(--text-muted)] hover:text-[var(--danger)]"
                  >
                    取消排程
                  </button>
                )}
              </div>

              {/* Send button */}
              <button
                type="button"
                onClick={handleSend}
                disabled={!canSend}
                className={cn(
                  "flex w-full items-center justify-center gap-2 rounded-lg py-2.5 text-[13px] font-semibold transition-all",
                  canSend
                    ? "bg-[var(--accent)] text-white hover:opacity-90 active:scale-[.98]"
                    : "cursor-not-allowed bg-[var(--muted)] text-[var(--text-muted)]",
                )}
              >
                {sendState === "sending" ? (
                  <>
                    <span className="size-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                    發送中…
                  </>
                ) : (
                  <>
                    <Send className="size-4" />
                    {scheduleAt ? "排程群發" : "立即群發"}
                    {selectedCount > 0 && (
                      <span className="ml-1 opacity-80">({selectedCount} 個對話)</span>
                    )}
                  </>
                )}
              </button>
            </div>
          </>
        )}
      </div>
    </>
  );
}
