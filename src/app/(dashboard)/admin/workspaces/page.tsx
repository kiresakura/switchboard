"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";

type Workspace = {
  id: string;
  name: string;
  slug: string;
  isActive: boolean;
  createdAt: string;
  memberCount: number;
  activePairingCount: number;
};

type EditForm = {
  name: string;
  isActive: boolean;
};

export default function AdminWorkspacesPage() {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [loading, setLoading] = useState(true);

  // Create form
  const [showCreate, setShowCreate] = useState(false);
  const [createForm, setCreateForm] = useState({ name: "", slug: "" });
  const [createError, setCreateError] = useState("");
  const [creating, setCreating] = useState(false);

  // Edit state
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<EditForm>({ name: "", isActive: true });
  const [editError, setEditError] = useState("");
  const [editSubmitting, setEditSubmitting] = useState(false);

  async function fetchWorkspaces() {
    try {
      const res = await fetch("/api/admin/workspaces");
      if (res.ok) {
        const data = await res.json();
        setWorkspaces(data.workspaces || []);
      }
    } catch {
      // ignore
    }
    setLoading(false);
  }

  useEffect(() => {
    fetchWorkspaces();
  }, []);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setCreateError("");
    setCreating(true);

    try {
      const res = await fetch("/api/workspaces", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(createForm),
      });

      if (!res.ok) {
        const data = await res.json();
        setCreateError(data.error || "建立失敗");
        return;
      }

      setCreateForm({ name: "", slug: "" });
      setShowCreate(false);
      fetchWorkspaces();
    } catch {
      setCreateError("網路錯誤");
    } finally {
      setCreating(false);
    }
  }

  function startEditing(ws: Workspace) {
    setEditingId(ws.id);
    setEditForm({ name: ws.name, isActive: ws.isActive });
    setEditError("");
  }

  function cancelEditing() {
    setEditingId(null);
    setEditError("");
  }

  async function handleEditSave(e: React.FormEvent) {
    e.preventDefault();
    if (!editingId) return;
    setEditError("");
    setEditSubmitting(true);

    try {
      const original = workspaces.find((w) => w.id === editingId);
      if (!original) return;

      const payload: Record<string, unknown> = {};
      if (editForm.name !== original.name) {
        payload.name = editForm.name;
      }
      if (editForm.isActive !== original.isActive) {
        payload.isActive = editForm.isActive;
      }

      if (Object.keys(payload).length === 0) {
        setEditError("沒有需要更新的欄位");
        return;
      }

      const res = await fetch(`/api/admin/workspaces/${editingId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const data = await res.json();
        setEditError(data.error || "更新失敗");
        return;
      }

      setEditingId(null);
      fetchWorkspaces();
    } catch {
      setEditError("網路錯誤");
    } finally {
      setEditSubmitting(false);
    }
  }

  function autoSlug(name: string): string {
    return name
      .toLowerCase()
      .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-")
      .replace(/^-|-$/g, "");
  }

  if (loading) {
    return <div className="text-sm text-[var(--muted-foreground)]">載入中...</div>;
  }

  return (
    <div className="mx-auto max-w-7xl">
      <Link
        href="/admin"
        className="mb-3 inline-flex items-center gap-1 text-xs text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
      >
        <ArrowLeft className="size-3" />
        返回 全域系統設定
      </Link>
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-[var(--foreground)]">工作區管理</h1>
          <p className="mt-0.5 text-xs text-[var(--muted-foreground)]">建立與管理系統中的工作空間</p>
        </div>
        <button
          onClick={() => setShowCreate(!showCreate)}
          className="rounded-md bg-[var(--primary)] px-3 py-1.5 text-sm font-medium text-[var(--primary-foreground)] hover:opacity-90"
        >
          {showCreate ? "取消" : "新增工作區"}
        </button>
      </div>

      {showCreate && (
        <form
          onSubmit={handleCreate}
          className="mb-6 space-y-3 rounded-lg border border-[var(--border)] bg-[var(--card)] p-4"
        >
          <div>
            <label className="mb-1 block text-xs text-[var(--muted-foreground)]">
              工作區名稱
            </label>
            <input
              type="text"
              placeholder="例如：品牌客服團隊"
              value={createForm.name}
              onChange={(e) => {
                const name = e.target.value;
                setCreateForm({ name, slug: autoSlug(name) });
              }}
              required
              className="w-full rounded-md border border-[var(--input)] bg-[var(--background)] px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[var(--ring)]"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs text-[var(--muted-foreground)]">
              Slug（URL 識別碼）
            </label>
            <input
              type="text"
              placeholder="brand-cs-team"
              value={createForm.slug}
              onChange={(e) =>
                setCreateForm({ ...createForm, slug: e.target.value })
              }
              required
              className="w-full rounded-md border border-[var(--input)] bg-[var(--background)] px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[var(--ring)]"
            />
          </div>

          {createError && (
            <p className="text-sm text-[var(--destructive)]">{createError}</p>
          )}
          <button
            type="submit"
            disabled={creating}
            className="rounded-md bg-[var(--primary)] px-4 py-2 text-sm font-medium text-[var(--primary-foreground)] hover:opacity-90 disabled:opacity-50"
          >
            {creating ? "建立中..." : "建立"}
          </button>
        </form>
      )}

      {workspaces.length === 0 ? (
        <p className="text-sm text-[var(--muted-foreground)]">
          目前沒有任何工作區。
        </p>
      ) : (
        <div className="space-y-2">
          {workspaces.map((ws) => (
            <div
              key={ws.id}
              className={`rounded-lg border border-[var(--border)] bg-[var(--card)] px-4 py-3 ${
                !ws.isActive ? "opacity-60" : ""
              }`}
            >
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-sm font-medium">
                    {ws.name}
                    {!ws.isActive && (
                      <span className="ml-2 inline-block rounded bg-[var(--destructive)]/10 px-1.5 py-0.5 text-xs text-[var(--destructive)]">
                        已停用
                      </span>
                    )}
                  </div>
                  <div className="mt-0.5 flex gap-3 text-xs text-[var(--muted-foreground)]">
                    <span>{ws.slug}</span>
                    <span>{ws.memberCount} 位成員</span>
                    <span>{ws.activePairingCount} 個配對</span>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() =>
                    editingId === ws.id ? cancelEditing() : startEditing(ws)
                  }
                  className="rounded-md border border-[var(--border)] px-2.5 py-1 text-xs hover:bg-[var(--bg-secondary)]"
                >
                  {editingId === ws.id ? "取消" : "編輯"}
                </button>
              </div>

              {editingId === ws.id && (
                <form
                  onSubmit={handleEditSave}
                  className="mt-3 space-y-3 border-t border-[var(--border)] pt-3"
                >
                  <div>
                    <label className="mb-1 block text-xs text-[var(--muted-foreground)]">
                      工作區名稱
                    </label>
                    <input
                      type="text"
                      value={editForm.name}
                      onChange={(e) =>
                        setEditForm({ ...editForm, name: e.target.value })
                      }
                      required
                      className="w-full rounded-md border border-[var(--input)] bg-[var(--background)] px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[var(--ring)]"
                    />
                  </div>

                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={editForm.isActive}
                      onChange={(e) =>
                        setEditForm({ ...editForm, isActive: e.target.checked })
                      }
                    />
                    {editForm.isActive ? "啟用中" : "已停用"}
                  </label>

                  {editError && (
                    <p className="text-sm text-[var(--destructive)]">
                      {editError}
                    </p>
                  )}

                  <button
                    type="submit"
                    disabled={editSubmitting}
                    className="rounded-md bg-[var(--primary)] px-4 py-2 text-sm font-medium text-[var(--primary-foreground)] hover:opacity-90 disabled:opacity-50"
                  >
                    {editSubmitting ? "儲存中..." : "儲存"}
                  </button>
                </form>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
