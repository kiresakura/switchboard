"use client";

/**
 * 快選回覆管理頁(2026-05-21 Batch 2)。
 *
 * QuickReply 的 CRUD API 在先前 Phase A 已落地(/api/workspaces/[ws]/quick-replies
 * 及 /[quickReplyId]),composer 的 `/捷徑` autocomplete 也已接上 — 唯獨缺這個
 * 「能新增/編輯/刪除」的管理頁。autocomplete 的空狀態本來就提示使用者「到快選
 * 回覆頁新增」,但那頁一直不存在。此頁補上那個缺口。
 *
 * 權限:任何工作區成員都能管理「自己的」快選回覆。可見範圍(scope)決定別人
 * 看不看得到 — PRIVATE 只有自己、TEAM 同團隊、WORKSPACE 全工作區。編輯/刪除
 * 只有 owner(或 admin,由 API 把關)能做,所以非自己擁有的列不顯示按鈕。
 */

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { PageHeader } from "@/components/ui/section";
import { useToast } from "@/hooks/use-toast";

type Scope = "PRIVATE" | "TEAM" | "WORKSPACE";

type QuickReply = {
  id: string;
  shortcut: string;
  title: string;
  body: string;
  scope: Scope;
  tags: string[];
  sortOrder: number;
  ownerUserId: string | null;
  ownerName: string | null;
  createdAt: string;
  updatedAt: string;
};

const SCOPE_OPTIONS: { value: Scope; label: string; hint: string }[] = [
  { value: "PRIVATE", label: "私人", hint: "只有你看得到" },
  { value: "TEAM", label: "團隊", hint: "同團隊成員可見" },
  { value: "WORKSPACE", label: "工作區", hint: "全工作區成員可見" },
];

const SCOPE_LABEL: Record<Scope, string> = {
  PRIVATE: "私人",
  TEAM: "團隊",
  WORKSPACE: "工作區",
};

type FormState = { shortcut: string; title: string; body: string; scope: Scope };
const EMPTY_FORM: FormState = { shortcut: "", title: "", body: "", scope: "PRIVATE" };

export default function QuickRepliesPage() {
  const { workspaceId } = useParams<{ workspaceId: string }>();
  const { confirm } = useToast();

  const [replies, setReplies] = useState<QuickReply[]>([]);
  const [myUserId, setMyUserId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  // editingId: null = 表單關閉;"new" = 新增中;其他 = 正在編輯該 id
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);

  const fetchReplies = useCallback(async () => {
    try {
      const res = await fetch(
        `/api/workspaces/${workspaceId}/quick-replies?scope=all`,
      );
      if (res.ok) {
        const data = await res.json();
        setReplies(Array.isArray(data.quickReplies) ? data.quickReplies : []);
        setError("");
      } else {
        setError("無法載入快選回覆");
      }
    } catch {
      setError("網路錯誤，無法載入快選回覆");
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => {
    fetchReplies();
    // 取得目前使用者 id — 用來判斷哪些 quick reply 是自己的(可編輯/刪除)
    fetch("/api/auth/me")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setMyUserId(d?.user?.id ?? null))
      .catch(() => {});
  }, [fetchReplies]);

  function openCreate() {
    setEditingId("new");
    setForm(EMPTY_FORM);
    setError("");
  }

  function openEdit(r: QuickReply) {
    setEditingId(r.id);
    setForm({ shortcut: r.shortcut, title: r.title, body: r.body, scope: r.scope });
    setError("");
  }

  function closeForm() {
    setEditingId(null);
    setForm(EMPTY_FORM);
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    const shortcut = form.shortcut.trim();
    const title = form.title.trim();
    const body = form.body;
    if (!shortcut || /\s/.test(shortcut) || shortcut.length > 32) {
      setError("捷徑為必填，不可含空白，且 ≤ 32 字元");
      return;
    }
    if (!title || title.length > 64) {
      setError("標題為必填，且 ≤ 64 字元");
      return;
    }
    if (!body || body.length > 4096) {
      setError("內容為必填，且 ≤ 4096 字元");
      return;
    }
    setSaving(true);
    setError("");
    try {
      const isNew = editingId === "new";
      const url = isNew
        ? `/api/workspaces/${workspaceId}/quick-replies`
        : `/api/workspaces/${workspaceId}/quick-replies/${editingId}`;
      const res = await fetch(url, {
        method: isNew ? "POST" : "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ shortcut, title, body, scope: form.scope }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error || "儲存失敗");
        return;
      }
      closeForm();
      fetchReplies();
    } catch {
      setError("網路錯誤，儲存失敗");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(r: QuickReply) {
    const ok = await confirm({
      message: `確定刪除快選回覆「/${r.shortcut}」？此動作無法復原。`,
      danger: true,
    });
    if (!ok) return;
    try {
      const res = await fetch(
        `/api/workspaces/${workspaceId}/quick-replies/${r.id}`,
        { method: "DELETE" },
      );
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error || "刪除失敗");
        return;
      }
      fetchReplies();
    } catch {
      setError("網路錯誤，刪除失敗");
    }
  }

  if (loading) {
    return <div className="text-sm text-[var(--muted-foreground)]">載入中...</div>;
  }

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <PageHeader
        title="快選回覆"
        description="管理快選回覆 — 在對話輸入框打「/捷徑」即可快速插入內容。"
        actions={
          <button
            onClick={() => (editingId === "new" ? closeForm() : openCreate())}
            className="rounded-md bg-[var(--primary)] px-3 py-1.5 text-sm font-medium text-[var(--primary-foreground)] hover:opacity-90"
          >
            {editingId === "new" ? "取消" : "新增快選回覆"}
          </button>
        }
      />

      {error && (
        <div className="rounded-md border border-[var(--destructive)]/30 bg-[var(--destructive)]/10 px-4 py-2 text-sm text-[var(--destructive)]">
          {error}
        </div>
      )}

      {editingId !== null && (
        <form
          onSubmit={handleSave}
          className="space-y-3 rounded-lg border border-[var(--border)] bg-[var(--card)] p-4"
        >
          <div className="text-sm font-medium text-[var(--foreground)]">
            {editingId === "new" ? "新增快選回覆" : "編輯快選回覆"}
          </div>
          <div className="grid gap-3 sm:grid-cols-[200px_1fr]">
            <div>
              <label className="mb-1 block text-xs text-[var(--muted-foreground)]">
                捷徑（不含空白）
              </label>
              <div className="flex items-center rounded-md border border-[var(--input)] bg-[var(--background)] px-2">
                <span className="text-sm text-[var(--muted-foreground)]">/</span>
                <input
                  type="text"
                  value={form.shortcut}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, shortcut: e.target.value }))
                  }
                  placeholder="hello"
                  maxLength={32}
                  required
                  className="w-full bg-transparent px-1 py-2 text-sm outline-none"
                />
              </div>
            </div>
            <div>
              <label className="mb-1 block text-xs text-[var(--muted-foreground)]">
                標題
              </label>
              <input
                type="text"
                value={form.title}
                onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
                placeholder="例如:歡迎詞"
                maxLength={64}
                required
                className="w-full rounded-md border border-[var(--input)] bg-[var(--background)] px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[var(--ring)]"
              />
            </div>
          </div>
          <div>
            <label className="mb-1 block text-xs text-[var(--muted-foreground)]">
              內容
            </label>
            <textarea
              value={form.body}
              onChange={(e) => setForm((f) => ({ ...f, body: e.target.value }))}
              placeholder="輸入回覆內容…"
              rows={4}
              maxLength={4096}
              required
              className="w-full resize-y rounded-md border border-[var(--input)] bg-[var(--background)] px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[var(--ring)]"
            />
            <div className="mt-1 text-right text-[11px] text-[var(--muted-foreground)]">
              {form.body.length} / 4096
            </div>
          </div>
          <div>
            <label className="mb-1 block text-xs text-[var(--muted-foreground)]">
              可見範圍
            </label>
            <div className="flex flex-wrap gap-2">
              {SCOPE_OPTIONS.map((opt) => (
                <label
                  key={opt.value}
                  title={opt.hint}
                  className={`flex cursor-pointer items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs transition-colors ${
                    form.scope === opt.value
                      ? "border-[var(--ring)] bg-[var(--primary)]/10 text-[var(--primary)]"
                      : "border-[var(--border)] hover:bg-[var(--bg-secondary)]"
                  }`}
                >
                  <input
                    type="radio"
                    name="scope"
                    checked={form.scope === opt.value}
                    onChange={() => setForm((f) => ({ ...f, scope: opt.value }))}
                    className="sr-only"
                  />
                  {opt.label}
                </label>
              ))}
            </div>
          </div>
          <div className="flex gap-2">
            <button
              type="submit"
              disabled={saving}
              className="rounded-md bg-[var(--primary)] px-4 py-2 text-sm font-medium text-[var(--primary-foreground)] hover:opacity-90 disabled:opacity-50"
            >
              {saving ? "儲存中…" : "儲存"}
            </button>
            <button
              type="button"
              onClick={closeForm}
              className="rounded-md border border-[var(--border)] px-4 py-2 text-sm hover:bg-[var(--bg-secondary)]"
            >
              取消
            </button>
          </div>
        </form>
      )}

      {replies.length === 0 ? (
        <div className="rounded-lg border border-dashed border-[var(--border)] bg-[var(--card)] px-4 py-10 text-center text-sm text-[var(--muted-foreground)]">
          尚未建立任何快選回覆。點右上角「新增快選回覆」開始。
        </div>
      ) : (
        <div className="space-y-2">
          {replies.map((r) => {
            const canEdit = !!myUserId && r.ownerUserId === myUserId;
            return (
              <div
                key={r.id}
                className="rounded-lg border border-[var(--border)] bg-[var(--card)] px-4 py-3"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-xs text-[var(--primary)]">
                        /{r.shortcut}
                      </span>
                      <span className="text-sm font-medium text-[var(--foreground)]">
                        {r.title}
                      </span>
                      <span className="rounded-full bg-[var(--bg-secondary)] px-2 py-0.5 text-[10px] text-[var(--muted-foreground)]">
                        {SCOPE_LABEL[r.scope]}
                      </span>
                      {!canEdit && r.ownerName && (
                        <span className="text-[11px] text-[var(--muted-foreground)]">
                          by {r.ownerName}
                        </span>
                      )}
                    </div>
                    <p className="mt-1 line-clamp-3 whitespace-pre-wrap text-xs text-[var(--muted-foreground)]">
                      {r.body}
                    </p>
                  </div>
                  {canEdit && (
                    <div className="flex shrink-0 items-center gap-2">
                      <button
                        onClick={() => openEdit(r)}
                        className="rounded border border-[var(--border)] px-2 py-1 text-xs hover:bg-[var(--bg-secondary)]"
                      >
                        編輯
                      </button>
                      <button
                        onClick={() => handleDelete(r)}
                        className="rounded px-2 py-1 text-xs text-[var(--destructive)] hover:bg-[var(--destructive)]/10"
                      >
                        刪除
                      </button>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
