"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { Sidebar } from "@/components/layout/sidebar";
import { useToast } from "@/hooks/use-toast";

type Workspace = {
  id: string;
  name: string;
  slug: string;
  roles?: string[];
  memberCount?: number;
  isMember?: boolean;
};

type WorkspaceMember = {
  id: string;
  user: {
    id: string;
    username: string;
    displayName: string;
    isActive: boolean;
    userRoles: { role: { id: string; name: string } }[];
  };
};

type WorkspaceRole = {
  id: string;
  name: string;
};

type SystemUser = {
  id: string;
  username: string;
  displayName: string;
  isActive: boolean;
};

export default function WorkspaceListPage() {
  // 進到「最外層工作空間選擇器」= 使用者明確離開所有工作空間 context。
  // 把「最後造訪 workspace」cookie 清掉，這樣之後點「全域系統設定」會走乾淨模式
  // （admin layout 讀不到 cookie → 不帶 workspace sidebar）。
  useEffect(() => {
    document.cookie = "switchboard_last_workspace=; path=/; max-age=0; SameSite=Lax";
  }, []);

  const { toast, confirm } = useToast();
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [loading, setLoading] = useState(true);
  const [isAdmin, setIsAdmin] = useState(false);
  const [userName, setUserName] = useState("");

  const [showCreate, setShowCreate] = useState(false);
  const [createForm, setCreateForm] = useState({ name: "", slug: "" });
  const [createError, setCreateError] = useState("");
  const [creating, setCreating] = useState(false);

  const [actionLoading, setActionLoading] = useState<Record<string, boolean>>({});
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  // Member management
  const [managingWsId, setManagingWsId] = useState<string | null>(null);
  const [wsMembers, setWsMembers] = useState<WorkspaceMember[]>([]);
  const [wsRoles, setWsRoles] = useState<WorkspaceRole[]>([]);
  const [membersLoading, setMembersLoading] = useState(false);

  // Add member
  const [allUsers, setAllUsers] = useState<SystemUser[]>([]);
  const [userSearch, setUserSearch] = useState("");
  const [addingUserId, setAddingUserId] = useState<string | null>(null);
  // 下拉清單顯示控制（focus 開啟、外部點擊或 ESC 關閉）+ 鍵盤 highlighted index
  const [isAddOpen, setIsAddOpen] = useState(false);
  const [highlightedIdx, setHighlightedIdx] = useState(0);

  // Role editing
  const [editingMemberId, setEditingMemberId] = useState<string | null>(null);
  const [editRoleIds, setEditRoleIds] = useState<string[]>([]);
  const [savingRoles, setSavingRoles] = useState(false);

  const fetchWorkspaces = useCallback(async () => {
    try {
      const [wsRes, meRes] = await Promise.all([
        fetch("/api/workspaces"),
        fetch("/api/auth/me"),
      ]);
      if (wsRes.ok) {
        const data = await wsRes.json();
        setWorkspaces(data.workspaces || []);
      }
      if (meRes.ok) {
        const me = await meRes.json();
        setIsAdmin(me.user?.isSystemAdmin ?? false);
        setUserName(me.user?.displayName ?? "");
      }
    } catch { /* */ }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { fetchWorkspaces(); }, [fetchWorkspaces]);

  // Fetch all system users (for admin adding members)
  useEffect(() => {
    if (!isAdmin) return;
    fetch("/api/admin/users")
      .then((r) => r.ok ? r.json() : { users: [] })
      .then((d) => setAllUsers(d.users || []));
  }, [isAdmin]);

  async function fetchWsMembers(wsId: string) {
    setMembersLoading(true);
    const [membersRes, rolesRes] = await Promise.all([
      fetch(`/api/workspaces/${wsId}/members`),
      fetch(`/api/workspaces/${wsId}/roles`),
    ]);
    if (membersRes.ok) {
      const d = await membersRes.json();
      setWsMembers(d.members || []);
    }
    if (rolesRes.ok) {
      const d = await rolesRes.json();
      setWsRoles((d.roles || []).map((r: WorkspaceRole) => ({ id: r.id, name: r.name })));
    }
    setMembersLoading(false);
  }

  function toggleManage(wsId: string) {
    if (managingWsId === wsId) {
      setManagingWsId(null);
      setEditingMemberId(null);
    } else {
      setManagingWsId(wsId);
      setEditingMemberId(null);
      setUserSearch("");
      fetchWsMembers(wsId);
    }
  }

  // ─── Create workspace ─────────────────────────────────────

  function autoSlug(name: string): string {
    return name.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-").replace(/^-|-$/g, "");
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setCreateError("");
    const name = createForm.name.trim();
    if (!name) {
      setCreateError("請填寫工作空間名稱");
      return;
    }
    setCreating(true);
    try {
      // slug 由後端自動從 name 產生（並處理衝突），前端不再送 slug
      const res = await fetch("/api/workspaces", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (!res.ok) { const d = await res.json(); setCreateError(d.error || "建立失敗"); return; }
      setCreateForm({ name: "", slug: "" });
      setShowCreate(false);
      fetchWorkspaces();
    } catch { setCreateError("網路錯誤"); }
    finally { setCreating(false); }
  }

  // ─── Join / Delete workspace ──────────────────────────────

  async function handleJoin(wsId: string) {
    setActionLoading((p) => ({ ...p, [wsId]: true }));
    try {
      const res = await fetch(`/api/admin/workspaces/${wsId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (res.ok) fetchWorkspaces();
    } catch { /* */ }
    finally { setActionLoading((p) => ({ ...p, [wsId]: false })); }
  }

  async function handleDelete(wsId: string) {
    setActionLoading((p) => ({ ...p, [wsId]: true }));
    try {
      const res = await fetch(`/api/admin/workspaces/${wsId}`, { method: "DELETE" });
      if (res.ok) { setConfirmDelete(null); fetchWorkspaces(); }
    } catch { /* */ }
    finally { setActionLoading((p) => ({ ...p, [wsId]: false })); }
  }

  // ─── Add member ───────────────────────────────────────────

  async function handleAddMember(wsId: string, userId: string) {
    setAddingUserId(userId);
    try {
      const res = await fetch(`/api/workspaces/${wsId}/members`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId }),
      });
      if (res.ok) {
        fetchWsMembers(wsId);
        fetchWorkspaces();
        setUserSearch("");
      } else {
        const d = await res.json();
        toast.error(d.error || "新增失敗");
      }
    } catch { toast.error("網路錯誤"); }
    finally { setAddingUserId(null); }
  }

  // ─── Remove member ────────────────────────────────────────

  async function handleRemoveMember(wsId: string, membershipId: string) {
    if (!await confirm({ message: "確定要移除此成員？成員將無法再存取此工作區。", danger: true })) return;
    try {
      const res = await fetch(`/api/workspaces/${wsId}/members`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ membershipId, isActive: false }),
      });
      if (res.ok) {
        fetchWsMembers(wsId);
        fetchWorkspaces();
      } else {
        const data = await res.json().catch(() => ({}));
        toast.error(data.error || "移除失敗，請稍後再試");
      }
    } catch {
      toast.error("網路錯誤，無法移除成員");
    }
  }

  // ─── Save roles ───────────────────────────────────────────

  function startEditRoles(member: WorkspaceMember) {
    setEditingMemberId(member.id);
    setEditRoleIds(member.user.userRoles.map((ur) => ur.role.id));
  }

  function toggleRole(roleId: string) {
    setEditRoleIds((prev) =>
      prev.includes(roleId) ? prev.filter((id) => id !== roleId) : [...prev, roleId]
    );
  }

  async function saveRoles(wsId: string, membershipId: string) {
    setSavingRoles(true);
    try {
      const res = await fetch(`/api/workspaces/${wsId}/members`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ membershipId, roleIds: editRoleIds }),
      });
      if (res.ok) {
        fetchWsMembers(wsId);
        setEditingMemberId(null);
      }
    } catch { /* */ }
    finally { setSavingRoles(false); }
  }

  // ─── Filtered users for add ───────────────────────────────
  // Combobox 模式：focus 時無條件顯示「全部可加入的人」；打字時 filter。
  // 「可加入 = isActive && 尚未是此 workspace 成員」

  const memberUserIds = new Set(wsMembers.map((m) => m.user.id));
  const eligibleUsers = allUsers.filter(
    (u) => u.isActive && !memberUserIds.has(u.id),
  );
  const searchLower = userSearch.toLowerCase();
  const filteredUsers = userSearch.length > 0
    ? eligibleUsers.filter(
        (u) =>
          u.displayName.toLowerCase().includes(searchLower) ||
          u.username.toLowerCase().includes(searchLower),
      )
    : eligibleUsers;

  // ─── Render ───────────────────────────────────────────────

  if (loading) {
    return (
      <div className="flex h-dvh items-center justify-center">
        <div className="text-sm text-[var(--muted-foreground)]">載入中...</div>
      </div>
    );
  }

  // 系統管理員擁有全域存取權，不該看到「未加入 / 加入」這種 membership 狀態 —
  // 對他們而言所有工作空間就是「能進去」，joined / unjoined 沒意義。
  // 非管理員：永遠只看得到自己被加入的（API 那邊已經 filter 掉了）。
  const allWsList = workspaces;

  return (
    <div className="flex h-dvh overflow-hidden">
      <Sidebar userName={userName} isSystemAdmin={isAdmin} />
      <main className="flex-1 overflow-y-auto pt-14 md:pt-0">
        <div className="mx-auto max-w-4xl px-4 py-8">
          <div className="mb-6 flex items-center justify-between">
            <h1 className="text-lg font-semibold text-[var(--foreground)]">選擇工作空間</h1>
            {isAdmin && (
              <button
                onClick={() => setShowCreate(!showCreate)}
                className="rounded-md bg-[var(--primary)] px-3 py-1.5 text-sm font-medium text-[var(--primary-foreground)] hover:opacity-90"
              >
                {showCreate ? "取消" : "建立工作空間"}
              </button>
            )}
          </div>

          {/* Create form
              識別碼（slug）由後端自動產生（基於名稱 + 衝突遞增），不暴露給使用者。
              用戶只需要填名稱就好；slug 是內部欄位，沒在 URL 用到，沒理由占用使用者注意力。 */}
          {showCreate && (
            <form onSubmit={handleCreate} className="mb-6 space-y-3 rounded-lg border border-[var(--border)] bg-[var(--card)] p-4">
              <div>
                <label className="mb-1 block text-xs text-[var(--muted-foreground)]">工作空間名稱</label>
                <input type="text" value={createForm.name}
                  onChange={(e) => setCreateForm({ name: e.target.value, slug: autoSlug(e.target.value) })}
                  required placeholder="例：客服一部"
                  className="w-full rounded-md border border-[var(--input)] bg-[var(--background)] px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[var(--ring)]" />
              </div>
              {createError && <p className="text-sm text-[var(--destructive)]">{createError}</p>}
              <button type="submit" disabled={creating}
                className="rounded-md bg-[var(--primary)] px-4 py-2 text-sm font-medium text-[var(--primary-foreground)] hover:opacity-90 disabled:opacity-50">
                {creating ? "建立中..." : "建立"}
              </button>
            </form>
          )}

          {allWsList.length === 0 ? (
            <p className="text-sm text-[var(--muted-foreground)]">
              {isAdmin ? "目前沒有任何工作空間。點擊「建立工作空間」開始。" : "尚未被指派任何工作空間。請聯繫管理員。"}
            </p>
          ) : (
            <div className="space-y-3">
              {allWsList.map((ws) => {
                const isManaging = managingWsId === ws.id;

                return (
                  <div key={ws.id} className="rounded-lg border border-[var(--border)] bg-[var(--card)] transition-colors">
                    {/* Card header */}
                    <div className="flex items-center gap-3 p-4">
                      <Link href={`/workspace/${ws.id}/direct-chat`} className="flex-1 min-w-0">
                        <h3 className="font-medium text-[var(--foreground)] truncate">{ws.name}</h3>
                        <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-[var(--muted-foreground)]">
                          {ws.roles && ws.roles.length > 0 && <span>{ws.roles.join("、")}</span>}
                          {ws.memberCount !== undefined && <span>{ws.memberCount} 名成員</span>}
                        </div>
                      </Link>

                      <div className="flex items-center gap-1.5 shrink-0">
                        {/* 「加入工作空間」按鈕已移除：系統管理員擁有全域權限不需加入；
                            非系統管理員看到的清單已是 API 端過濾後的「自己已加入」清單。
                            handleJoin 暫時保留供未來其他流程使用。 */}
                        {isAdmin && (
                          <button onClick={() => toggleManage(ws.id)}
                            className={`rounded-md border px-2.5 py-1 text-xs font-medium transition-colors ${
                              isManaging
                                ? "border-[var(--primary)] bg-[var(--primary)]/10 text-[var(--primary)]"
                                : "border-[var(--border)] hover:bg-[var(--bg-secondary)]"
                            }`}>
                            {isManaging ? "收起" : "管理成員"}
                          </button>
                        )}
                        {isAdmin && (
                          confirmDelete === ws.id ? (
                            <div className="flex gap-1">
                              <button onClick={() => handleDelete(ws.id)} disabled={actionLoading[ws.id]}
                                className="rounded bg-[var(--destructive)] px-2 py-1 text-xs text-white hover:opacity-90 disabled:opacity-50">
                                {actionLoading[ws.id] ? "..." : "確認"}
                              </button>
                              <button onClick={() => setConfirmDelete(null)}
                                className="rounded border border-[var(--border)] px-2 py-1 text-xs hover:bg-[var(--bg-secondary)]">取消</button>
                            </div>
                          ) : (
                            <button onClick={() => setConfirmDelete(ws.id)}
                              className="rounded border border-[var(--destructive)]/30 px-2 py-1 text-xs text-[var(--destructive)] hover:bg-[var(--destructive)]/10">
                              刪除
                            </button>
                          )
                        )}
                      </div>
                    </div>

                    {/* Member management panel */}
                    {isManaging && (
                      <div className="border-t border-[var(--border)] px-4 py-3 space-y-3 bg-[var(--background)]">
                        {/* Add member combobox — focus 即展開全清單；可打字 filter；↑↓ Enter 操作 */}
                        <div className="relative">
                          <label className="mb-1 block text-xs font-medium text-[var(--muted-foreground)]">新增成員</label>
                          <input
                            type="text"
                            value={userSearch}
                            onChange={(e) => {
                              setUserSearch(e.target.value);
                              setHighlightedIdx(0);
                              setIsAddOpen(true);
                            }}
                            onFocus={() => {
                              setIsAddOpen(true);
                              setHighlightedIdx(0);
                            }}
                            onKeyDown={(e) => {
                              const visible = filteredUsers.slice(0, 8);
                              if (e.key === "ArrowDown") {
                                e.preventDefault();
                                setIsAddOpen(true);
                                setHighlightedIdx((i) =>
                                  Math.min(i + 1, Math.max(0, visible.length - 1)),
                                );
                              } else if (e.key === "ArrowUp") {
                                e.preventDefault();
                                setHighlightedIdx((i) => Math.max(0, i - 1));
                              } else if (e.key === "Enter") {
                                if (visible.length > 0 && highlightedIdx < visible.length) {
                                  e.preventDefault();
                                  handleAddMember(ws.id, visible[highlightedIdx].id);
                                }
                              } else if (e.key === "Escape") {
                                setIsAddOpen(false);
                              }
                            }}
                            placeholder={
                              eligibleUsers.length > 0
                                ? "點此選擇成員，或輸入文字篩選..."
                                : "目前無可加入的成員"
                            }
                            className="w-full rounded-md border border-[var(--input)] bg-[var(--card)] px-3 py-1.5 text-sm outline-none focus:ring-2 focus:ring-[var(--ring)]"
                          />
                          {/* 下拉清單 — 開啟時用 fixed-positioned overlay 接受點擊；
                              點選 click 在 input blur 之前發生，所以延遲關閉用 onMouseDown 攔截 */}
                          {isAddOpen && (
                            <>
                              {/* 透明 backdrop：點外部關閉 */}
                              <div
                                className="fixed inset-0 z-10"
                                onClick={() => setIsAddOpen(false)}
                              />
                              <div className="relative z-20">
                                {filteredUsers.length > 0 ? (
                                  <div className="absolute left-0 right-0 mt-1 max-h-48 overflow-y-auto rounded-md border border-[var(--border)] bg-[var(--card)] shadow-lg">
                                    {filteredUsers.slice(0, 8).map((u, idx) => {
                                      const isHi = idx === highlightedIdx;
                                      return (
                                        <button
                                          key={u.id}
                                          // onMouseDown 比 onClick + input.onBlur 早觸發 —
                                          // 用它確保「點擊清單」前 input 不會先 blur 把 list 收掉
                                          onMouseDown={(e) => {
                                            e.preventDefault();
                                            handleAddMember(ws.id, u.id);
                                            setIsAddOpen(false);
                                          }}
                                          onMouseEnter={() => setHighlightedIdx(idx)}
                                          disabled={addingUserId === u.id}
                                          className={`flex w-full items-center justify-between px-3 py-1.5 text-sm transition-colors disabled:opacity-50 ${
                                            isHi ? "bg-[var(--accent-bg)] text-[var(--accent)]" : "hover:bg-[var(--bg-secondary)]"
                                          }`}
                                        >
                                          <span>
                                            <span className="font-medium">{u.displayName}</span>
                                            <span className="ml-1.5 text-xs text-[var(--muted-foreground)]">@{u.username}</span>
                                          </span>
                                          <span className="text-xs text-[var(--primary)]">
                                            {addingUserId === u.id ? "加入中..." : "+ 加入"}
                                          </span>
                                        </button>
                                      );
                                    })}
                                  </div>
                                ) : (
                                  <div className="absolute left-0 right-0 mt-1 rounded-md border border-[var(--border)] bg-[var(--card)] px-3 py-2 text-xs text-[var(--muted-foreground)] shadow-lg">
                                    {eligibleUsers.length === 0
                                      ? "沒有可加入的成員"
                                      : "沒有符合的使用者"}
                                  </div>
                                )}
                              </div>
                            </>
                          )}
                        </div>

                        {/* Current members */}
                        <div>
                          <label className="mb-1 block text-xs font-medium text-[var(--muted-foreground)]">
                            目前成員 ({wsMembers.length})
                          </label>
                          {membersLoading ? (
                            <p className="text-xs text-[var(--muted-foreground)]">載入中...</p>
                          ) : wsMembers.length === 0 ? (
                            <p className="text-xs text-[var(--muted-foreground)]">尚無成員</p>
                          ) : (
                            <div className="space-y-1">
                              {wsMembers.map((m) => {
                                const isEditingThis = editingMemberId === m.id;
                                const currentRoleNames = m.user.userRoles.map((ur) => ur.role.name);

                                return (
                                  <div key={m.id} className="rounded-md border border-[var(--border)] bg-[var(--card)] px-3 py-2">
                                    <div className="flex items-center justify-between">
                                      <div className="min-w-0">
                                        <span className="text-sm font-medium">{m.user.displayName}</span>
                                        <span className="ml-1.5 text-xs text-[var(--muted-foreground)]">@{m.user.username}</span>
                                        {currentRoleNames.length > 0 && (
                                          <div className="mt-0.5 flex flex-wrap gap-1">
                                            {currentRoleNames.map((r) => (
                                              <span key={r} className="rounded-full bg-[var(--primary)]/10 px-2 py-px text-[10px] font-medium text-[var(--primary)]">{r}</span>
                                            ))}
                                          </div>
                                        )}
                                      </div>
                                      <div className="flex items-center gap-1 shrink-0">
                                        <button
                                          onClick={() => isEditingThis ? setEditingMemberId(null) : startEditRoles(m)}
                                          className="rounded border border-[var(--border)] px-2 py-0.5 text-[10px] hover:bg-[var(--bg-secondary)]">
                                          {isEditingThis ? "取消" : "角色"}
                                        </button>
                                        <button
                                          onClick={() => handleRemoveMember(ws.id, m.id)}
                                          className="rounded border border-[var(--destructive)]/30 px-2 py-0.5 text-[10px] text-[var(--destructive)] hover:bg-[var(--destructive)]/10">
                                          移除
                                        </button>
                                      </div>
                                    </div>

                                    {/* Role editor */}
                                    {isEditingThis && (
                                      <div className="mt-2 pt-2 border-t border-[var(--border)]">
                                        <div className="flex flex-wrap gap-1.5 mb-2">
                                          {wsRoles.map((role) => {
                                            const selected = editRoleIds.includes(role.id);
                                            return (
                                              <button key={role.id} type="button" onClick={() => toggleRole(role.id)}
                                                className={`rounded-full px-2.5 py-0.5 text-xs font-medium border transition-colors ${
                                                  selected
                                                    ? "bg-[var(--primary)] text-[var(--primary-foreground)] border-[var(--primary)]"
                                                    : "border-[var(--border)] hover:bg-[var(--bg-secondary)]"
                                                }`}>
                                                {role.name}
                                              </button>
                                            );
                                          })}
                                        </div>
                                        <button
                                          onClick={() => saveRoles(ws.id, m.id)}
                                          disabled={savingRoles}
                                          className="rounded-md bg-[var(--primary)] px-3 py-1 text-xs font-medium text-[var(--primary-foreground)] hover:opacity-90 disabled:opacity-50">
                                          {savingRoles ? "儲存中..." : "儲存角色"}
                                        </button>
                                      </div>
                                    )}
                                  </div>
                                );
                              })}
                            </div>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
