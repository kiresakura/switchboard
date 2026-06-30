"use client";

/**
 * GroupMembersPanel — 顯示 TG 群組 / 頻道的成員清單。
 *
 * 設計:跟 ForwardChatPicker 同 modal pattern,但純展示。每筆成員顯示 avatar
 * + displayName + @username(若有)。搜尋 client-side filter,行內。
 *
 * MVP:不渲染 online 狀態 — 每個成員都打一次 GetFullUser 太貴,且通常 200
 * 成員的 batch 太大。對方真的需要 online 狀態時去點該成員開 user-profile-modal。
 */

import { useEffect, useMemo, useState } from "react";
import { X } from "lucide-react";
import { ChatAvatar } from "./avatar";

type Member = {
  platformUserId: string;
  displayName: string;
  avatarUrl?: string;
};

export function GroupMembersPanel({
  workspaceId,
  groupId,
  groupTitle,
  onClose,
  onSelectMember,
}: {
  workspaceId: string;
  groupId: string;
  groupTitle: string;
  onClose: () => void;
  /** 點成員 row 觸發 — 通常開 user-profile-modal */
  onSelectMember?: (platformUserId: string) => void;
}) {
  const [members, setMembers] = useState<Member[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/workspaces/${workspaceId}/groups/${groupId}/members`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (cancelled) return;
        setMembers((d?.members ?? []) as Member[]);
        setLoading(false);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(String(e));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, groupId]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return members;
    return members.filter((m) => m.displayName.toLowerCase().includes(q));
  }, [members, query]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="群組成員"
      className="fixed inset-0 z-[1100] flex items-center justify-center bg-black/40 px-4"
      onClick={onClose}
    >
      <div
        className="flex max-h-[80vh] w-full max-w-md flex-col rounded-lg border border-[var(--border)] bg-[var(--bg-primary)] shadow-[0_16px_48px_rgba(25,24,23,0.16)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-[var(--border)] px-4 py-3">
          <div className="min-w-0">
            <h3 className="text-sm font-medium truncate" title={groupTitle}>
              成員列表
            </h3>
            <p className="text-[11px] text-[var(--text-muted)] truncate">{groupTitle}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-[var(--text-muted)] hover:bg-[var(--bg-secondary)] hover:text-[var(--foreground)]"
            aria-label="關閉"
          >
            <X className="size-4" />
          </button>
        </div>

        {!loading && members.length > 0 && (
          <div className="border-b border-[var(--border)] px-4 py-2">
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={`在 ${members.length} 位成員中搜尋…`}
              className="w-full rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-3 py-1.5 text-sm outline-none focus:ring-2 focus:ring-[var(--accent)]/40"
            />
          </div>
        )}

        <div className="flex-1 overflow-y-auto">
          {loading && (
            <div className="px-4 py-8 text-center text-sm text-[var(--text-muted)]">
              載入中…
            </div>
          )}
          {error && (
            <div className="px-4 py-8 text-center text-sm text-red-600">
              載入失敗:{error}
            </div>
          )}
          {!loading && !error && members.length === 0 && (
            <div className="px-4 py-8 text-center text-sm text-[var(--text-muted)]">
              無法取得成員清單(可能是私訊對話 / 帳號權限不足 / 群組已停用)
            </div>
          )}
          {!loading && filtered.length === 0 && members.length > 0 && (
            <div className="px-4 py-8 text-center text-sm text-[var(--text-muted)]">
              沒有符合的成員
            </div>
          )}
          {filtered.map((m) => (
            <button
              key={m.platformUserId}
              type="button"
              onClick={() => onSelectMember?.(m.platformUserId)}
              disabled={!onSelectMember}
              className="flex w-full items-center gap-3 border-b border-[var(--border)] px-4 py-2.5 text-left transition-colors last:border-0 hover:bg-[var(--bg-secondary)] disabled:cursor-default disabled:hover:bg-transparent"
            >
              <ChatAvatar
                name={m.displayName}
                seed={m.platformUserId}
                src={m.avatarUrl ?? null}
                size="sm"
              />
              <div className="min-w-0 flex-1">
                <div
                  className="truncate text-[13px] text-[var(--text-primary)]"
                  title={m.displayName}
                >
                  {m.displayName}
                </div>
                <div className="truncate text-[10px] text-[var(--text-muted)]">
                  TG ID:{m.platformUserId}
                </div>
              </div>
            </button>
          ))}
        </div>

        {!loading && members.length > 0 && (
          <div className="border-t border-[var(--border)] px-4 py-2 text-[11px] text-[var(--text-muted)]">
            最多顯示 200 位;超大群組可能截掉一部分。點成員可開個人資料。
          </div>
        )}
      </div>
    </div>
  );
}
