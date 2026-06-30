"use client";

/**
 * 標籤管理頁(2026-05-21 Batch 3)。
 *
 * 管理 WorkspaceTag —— 工作區的共用標籤詞彙表。schema 的 WorkspaceTag model 一直
 * 存在但從來沒有 UI;此頁補上「新增 / 改名 / 換色 / 刪除」。
 *
 * 注意:此頁管理的是「標籤詞彙」本身,不是把標籤套到某個對話。對話 / 客戶身上
 * 的 tags 仍是自由字串(Group.tags / Customer.tags),套用 UI 在對話頁。
 */

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { PageHeader } from "@/components/ui/section";
import { useToast } from "@/hooks/use-toast";

type WorkspaceTag = {
  id: string;
  name: string;
  color: string | null;
  sortOrder: number;
  createdAt: string;
};

// 預設色票 —— 在淺色 / 深色都辨識得出的飽和度。也可選「無色」。
const PRESET_COLORS = [
  "#ef4444",
  "#f97316",
  "#eab308",
  "#22c55e",
  "#14b8a6",
  "#3b82f6",
  "#8b5cf6",
  "#ec4899",
];

type FormState = { name: string; color: string | null };
const EMPTY_FORM: FormState = { name: "", color: null };

export default function WorkspaceTagsPage() {
  const { workspaceId } = useParams<{ workspaceId: string }>();
  const { confirm } = useToast();

  const [tags, setTags] = useState<WorkspaceTag[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  // editingId: null = 表單關閉;"new" = 新增中;其他 = 編輯該 id
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);

  const fetchTags = useCallback(async () => {
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/workspace-tags`);
      if (res.ok) {
        const data = await res.json();
        setTags(Array.isArray(data.tags) ? data.tags : []);
        setError("");
      } else {
        setError("無法載入標籤");
      }
    } catch {
      setError("網路錯誤,無法載入標籤");
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => {
    fetchTags();
  }, [fetchTags]);

  function openCreate() {
    setEditingId("new");
    setForm(EMPTY_FORM);
    setError("");
  }

  function openEdit(t: WorkspaceTag) {
    setEditingId(t.id);
    setForm({ name: t.name, color: t.color });
    setError("");
  }

  function closeForm() {
    setEditingId(null);
    setForm(EMPTY_FORM);
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    const name = form.name.trim();
    if (!name || name.length > 32) {
      setError("標籤名稱為必填,且 ≤ 32 字元");
      return;
    }
    setSaving(true);
    setError("");
    try {
      const isNew = editingId === "new";
      const url = isNew
        ? `/api/workspaces/${workspaceId}/workspace-tags`
        : `/api/workspaces/${workspaceId}/workspace-tags/${editingId}`;
      const res = await fetch(url, {
        method: isNew ? "POST" : "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, color: form.color }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error || "儲存失敗");
        return;
      }
      closeForm();
      fetchTags();
    } catch {
      setError("網路錯誤,儲存失敗");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(t: WorkspaceTag) {
    const ok = await confirm({
      message: `確定刪除標籤「${t.name}」?已套用此字串的對話標籤不會被移除,但詞彙清單中將不再有它。`,
      danger: true,
    });
    if (!ok) return;
    try {
      const res = await fetch(
        `/api/workspaces/${workspaceId}/workspace-tags/${t.id}`,
        { method: "DELETE" },
      );
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error || "刪除失敗");
        return;
      }
      fetchTags();
    } catch {
      setError("網路錯誤,刪除失敗");
    }
  }

  if (loading) {
    return <div className="text-sm text-[var(--muted-foreground)]">載入中...</div>;
  }

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <PageHeader
        title="標籤管理"
        description="管理工作區的共用標籤詞彙。集中維護避免拼字不一致 —— 之後可套用到對話與客戶。"
        actions={
          <button
            onClick={() => (editingId === "new" ? closeForm() : openCreate())}
            className="rounded-md bg-[var(--primary)] px-3 py-1.5 text-sm font-medium text-[var(--primary-foreground)] hover:opacity-90"
          >
            {editingId === "new" ? "取消" : "新增標籤"}
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
            {editingId === "new" ? "新增標籤" : "編輯標籤"}
          </div>
          <div>
            <label className="mb-1 block text-xs text-[var(--muted-foreground)]">
              標籤名稱
            </label>
            <input
              type="text"
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              placeholder="例如:VIP 客戶"
              maxLength={32}
              required
              className="w-full max-w-sm rounded-md border border-[var(--input)] bg-[var(--background)] px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[var(--ring)]"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs text-[var(--muted-foreground)]">
              顏色
            </label>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => setForm((f) => ({ ...f, color: null }))}
                className={`flex h-7 items-center rounded-md border px-2 text-xs transition-colors ${
                  form.color === null
                    ? "border-[var(--ring)] bg-[var(--primary)]/10 text-[var(--primary)]"
                    : "border-[var(--border)] text-[var(--muted-foreground)] hover:bg-[var(--bg-secondary)]"
                }`}
              >
                無色
              </button>
              {PRESET_COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setForm((f) => ({ ...f, color: c }))}
                  className={`size-7 rounded-md border-2 transition-transform ${
                    form.color === c
                      ? "scale-110 border-[var(--foreground)]"
                      : "border-transparent hover:scale-105"
                  }`}
                  style={{ backgroundColor: c }}
                  aria-label={`顏色 ${c}`}
                />
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

      {tags.length === 0 ? (
        <div className="rounded-lg border border-dashed border-[var(--border)] bg-[var(--card)] px-4 py-10 text-center text-sm text-[var(--muted-foreground)]">
          尚未建立任何標籤。點右上角「新增標籤」開始。
        </div>
      ) : (
        <div className="space-y-2">
          {tags.map((t) => (
            <div
              key={t.id}
              className="flex items-center justify-between rounded-lg border border-[var(--border)] bg-[var(--card)] px-4 py-2.5"
            >
              <div className="flex items-center gap-2.5">
                <span
                  className="size-3.5 shrink-0 rounded-full border border-[var(--border)]"
                  style={{ backgroundColor: t.color ?? "transparent" }}
                />
                <span className="text-sm font-medium text-[var(--foreground)]">
                  {t.name}
                </span>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <button
                  onClick={() => openEdit(t)}
                  className="rounded border border-[var(--border)] px-2 py-1 text-xs hover:bg-[var(--bg-secondary)]"
                >
                  編輯
                </button>
                <button
                  onClick={() => handleDelete(t)}
                  className="rounded px-2 py-1 text-xs text-[var(--destructive)] hover:bg-[var(--destructive)]/10"
                >
                  刪除
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
