"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, ChevronDown } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

type User = {
  id: string;
  username: string;
  displayName: string;
  isSystemAdmin: boolean;
  isActive: boolean;
};

type WorkspaceSummary = {
  id: string;
  name: string;
  slug: string;
};

type RoleSummary = {
  id: string;
  name: string;
  description?: string | null;
};

type Assignment = {
  _key: string;
  workspaceId: string;
  roleIds: string[];
};

type EditForm = {
  displayName: string;
  isActive: boolean;
  isSystemAdmin: boolean;
  password: string;
};

let _assignmentKeyCounter = 0;
function makeAssignmentKey(): string {
  _assignmentKeyCounter += 1;
  return `a_${_assignmentKeyCounter}`;
}

export default function AdminUsersPage() {
  const { confirm } = useToast();
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState({
    username: "",
    password: "",
    displayName: "",
    isSystemAdmin: false,
  });
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // Workspace assignment state
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([]);
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [rolesByWorkspace, setRolesByWorkspace] = useState<
    Record<string, RoleSummary[]>
  >({});

  // Edit state
  const [editingUserId, setEditingUserId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<EditForm>({
    displayName: "",
    isActive: true,
    isSystemAdmin: false,
    password: "",
  });
  const [editAssignments, setEditAssignments] = useState<Assignment[]>([]);
  // 編輯模式下、剛 mount 時抓回來的原始 assignments — 用來判斷送出時要不要帶 workspaceAssignments
  const [editAssignmentsOriginal, setEditAssignmentsOriginal] = useState<Assignment[]>([]);
  const [editError, setEditError] = useState("");
  const [editSubmitting, setEditSubmitting] = useState(false);

  async function fetchUsers() {
    const res = await fetch("/api/admin/users");
    if (res.ok) {
      const data = await res.json();
      setUsers(data.users);
    }
    setLoading(false);
  }

  async function fetchWorkspaces() {
    try {
      const res = await fetch("/api/workspaces");
      if (res.ok) {
        const data = await res.json();
        setWorkspaces(
          (data.workspaces || []).map((w: { id: string; name: string; slug: string }) => ({
            id: w.id,
            name: w.name,
            slug: w.slug,
          }))
        );
      }
    } catch {
      // Fallback: empty list — admin can still create users without assignments
    }
  }

  async function fetchRolesForWorkspace(workspaceId: string) {
    if (rolesByWorkspace[workspaceId]) return;
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/roles`);
      if (res.ok) {
        const data = await res.json();
        setRolesByWorkspace((prev) => ({
          ...prev,
          [workspaceId]: (data.roles || []).map((r: RoleSummary) => ({
            id: r.id,
            name: r.name,
            description: r.description,
          })),
        }));
      } else {
        setRolesByWorkspace((prev) => ({ ...prev, [workspaceId]: [] }));
      }
    } catch {
      setRolesByWorkspace((prev) => ({ ...prev, [workspaceId]: [] }));
    }
  }

  useEffect(() => {
    fetchUsers();
    fetchWorkspaces();
  }, []);

  function addAssignment() {
    setAssignments((prev) => [
      ...prev,
      { _key: makeAssignmentKey(), workspaceId: "", roleIds: [] },
    ]);
  }

  function removeAssignment(idx: number) {
    setAssignments((prev) => prev.filter((_, i) => i !== idx));
  }

  function updateAssignmentWorkspace(idx: number, wsId: string) {
    setAssignments((prev) =>
      prev.map((a, i) => (i === idx ? { ...a, workspaceId: wsId, roleIds: [] } : a))
    );
    if (wsId) fetchRolesForWorkspace(wsId);
  }

  function toggleAssignmentRole(idx: number, roleId: string) {
    setAssignments((prev) =>
      prev.map((a, i) => {
        if (i !== idx) return a;
        const set = new Set(a.roleIds);
        if (set.has(roleId)) set.delete(roleId);
        else set.add(roleId);
        return { ...a, roleIds: Array.from(set) };
      })
    );
  }

  function resetForm() {
    setForm({ username: "", password: "", displayName: "", isSystemAdmin: false });
    setAssignments([]);
    setError("");
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setError("");

    // Validate assignments: each with a workspaceId, no duplicates
    const filled = assignments.filter((a) => a.workspaceId);
    const seenWs = new Set<string>();
    for (const a of filled) {
      if (seenWs.has(a.workspaceId)) {
        setError("工作空間不可重複指派");
        return;
      }
      seenWs.add(a.workspaceId);
    }

    setSubmitting(true);

    try {
      const payload: Record<string, unknown> = { ...form };
      if (filled.length > 0) {
        payload.workspaceAssignments = filled.map((a) => ({
          workspaceId: a.workspaceId,
          roleIds: a.roleIds,
        }));
      }

      const res = await fetch("/api/admin/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const data = await res.json();
        setError(data.error || "建立失敗");
        return;
      }

      resetForm();
      setShowAdd(false);
      fetchUsers();
    } catch {
      setError("網路錯誤");
    } finally {
      setSubmitting(false);
    }
  }

  async function startEditing(user: User) {
    setEditingUserId(user.id);
    setEditForm({
      displayName: user.displayName,
      isActive: user.isActive,
      isSystemAdmin: user.isSystemAdmin,
      password: "",
    });
    setEditAssignments([]);
    setEditAssignmentsOriginal([]);
    setEditError("");

    // 抓 user 完整資料（含 memberships + userRoles）→ 還原成 Assignment[] 給編輯表單用
    try {
      const res = await fetch(`/api/admin/users/${user.id}`);
      if (!res.ok) return;
      const data = await res.json();
      type FetchedUser = {
        memberships?: Array<{
          workspaceId: string;
          isActive: boolean;
        }>;
        userRoles?: Array<{
          role: { id: string; workspaceId: string };
        }>;
      };
      const u: FetchedUser = data.user || {};
      const activeWsIds = (u.memberships || [])
        .filter((m) => m.isActive)
        .map((m) => m.workspaceId);
      const rolesByWs: Record<string, string[]> = {};
      for (const ur of u.userRoles || []) {
        const wsId = ur.role.workspaceId;
        if (!rolesByWs[wsId]) rolesByWs[wsId] = [];
        rolesByWs[wsId].push(ur.role.id);
      }
      const built: Assignment[] = activeWsIds.map((wsId) => ({
        _key: makeAssignmentKey(),
        workspaceId: wsId,
        roleIds: rolesByWs[wsId] || [],
      }));
      setEditAssignments(built);
      setEditAssignmentsOriginal(built);
      // 預載每個 workspace 的 roles 清單給 chip 用
      for (const wsId of activeWsIds) fetchRolesForWorkspace(wsId);
    } catch {
      // ignore — 編輯表單仍可用
    }
  }

  function cancelEditing() {
    setEditingUserId(null);
    setEditError("");
    setEditAssignments([]);
    setEditAssignmentsOriginal([]);
  }

  // ── 編輯表單的 assignment 操作（mirror 新增表單那組） ──
  function editAddAssignment() {
    setEditAssignments((prev) => [
      ...prev,
      { _key: makeAssignmentKey(), workspaceId: "", roleIds: [] },
    ]);
  }
  function editRemoveAssignment(idx: number) {
    setEditAssignments((prev) => prev.filter((_, i) => i !== idx));
  }
  function editUpdateAssignmentWorkspace(idx: number, wsId: string) {
    setEditAssignments((prev) =>
      prev.map((a, i) => (i === idx ? { ...a, workspaceId: wsId, roleIds: [] } : a)),
    );
    if (wsId) fetchRolesForWorkspace(wsId);
  }
  function editToggleAssignmentRole(idx: number, roleId: string) {
    setEditAssignments((prev) =>
      prev.map((a, i) => {
        if (i !== idx) return a;
        const set = new Set(a.roleIds);
        if (set.has(roleId)) set.delete(roleId);
        else set.add(roleId);
        return { ...a, roleIds: Array.from(set) };
      }),
    );
  }

  async function handleEditSave(e: React.FormEvent) {
    e.preventDefault();
    if (!editingUserId) return;
    setEditError("");
    setEditSubmitting(true);

    try {
      const original = users.find((u) => u.id === editingUserId);
      if (!original) return;

      const payload: Record<string, unknown> = {};
      if (editForm.displayName !== original.displayName) {
        payload.displayName = editForm.displayName;
      }
      if (editForm.isActive !== original.isActive) {
        payload.isActive = editForm.isActive;
      }
      if (editForm.isSystemAdmin !== original.isSystemAdmin) {
        payload.isSystemAdmin = editForm.isSystemAdmin;
      }
      if (editForm.password.length > 0) {
        if (editForm.password.length < 8) {
          setEditError("密碼至少需要 8 個字元");
          return;
        }
        payload.password = editForm.password;
      }

      // 比對 assignments 有無實質變動（避免每次按儲存都觸發後端 replace 流程）
      const filledAssignments = editAssignments.filter((a) => a.workspaceId);
      const seenWs = new Set<string>();
      for (const a of filledAssignments) {
        if (seenWs.has(a.workspaceId)) {
          setEditError("工作空間不可重複指派");
          return;
        }
        seenWs.add(a.workspaceId);
      }
      const normalize = (list: Assignment[]) =>
        list
          .filter((a) => a.workspaceId)
          .map((a) => ({
            workspaceId: a.workspaceId,
            roleIds: [...a.roleIds].sort(),
          }))
          .sort((x, y) => x.workspaceId.localeCompare(y.workspaceId));
      const before = JSON.stringify(normalize(editAssignmentsOriginal));
      const after = JSON.stringify(normalize(filledAssignments));
      if (before !== after) {
        payload.workspaceAssignments = filledAssignments.map((a) => ({
          workspaceId: a.workspaceId,
          roleIds: a.roleIds,
        }));
      }

      if (Object.keys(payload).length === 0) {
        setEditError("沒有需要更新的欄位");
        return;
      }

      // Destructive changes need explicit confirmation — deactivating a user
      // logs them out everywhere; revoking system admin can lock people out
      // of admin tools. Additive changes don't need this guard.
      if (payload.isActive === false && original.isActive) {
        const ok = await confirm({
          message: `確定要停用使用者「${original.displayName}」？此操作會登出該使用者所有 session。`,
          danger: true,
        });
        if (!ok) { setEditSubmitting(false); return; }
      }
      if (payload.isSystemAdmin === false && original.isSystemAdmin) {
        const ok = await confirm({
          message: `確定要取消使用者「${original.displayName}」的系統管理員權限？`,
          danger: true,
        });
        if (!ok) { setEditSubmitting(false); return; }
      }

      const res = await fetch(`/api/admin/users/${editingUserId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const data = await res.json();
        setEditError(data.error || "更新失敗");
        return;
      }

      setEditingUserId(null);
      fetchUsers();
    } catch {
      setEditError("網路錯誤");
    } finally {
      setEditSubmitting(false);
    }
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
          <h1 className="text-xl font-bold tracking-tight text-[var(--foreground)]">系統帳號管理</h1>
          <p className="mt-0.5 text-xs text-[var(--muted-foreground)]">管理系統帳號、權限與工作空間指派</p>
        </div>
        <button
          onClick={() => setShowAdd(!showAdd)}
          className="rounded-md bg-[var(--primary)] px-3 py-1.5 text-sm font-medium text-[var(--primary-foreground)] hover:opacity-90"
        >
          {showAdd ? "取消" : "新增使用者"}
        </button>
      </div>

      {showAdd && (
        <form
          onSubmit={handleCreate}
          className="mb-6 space-y-3 rounded-lg border border-[var(--border)] bg-[var(--card)] p-4"
        >
          <input
            type="text"
            placeholder="顯示名稱"
            value={form.displayName}
            onChange={(e) =>
              setForm({ ...form, displayName: e.target.value })
            }
            required
            className="w-full rounded-md border border-[var(--input)] bg-[var(--background)] px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[var(--ring)]"
          />
          <input
            type="text"
            placeholder="帳號"
            value={form.username}
            onChange={(e) => setForm({ ...form, username: e.target.value })}
            required
            className="w-full rounded-md border border-[var(--input)] bg-[var(--background)] px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[var(--ring)]"
          />
          <div>
            <input
              type="password"
              placeholder="密碼（至少 8 字元）"
              value={form.password}
              onChange={(e) => setForm({ ...form, password: e.target.value })}
              required
              minLength={8}
              className="w-full rounded-md border border-[var(--input)] bg-[var(--background)] px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[var(--ring)]"
            />
            {form.password.length > 0 && form.password.length < 8 && (
              <p className="mt-1 text-xs text-[var(--destructive)]">
                密碼至少需要 8 個字元（目前 {form.password.length}）
              </p>
            )}
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={form.isSystemAdmin}
              onChange={(e) =>
                setForm({ ...form, isSystemAdmin: e.target.checked })
              }
            />
            系統管理員
          </label>

          {/* Workspace assignments — 系統管理員不需指派 */}
          <div
            className={`space-y-2 rounded-md border border-[var(--border)] p-3 ${
              form.isSystemAdmin ? "opacity-50 pointer-events-none" : ""
            }`}
            aria-disabled={form.isSystemAdmin}
          >
            <div className="flex items-center justify-between">
              <div className="text-sm font-medium">
                指派工作空間（可不填）
                {form.isSystemAdmin && (
                  <span
                    className="ml-2 text-xs font-normal text-[var(--primary)]"
                    title="系統管理員是 workspace 之上的 super-user — 任何工作空間都進得去、所有權限都已啟用，再勾身份組是多餘的。"
                  >
                    🚀 權限全開、上天下海，已不需要指派工作空間
                  </span>
                )}
              </div>
              <button
                type="button"
                onClick={addAssignment}
                disabled={form.isSystemAdmin}
                className="text-xs text-[var(--primary)] hover:underline disabled:cursor-not-allowed"
              >
                + 新增
              </button>
            </div>
            {workspaces.length === 0 && (
              <p className="text-xs text-[var(--muted-foreground)]">
                （目前沒有可指派的工作空間，或需要先成為其成員）
              </p>
            )}
            {assignments.length === 0 ? (
              <p className="text-xs text-[var(--muted-foreground)]">
                未指派任何工作空間。建立後仍可於成員頁面手動加入。
              </p>
            ) : (
              assignments.map((a, idx) => {
                const roles = a.workspaceId
                  ? rolesByWorkspace[a.workspaceId] || []
                  : [];
                return (
                  <div
                    key={a._key}
                    className="flex flex-wrap items-start gap-2 rounded border border-[var(--border)] p-2"
                  >
                    <select
                      value={a.workspaceId}
                      onChange={(e) => updateAssignmentWorkspace(idx, e.target.value)}
                      className="rounded border border-[var(--input)] bg-[var(--background)] px-2 py-1 text-xs outline-none"
                    >
                      <option value="">選擇工作空間</option>
                      {workspaces.map((w) => (
                        <option key={w.id} value={w.id}>
                          {w.name}
                        </option>
                      ))}
                    </select>
                    {a.workspaceId && (
                      <div className="flex flex-wrap gap-1">
                        {roles.length === 0 ? (
                          <span className="text-xs text-[var(--muted-foreground)]">
                            （此工作空間無可用身份組，或無權限讀取）
                          </span>
                        ) : (
                          roles.map((r) => {
                            const selected = a.roleIds.includes(r.id);
                            return (
                              <button
                                key={r.id}
                                type="button"
                                onClick={() => toggleAssignmentRole(idx, r.id)}
                                className={`text-xs px-2 py-1 rounded border ${
                                  selected
                                    ? "bg-[var(--primary)] text-[var(--primary-foreground)] border-[var(--primary)]"
                                    : "border-[var(--border)] hover:bg-[var(--bg-secondary)]"
                                }`}
                              >
                                {r.name}
                              </button>
                            );
                          })
                        )}
                      </div>
                    )}
                    <button
                      type="button"
                      onClick={() => removeAssignment(idx)}
                      className="ml-auto text-xs text-[var(--destructive)] hover:underline"
                    >
                      移除
                    </button>
                  </div>
                );
              })
            )}
          </div>

          {error && (
            <p className="text-sm text-[var(--destructive)]">{error}</p>
          )}
          <button
            type="submit"
            disabled={submitting}
            className="rounded-md bg-[var(--primary)] px-4 py-2 text-sm font-medium text-[var(--primary-foreground)] hover:opacity-90 disabled:opacity-50"
          >
            {submitting ? "建立中..." : "建立"}
          </button>
        </form>
      )}

      <div className="space-y-2">
        {users.map((u) => {
          const isOpen = editingUserId === u.id;
          return (
          <div
            key={u.id}
            className={`rounded-lg border border-[var(--border)] bg-[var(--card)] ${
              !u.isActive ? "opacity-60" : ""
            }`}
          >
            {/* 整個 header 列都可點，按下去 toggle 卡片展開 — 鼠標不用瞄那顆按鈕 */}
            <button
              type="button"
              onClick={() => (isOpen ? cancelEditing() : startEditing(u))}
              className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left hover:bg-[var(--bg-secondary)]/40 rounded-lg transition-colors"
              aria-expanded={isOpen}
            >
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium">
                  {u.displayName}
                  {u.isSystemAdmin && (
                    <span className="ml-2 inline-block rounded bg-[var(--primary)]/10 px-1.5 py-0.5 text-xs text-[var(--primary)]">
                      系統管理員
                    </span>
                  )}
                  {!u.isActive && (
                    <span className="ml-2 inline-block rounded bg-[var(--destructive)]/10 px-1.5 py-0.5 text-xs text-[var(--destructive)]">
                      已停用
                    </span>
                  )}
                </div>
                <div className="text-xs text-[var(--muted-foreground)]">
                  {u.username}
                </div>
              </div>
              <ChevronDown
                className={`size-4 text-[var(--muted-foreground)] transition-transform shrink-0 ${
                  isOpen ? "rotate-180" : ""
                }`}
              />
            </button>

            {isOpen && (
              <form
                onSubmit={handleEditSave}
                onClick={(e) => e.stopPropagation()}
                className="mx-4 mb-3 space-y-3 border-t border-[var(--border)] pt-3"
              >
                <div>
                  <label className="mb-1 block text-xs text-[var(--muted-foreground)]">
                    顯示名稱
                  </label>
                  <input
                    type="text"
                    value={editForm.displayName}
                    onChange={(e) =>
                      setEditForm({ ...editForm, displayName: e.target.value })
                    }
                    required
                    className="w-full rounded-md border border-[var(--input)] bg-[var(--background)] px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[var(--ring)]"
                  />
                </div>

                <div className="flex flex-wrap gap-4">
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
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={editForm.isSystemAdmin}
                      onChange={(e) =>
                        setEditForm({
                          ...editForm,
                          isSystemAdmin: e.target.checked,
                        })
                      }
                    />
                    系統管理員
                  </label>
                </div>

                <div>
                  <label className="mb-1 block text-xs text-[var(--muted-foreground)]">
                    重設密碼（選填）
                  </label>
                  <input
                    type="password"
                    placeholder="留空則不變更"
                    value={editForm.password}
                    onChange={(e) =>
                      setEditForm({ ...editForm, password: e.target.value })
                    }
                    minLength={8}
                    className="w-full rounded-md border border-[var(--input)] bg-[var(--background)] px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[var(--ring)]"
                  />
                  {editForm.password.length > 0 && editForm.password.length < 8 && (
                    <p className="mt-1 text-xs text-[var(--destructive)]">
                      密碼至少需要 8 個字元（目前 {editForm.password.length}）
                    </p>
                  )}
                </div>

                {/* Workspace assignments — 系統管理員權限大於一切，指派工作空間沒意義，整塊 disable */}
                <div
                  className={`space-y-2 rounded-md border border-[var(--border)] p-3 ${
                    editForm.isSystemAdmin ? "opacity-50 pointer-events-none" : ""
                  }`}
                  aria-disabled={editForm.isSystemAdmin}
                >
                  <div className="flex items-center justify-between">
                    <div className="text-sm font-medium">
                      指派工作空間
                      {editForm.isSystemAdmin && (
                        <span
                          className="ml-2 text-xs font-normal text-[var(--primary)]"
                          title="系統管理員是 workspace 之上的 super-user — 任何工作空間都進得去、所有權限都已啟用，再勾身份組是多餘的。"
                        >
                          🚀 權限全開、上天下海，已不需要指派工作空間
                        </span>
                      )}
                    </div>
                    <button
                      type="button"
                      onClick={editAddAssignment}
                      disabled={editForm.isSystemAdmin}
                      className="text-xs text-[var(--primary)] hover:underline disabled:cursor-not-allowed"
                    >
                      + 新增
                    </button>
                  </div>
                  {workspaces.length === 0 && (
                    <p className="text-xs text-[var(--muted-foreground)]">
                      （目前沒有可指派的工作空間）
                    </p>
                  )}
                  {editAssignments.length === 0 ? (
                    <p className="text-xs text-[var(--muted-foreground)]">
                      此使用者目前未指派任何工作空間。
                    </p>
                  ) : (
                    editAssignments.map((a, idx) => {
                      const roles = a.workspaceId
                        ? rolesByWorkspace[a.workspaceId] || []
                        : [];
                      return (
                        <div
                          key={a._key}
                          className="flex flex-wrap items-start gap-2 rounded border border-[var(--border)] p-2"
                        >
                          <select
                            value={a.workspaceId}
                            onChange={(e) =>
                              editUpdateAssignmentWorkspace(idx, e.target.value)
                            }
                            disabled={editForm.isSystemAdmin}
                            className="rounded border border-[var(--input)] bg-[var(--background)] px-2 py-1 text-xs outline-none disabled:cursor-not-allowed"
                          >
                            <option value="">選擇工作空間</option>
                            {workspaces.map((w) => (
                              <option key={w.id} value={w.id}>
                                {w.name}
                              </option>
                            ))}
                          </select>
                          {a.workspaceId && (
                            <div className="flex flex-wrap gap-1">
                              {roles.length === 0 ? (
                                <span className="text-xs text-[var(--muted-foreground)]">
                                  （此工作空間無可用身份組，或載入中）
                                </span>
                              ) : (
                                roles.map((r) => {
                                  const selected = a.roleIds.includes(r.id);
                                  return (
                                    <button
                                      key={r.id}
                                      type="button"
                                      onClick={() =>
                                        editToggleAssignmentRole(idx, r.id)
                                      }
                                      disabled={editForm.isSystemAdmin}
                                      className={`text-xs px-2 py-1 rounded border ${
                                        selected
                                          ? "bg-[var(--primary)] text-[var(--primary-foreground)] border-[var(--primary)]"
                                          : "border-[var(--border)] hover:bg-[var(--bg-secondary)]"
                                      } disabled:cursor-not-allowed`}
                                    >
                                      {r.name}
                                    </button>
                                  );
                                })
                              )}
                            </div>
                          )}
                          <button
                            type="button"
                            onClick={() => editRemoveAssignment(idx)}
                            disabled={editForm.isSystemAdmin}
                            className="ml-auto text-xs text-[var(--destructive)] hover:underline disabled:cursor-not-allowed"
                          >
                            移除
                          </button>
                        </div>
                      );
                    })
                  )}
                </div>

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
          );
        })}
      </div>
    </div>
  );
}
