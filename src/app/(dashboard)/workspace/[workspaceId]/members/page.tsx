"use client";

import { useEffect, useState, useCallback } from "react";
import { useParams } from "next/navigation";
import { PageHeader } from "@/components/ui/section";
import { useToast } from "@/hooks/use-toast";

type RoleInfo = {
  id: string;
  name: string;
};

type Member = {
  id: string;
  isActive: boolean;
  user: {
    id: string;
    username: string;
    displayName: string;
    isActive: boolean;
    userRoles: { role: RoleInfo }[];
  };
};

type AvailableRole = {
  id: string;
  name: string;
  description: string | null;
};

export default function MembersPage() {
  const { workspaceId } = useParams<{ workspaceId: string }>();
  const { confirm } = useToast();
  const [members, setMembers] = useState<Member[]>([]);
  const [availableRoles, setAvailableRoles] = useState<AvailableRole[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [addUsername, setAddUsername] = useState("");
  const [addRoleIds, setAddRoleIds] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [editingMemberId, setEditingMemberId] = useState<string | null>(null);
  const [editRoleIds, setEditRoleIds] = useState<string[]>([]);

  const fetchMembers = useCallback(async () => {
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/members`);
      if (res.ok) {
        const data = await res.json();
        setMembers(data.members);
        setError("");
      } else {
        setError("無法載入成員列表");
      }
    } catch {
      setError("網路錯誤，無法載入成員列表");
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  const fetchRoles = useCallback(async () => {
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/roles`);
      if (res.ok) {
        const data = await res.json();
        setAvailableRoles(data.roles);
      }
      // Roles fetch failure isn't fatal — member list still useful without
      // role options for the "add/edit" form. Log nothing to avoid spam.
    } catch {
      // Non-fatal: member list still usable without role editor
    }
  }, [workspaceId]);

  useEffect(() => {
    fetchMembers();
    fetchRoles();
  }, [fetchMembers, fetchRoles]);

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    setError("");

    // First, find user by username via admin API
    const searchRes = await fetch(
      `/api/admin/users?username=${encodeURIComponent(addUsername)}`
    );
    if (!searchRes.ok) {
      setError("無法查詢使用者");
      return;
    }
    const { users } = await searchRes.json();
    if (!users || users.length === 0) {
      setError("找不到此帳號的使用者");
      return;
    }

    const res = await fetch(`/api/workspaces/${workspaceId}/members`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: users[0].id, roleIds: addRoleIds }),
    });

    if (!res.ok) {
      const data = await res.json();
      setError(data.error || "新增失敗");
      return;
    }

    setAddUsername("");
    setAddRoleIds([]);
    setShowAdd(false);
    fetchMembers();
  }

  function toggleAddRole(roleId: string) {
    setAddRoleIds((prev) =>
      prev.includes(roleId)
        ? prev.filter((id) => id !== roleId)
        : [...prev, roleId]
    );
  }

  function startEditRoles(member: Member) {
    setEditingMemberId(member.id);
    setEditRoleIds(member.user.userRoles.map((ur) => ur.role.id));
  }

  function toggleEditRole(roleId: string) {
    setEditRoleIds((prev) =>
      prev.includes(roleId)
        ? prev.filter((id) => id !== roleId)
        : [...prev, roleId]
    );
  }

  async function handleSaveRoles(membershipId: string) {
    setError("");
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/members`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ membershipId, roleIds: editRoleIds }),
      });
      if (!res.ok) {
        const data = await res.json();
        setError(data.error || "更新角色失敗");
        return;
      }
    } catch {
      setError("網路錯誤");
      return;
    }
    setEditingMemberId(null);
    fetchMembers();
  }

  async function handleToggleActive(
    membershipId: string,
    isActive: boolean,
    memberName: string,
  ) {
    // Confirm destructive action. Reactivation is harmless, so only guard
    // the deactivate path.
    if (isActive) {
      const ok = await confirm({
        message: `確定要停用成員「${memberName}」？停用後該成員將無法登入此工作區。`,
        danger: true,
      });
      if (!ok) return;
    }
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/members`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ membershipId, isActive: !isActive }),
      });
      if (!res.ok) {
        const data = await res.json();
        setError(data.error || "更新狀態失敗");
        return;
      }
    } catch {
      setError("網路錯誤");
      return;
    }
    fetchMembers();
  }

  if (loading) {
    return <div className="text-sm text-[var(--muted-foreground)]">載入中...</div>;
  }

  return (
    <div className="mx-auto max-w-7xl space-y-4">
      <PageHeader
        title="成員管理"
        description="管理工作空間成員與角色指派"
        actions={
          <button
            onClick={() => { setShowAdd(!showAdd); setError(""); }}
            className="rounded-md bg-[var(--primary)] px-3 py-1.5 text-sm font-medium text-[var(--primary-foreground)] hover:opacity-90"
          >
            {showAdd ? "取消" : "新增成員"}
          </button>
        }
      />

      {error && (
        <div className="mb-4 rounded-md border border-[var(--destructive)]/30 bg-[var(--destructive)]/10 px-4 py-2 text-sm text-[var(--destructive)]">
          {error}
        </div>
      )}

      {showAdd && (
        <form
          onSubmit={handleAdd}
          className="mb-6 rounded-lg border border-[var(--border)] bg-[var(--card)] p-4"
        >
          <div className="space-y-3">
            <input
              type="text"
              value={addUsername}
              onChange={(e) => setAddUsername(e.target.value)}
              placeholder="使用者帳號"
              required
              className="w-full rounded-md border border-[var(--input)] bg-[var(--background)] px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[var(--ring)]"
            />
            <div>
              <label className="mb-1 block text-xs text-[var(--muted-foreground)]">
                指派角色
              </label>
              <div className="flex flex-wrap gap-2">
                {availableRoles.map((role) => (
                  <label
                    key={role.id}
                    className={`flex cursor-pointer items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs transition-colors ${
                      addRoleIds.includes(role.id)
                        ? "border-[var(--ring)] bg-[var(--primary)]/10 text-[var(--primary)]"
                        : "border-[var(--border)] hover:bg-[var(--bg-secondary)]"
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={addRoleIds.includes(role.id)}
                      onChange={() => toggleAddRole(role.id)}
                      className="sr-only"
                    />
                    {role.name}
                  </label>
                ))}
                {availableRoles.length === 0 && (
                  <span className="text-xs text-[var(--muted-foreground)]">
                    尚無可用角色，請先至角色管理建立
                  </span>
                )}
              </div>
            </div>
            <button
              type="submit"
              className="rounded-md bg-[var(--primary)] px-4 py-2 text-sm font-medium text-[var(--primary-foreground)] hover:opacity-90"
            >
              新增
            </button>
          </div>
        </form>
      )}

      <div className="space-y-2">
        {members.map((m) => (
          <div
            key={m.id}
            className="rounded-lg border border-[var(--border)] bg-[var(--card)] px-4 py-3"
          >
            <div className="flex items-start justify-between">
              <div>
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">
                    {m.user.displayName}
                  </span>
                  {!m.isActive && (
                    <span className="rounded bg-[var(--destructive)]/10 px-1.5 py-0.5 text-xs text-[var(--destructive)]">
                      已停用
                    </span>
                  )}
                </div>
                <div className="mt-0.5 text-xs text-[var(--muted-foreground)]">
                  {m.user.username}
                </div>
                {/* Role badges */}
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {m.user.userRoles.length > 0 ? (
                    m.user.userRoles.map((ur) => (
                      <span
                        key={ur.role.id}
                        className="rounded-full bg-[var(--primary)]/10 px-2 py-0.5 text-xs text-[var(--primary)]"
                      >
                        {ur.role.name}
                      </span>
                    ))
                  ) : (
                    <span className="text-xs text-[var(--muted-foreground)]">
                      未指派角色
                    </span>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() =>
                    editingMemberId === m.id
                      ? setEditingMemberId(null)
                      : startEditRoles(m)
                  }
                  className="rounded border border-[var(--border)] px-2 py-1 text-xs hover:bg-[var(--bg-secondary)]"
                >
                  {editingMemberId === m.id ? "取消" : "編輯角色"}
                </button>
                <button
                  onClick={() => handleToggleActive(m.id, m.isActive, m.user.displayName)}
                  className={`rounded px-2 py-1 text-xs ${
                    m.isActive
                      ? "text-[var(--destructive)] hover:bg-[var(--destructive)]/10"
                      : "text-[var(--approve)] hover:bg-[var(--approve)]/10"
                  }`}
                >
                  {m.isActive ? "停用" : "啟用"}
                </button>
              </div>
            </div>

            {/* Role edit checkboxes */}
            {editingMemberId === m.id && (
              <div className="mt-3 border-t border-[var(--border)] pt-3">
                <label className="mb-2 block text-xs text-[var(--muted-foreground)]">
                  角色指派
                </label>
                <div className="flex flex-wrap gap-2">
                  {availableRoles.map((role) => (
                    <label
                      key={role.id}
                      className={`flex cursor-pointer items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs transition-colors ${
                        editRoleIds.includes(role.id)
                          ? "border-[var(--ring)] bg-[var(--primary)]/10 text-[var(--primary)]"
                          : "border-[var(--border)] hover:bg-[var(--bg-secondary)]"
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={editRoleIds.includes(role.id)}
                        onChange={() => toggleEditRole(role.id)}
                        className="h-3 w-3"
                      />
                      {role.name}
                    </label>
                  ))}
                </div>
                <button
                  onClick={() => handleSaveRoles(m.id)}
                  className="mt-2 rounded-md bg-[var(--primary)] px-3 py-1.5 text-xs font-medium text-[var(--primary-foreground)] hover:opacity-90"
                >
                  儲存角色
                </button>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
