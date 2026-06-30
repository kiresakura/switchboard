"use client";

/**
 * ForwardChatPicker — 轉發訊息時用的對話選擇器 modal。
 *
 * 設計:
 *   - 簡單 list,左側 avatar + 對話標題 + 最後訊息預覽,跟 ChatListItem 一致
 *   - 搜尋輸入框過濾(client-side,對 title / customerName / 帳號名 都 match)
 *   - 排除來源對話(sourceGroupId)避免轉給自己
 *   - 點選 → 立刻呼叫 onPick 並關閉
 *   - 沒有 onPick 給多個 group 的設計(一次只轉一個目標 — 多個目標讓 caller
 *     自己 loop;UI 上不該設計成 multi-target,容易誤觸)
 */

import { useMemo, useState } from "react";
import { ChatAvatar } from "./avatar";
import { safeTitle } from "@/lib/utils";
import { X } from "lucide-react";

export type ForwardPickerGroup = {
  id: string;
  title: string;
  platformGroupId: string;
  customerName?: string | null;
  accountMemberships?: Array<{ account: { displayName: string } }>;
};

export function ForwardChatPicker({
  workspaceId,
  groups,
  sourceGroupId,
  onPick,
  onClose,
  busy = false,
}: {
  workspaceId: string;
  groups: ForwardPickerGroup[];
  sourceGroupId: string;
  onPick: (groupId: string) => void;
  onClose: () => void;
  busy?: boolean;
}) {
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const base = groups.filter((g) => g.id !== sourceGroupId);
    if (!q) return base;
    return base.filter((g) => {
      if (g.title.toLowerCase().includes(q)) return true;
      if (g.customerName && g.customerName.toLowerCase().includes(q)) return true;
      if (g.accountMemberships?.some((m) => m.account.displayName.toLowerCase().includes(q))) {
        return true;
      }
      return false;
    });
  }, [groups, sourceGroupId, query]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="轉發到對話"
      className="fixed inset-0 z-[1100] flex items-center justify-center bg-black/40 px-4"
      onClick={onClose}
    >
      <div
        className="flex max-h-[80vh] w-full max-w-md flex-col rounded-lg border border-[var(--border)] bg-[var(--bg-primary)] shadow-[0_16px_48px_rgba(25,24,23,0.16)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-[var(--border)] px-4 py-3">
          <h3 className="text-sm font-medium">轉發到對話</h3>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-[var(--text-muted)] hover:bg-[var(--bg-secondary)] hover:text-[var(--foreground)]"
            aria-label="關閉"
          >
            <X className="size-4" />
          </button>
        </div>

        <div className="border-b border-[var(--border)] px-4 py-2">
          <input
            type="search"
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜尋對話標題 / 客戶名 / Telegram 帳號…"
            className="w-full rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-3 py-1.5 text-sm outline-none focus:ring-2 focus:ring-[var(--accent)]/40"
          />
        </div>

        <div className="flex-1 overflow-y-auto">
          {filtered.length === 0 ? (
            <div className="px-4 py-8 text-center text-sm text-[var(--text-muted)]">
              {query ? "沒有符合的對話" : "沒有可選的對話"}
            </div>
          ) : (
            filtered.map((g) => (
              <button
                key={g.id}
                type="button"
                disabled={busy}
                onClick={() => onPick(g.id)}
                className="flex w-full items-center gap-3 border-b border-[var(--border)] px-4 py-3 text-left transition-colors last:border-0 hover:bg-[var(--bg-secondary)] disabled:opacity-50"
              >
                <ChatAvatar
                  name={g.title}
                  seed={g.id || g.platformGroupId || g.title}
                  src={
                    g.platformGroupId
                      ? `/api/workspaces/${workspaceId}/group-avatars/${encodeURIComponent(g.platformGroupId)}`
                      : null
                  }
                  size="sm"
                />
                <div className="min-w-0 flex-1">
                  <div
                    className="truncate text-[14px] font-medium text-[var(--text-primary)]"
                    title={g.title}
                  >
                    <bdi>{safeTitle(g.title, 60)}</bdi>
                  </div>
                  {g.customerName && (
                    <div className="truncate text-[11px] text-[var(--text-muted)]">
                      {g.customerName}
                    </div>
                  )}
                </div>
              </button>
            ))
          )}
        </div>

        <div className="border-t border-[var(--border)] px-4 py-2 text-[11px] text-[var(--text-muted)]">
          只能轉發到「同一 Telegram 帳號」也已加入的對話 — 若清單缺少目標,
          請先讓對應的員工帳號加入該對話。
        </div>
      </div>
    </div>
  );
}
