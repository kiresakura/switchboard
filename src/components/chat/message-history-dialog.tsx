"use client";

/**
 * MessageHistoryDialog — shows previous versions + deletion status for a
 * DirectChatMessage. Backed by /messages/:id/history which returns:
 * currentContent, editedAt, isDeleted, deletedAt, history[].
 *
 * For display order, the dialog shows in reverse-chronological timeline:
 *   ┌ current / current-deleted
 *   ├ 前一版（editedAt）
 *   ├ 更前一版
 *   └ ...
 *
 * 2026-05-21:broker Message 表移除後,此 dialog 改由 DirectChatMessage +
 * DirectChatMessageEditHistory 供應。bridge 在每次 TG 端編輯訊息時會把舊內容
 * 寫入 DirectChatMessageEditHistory,所以 history[] 對直面對話訊息有效。
 */

import { useEffect, useState } from "react";
import { X, Clock, Trash2, Pencil } from "lucide-react";
import { createPortal } from "react-dom";

type HistoryEntry = {
  id: string;
  previousContent: string;
  editedAt: string;
};

type HistoryPayload = {
  messageId: string;
  currentContent: string;
  editedAt: string | null;
  isDeleted: boolean;
  deletedAt: string | null;
  history: HistoryEntry[];
};

type Props = {
  workspaceId: string;
  messageId: string;
  open: boolean;
  onClose: () => void;
};

export function MessageHistoryDialog({ workspaceId, messageId, open, onClose }: Props) {
  const [payload, setPayload] = useState<HistoryPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mounted, setMounted] = useState(false);

  useEffect(() => setMounted(true), []);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      setPayload(null);
      try {
        const res = await fetch(
          `/api/workspaces/${workspaceId}/messages/${messageId}/history`,
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as HistoryPayload;
        if (!cancelled) setPayload(data);
      } catch (err) {
        if (!cancelled) setError(String(err).slice(0, 200));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, workspaceId, messageId]);

  // ESC to close
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open || !mounted) return null;

  const dialog = (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-full max-w-xl max-h-[80vh] overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--card)] shadow-xl flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-[var(--border)] px-4 py-3">
          <div className="flex items-center gap-2">
            <Clock className="size-4 text-[var(--muted-foreground)]" />
            <h3 className="text-sm font-semibold">訊息歷程</h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1 hover:bg-[var(--bg-secondary)]"
            aria-label="關閉"
          >
            <X className="size-4" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {loading && (
            <div className="text-sm text-[var(--muted-foreground)]">載入中...</div>
          )}
          {error && (
            <div className="text-sm text-[var(--reject)]">載入失敗：{error}</div>
          )}
          {payload && (
            <>
              {/* Current / deleted state */}
              <div
                className={
                  payload.isDeleted
                    ? "rounded-lg border border-[var(--reject)]/40 bg-[var(--reject)]/5 p-3"
                    : "rounded-lg border border-[var(--approve)]/40 bg-[var(--approve)]/5 p-3"
                }
              >
                <div className="mb-1.5 flex items-center gap-1.5 text-xs font-medium">
                  {payload.isDeleted ? (
                    <>
                      <Trash2 className="size-3.5 text-[var(--reject)]" />
                      <span className="text-[var(--reject)]">
                        已刪除
                        {payload.deletedAt
                          ? ` · ${new Date(payload.deletedAt).toLocaleString("zh-TW")}`
                          : ""}
                      </span>
                    </>
                  ) : payload.editedAt ? (
                    <>
                      <Pencil className="size-3.5 text-[var(--approve)]" />
                      <span className="text-[var(--approve)]">
                        目前版本 · 最後編輯於{" "}
                        {new Date(payload.editedAt).toLocaleString("zh-TW")}
                      </span>
                    </>
                  ) : (
                    <span className="text-[var(--approve)]">目前版本</span>
                  )}
                </div>
                <div
                  className={
                    payload.isDeleted
                      ? "whitespace-pre-wrap break-words text-sm leading-snug line-through opacity-70"
                      : "whitespace-pre-wrap break-words text-sm leading-snug"
                  }
                >
                  {payload.currentContent || "(空白內容)"}
                </div>
              </div>

              {/* Previous versions — newest first */}
              {payload.history.length > 0 && (
                <div className="pt-2">
                  <div className="mb-2 text-[11px] font-medium uppercase tracking-wide text-[var(--muted-foreground)]">
                    先前版本（{payload.history.length}）
                  </div>
                  <div className="space-y-2">
                    {payload.history.map((h) => (
                      <div
                        key={h.id}
                        className="rounded-lg border border-[var(--border)] bg-[var(--muted)]/30 p-3"
                      >
                        <div className="mb-1 text-[11px] text-[var(--muted-foreground)]">
                          {new Date(h.editedAt).toLocaleString("zh-TW")} 時的內容
                        </div>
                        <div className="whitespace-pre-wrap break-words text-sm leading-snug">
                          {h.previousContent || "(空白內容)"}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {payload.history.length === 0 && !payload.isDeleted && !payload.editedAt && (
                <div className="text-xs text-[var(--muted-foreground)]">
                  此訊息未曾被編輯或刪除。
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        <div className="border-t border-[var(--border)] px-4 py-2">
          <button
            type="button"
            onClick={onClose}
            className="ml-auto block rounded-md border border-[var(--border)] px-3 py-1 text-xs hover:bg-[var(--bg-secondary)]"
          >
            關閉
          </button>
        </div>
      </div>
    </div>
  );

  return createPortal(dialog, document.body);
}
