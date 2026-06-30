"use client";

import { useEffect, useState, useCallback } from "react";
import { useParams } from "next/navigation";
import { PageHeader } from "@/components/ui/section";
import { useToast } from "@/hooks/use-toast";

// ─── Permission Keys & Category Grouping ─────────────────────

const PERMISSION_CATEGORIES = [
  {
    label: "工作空間管理",
    keys: [
      { key: "canEditWorkspaceSettings", label: "編輯工作空間設定" },
      { key: "canManageCommunicationAccounts", label: "管理 Telegram 帳號" },
      { key: "canManageGroupRegistry", label: "管理群組登記" },
      { key: "canManageRouting", label: "管理對話路由" },
      { key: "canManageModerationRules", label: "管理審核規則" },
    ],
  },
  {
    label: "身份組管理",
    keys: [
      { key: "canManageRoles", label: "管理身份組" },
      { key: "canAssignMemberRoles", label: "指派成員身份組" },
    ],
  },
  {
    label: "訊息操作",
    keys: [
      { key: "canModerateMessages", label: "訊息審核" },
      { key: "canSendManualMessages", label: "手動發送訊息" },
      { key: "canDirectMessage", label: "直接傳訊" },
    ],
  },
  {
    label: "公佈欄與交接",
    keys: [
      { key: "canManagePostPermissions", label: "管理貼文權限（限制查看/編輯對象）" },
    ],
  },
  {
    label: "檢視與稽核",
    keys: [
      { key: "canViewAllAuditLogs", label: "檢視所有稽核日誌" },
      { key: "canViewOwnAuditLogs", label: "檢視自身稽核日誌" },
    ],
  },
];

const ALL_PERMISSION_KEYS = PERMISSION_CATEGORIES.flatMap((c) =>
  c.keys.map((k) => k.key)
);

// ─── Types ───────────────────────────────────────────────────

type Role = {
  id: string;
  name: string;
  description: string | null;
  isSystemDefault: boolean;
  _count: { userRoles: number };
  [key: string]: unknown;
};

type PermissionState = Record<string, boolean>;

function extractPermissions(role: Role): PermissionState {
  const perms: PermissionState = {};
  for (const key of ALL_PERMISSION_KEYS) {
    perms[key] = role[key] === true;
  }
  return perms;
}

function emptyPermissions(): PermissionState {
  const perms: PermissionState = {};
  for (const key of ALL_PERMISSION_KEYS) {
    perms[key] = false;
  }
  return perms;
}

// ─── Permission Checkbox Grid ──────────────────────────────

function PermissionGrid({
  perms,
  onChange,
  disabled,
}: {
  perms: PermissionState;
  onChange: (key: string, value: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <div className="space-y-4">
      {PERMISSION_CATEGORIES.map((category) => (
        <div key={category.label}>
          <div className="mb-1.5 text-xs font-semibold text-[var(--muted-foreground)] uppercase tracking-wide">
            {category.label}
          </div>
          <div className="grid grid-cols-1 gap-1 sm:grid-cols-2 lg:grid-cols-3">
            {category.keys.map(({ key, label }) => (
              <label
                key={key}
                className="flex items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-[var(--bg-secondary)] cursor-pointer"
              >
                <input
                  type="checkbox"
                  checked={perms[key] || false}
                  onChange={(e) => onChange(key, e.target.checked)}
                  disabled={disabled}
                  className="h-3.5 w-3.5 rounded border-[var(--input)] accent-[var(--primary)]"
                />
                <span>{label}</span>
              </label>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── Page Component ──────────────────────────────────────────

export default function RolesPage() {
  const { workspaceId } = useParams<{ workspaceId: string }>();
  const { confirm } = useToast();
  const [roles, setRoles] = useState<Role[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  // 修改權限欄位只限系統管理員(2026-05-05 spec)。其它操作(改名、新增/刪除
  // 身份組、指派成員)仍由 workspace-level canManageRoles 決定 — page 層級
  // 已由 layout 的 permission check 過濾,進得來這頁就有 canManageRoles。
  const [isSystemAdmin, setIsSystemAdmin] = useState(false);

  // Create form state
  const [showCreate, setShowCreate] = useState(false);
  const [createName, setCreateName] = useState("");
  const [createDesc, setCreateDesc] = useState("");
  const [createPerms, setCreatePerms] = useState<PermissionState>(emptyPermissions);
  const [createError, setCreateError] = useState("");

  // Edit state
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editDesc, setEditDesc] = useState("");
  const [editPerms, setEditPerms] = useState<PermissionState>(emptyPermissions);
  const [editError, setEditError] = useState("");

  const fetchRoles = useCallback(async () => {
    const res = await fetch(`/api/workspaces/${workspaceId}/roles`);
    if (res.ok) {
      const data = await res.json();
      setRoles(data.roles);
    } else {
      setError("無法載入身份組");
    }
    setLoading(false);
  }, [workspaceId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchRoles();
    fetch("/api/auth/me", { credentials: "include" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d?.user?.isSystemAdmin) setIsSystemAdmin(true);
      })
      .catch(() => {});
  }, [fetchRoles]);

  // ─── Create ────────────────────────────────────────────────

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setCreateError("");

    const res = await fetch(`/api/workspaces/${workspaceId}/roles`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: createName,
        description: createDesc || undefined,
        permissions: createPerms,
      }),
    });

    if (!res.ok) {
      const data = await res.json();
      setCreateError(data.error || "建立失敗");
      return;
    }

    setCreateName("");
    setCreateDesc("");
    setCreatePerms(emptyPermissions());
    setShowCreate(false);
    fetchRoles();
  }

  // ─── Edit ──────────────────────────────────────────────────

  function startEdit(role: Role) {
    setEditingId(role.id);
    setEditName(role.name);
    setEditDesc(role.description || "");
    setEditPerms(extractPermissions(role));
    setEditError("");
  }

  function cancelEdit() {
    setEditingId(null);
    setEditError("");
  }

  async function handleSaveEdit(e: React.FormEvent) {
    e.preventDefault();
    if (!editingId) return;
    setEditError("");

    const res = await fetch(
      `/api/workspaces/${workspaceId}/roles/${editingId}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: editName,
          description: editDesc || undefined,
          permissions: editPerms,
        }),
      }
    );

    if (!res.ok) {
      const data = await res.json();
      setEditError(data.error || "更新失敗");
      return;
    }

    setEditingId(null);
    fetchRoles();
  }

  // ─── Delete ────────────────────────────────────────────────

  async function handleDelete(roleId: string, roleName: string) {
    if (!await confirm({ message: `確定要刪除身份組「${roleName}」嗎？此操作將移除所有成員的此身份組指派。`, danger: true })) {
      return;
    }

    const res = await fetch(
      `/api/workspaces/${workspaceId}/roles/${roleId}`,
      { method: "DELETE" }
    );

    if (!res.ok) {
      const data = await res.json();
      setError(data.error || "刪除失敗");
      return;
    }

    fetchRoles();
  }

  // ─── Render ────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="text-sm text-[var(--muted-foreground)]">載入中...</div>
    );
  }

  return (
    <div className="mx-auto max-w-7xl space-y-4">
      <PageHeader
        title="身份組管理"
        description="建立與管理「此工作空間」的角色與權限"
        actions={
          <button
            onClick={() => {
              setShowCreate(!showCreate);
              setCreateError("");
            }}
            className="rounded-md bg-[var(--primary)] px-3 py-1.5 text-sm font-medium text-[var(--primary-foreground)] hover:opacity-90"
          >
            {showCreate ? "取消" : "新增身份組"}
          </button>
        }
      />

      {/* 兩種「管理員」差別說明 — 避免使用者把工作空間管理員誤當系統管理員 */}
      <div className="rounded-lg border border-[var(--primary)]/25 bg-[var(--primary)]/5 px-4 py-3 text-xs text-[var(--foreground)]">
        <div className="font-semibold mb-1">關於「管理員」的兩個層級</div>
        <ul className="space-y-0.5 text-[var(--muted-foreground)]">
          <li>
            • <strong className="text-[var(--foreground)]">工作空間管理員</strong>（本頁面下方的身份組）
            — 僅在「此工作空間」內擁有最高權限：管帳號、群組、路由、審核、成員等。換到別的工作空間就沒有這些權限。
          </li>
          <li>
            • <strong className="text-[var(--foreground)]">系統管理員</strong>（System Admin）—
            跨所有工作空間的全域管理員，可建立 / 停用工作空間、管理使用者帳號。由系統層級設定，不在這頁指派。
          </li>
        </ul>
      </div>

      {error && (
        <div className="mb-4 rounded-md border border-[var(--destructive)] bg-[var(--destructive)]/10 px-4 py-2 text-sm text-[var(--destructive)]">
          {error}
          <button
            onClick={() => setError("")}
            className="ml-2 underline hover:no-underline"
          >
            關閉
          </button>
        </div>
      )}

      {/* ── Create Form ──────────────────────────────────────── */}
      {showCreate && (
        <form
          onSubmit={handleCreate}
          className="mb-6 rounded-lg border border-[var(--border)] bg-[var(--card)] p-4 space-y-4"
        >
          <div className="flex flex-col gap-3 sm:flex-row">
            <input
              type="text"
              value={createName}
              onChange={(e) => setCreateName(e.target.value)}
              placeholder="身份組名稱"
              required
              className="flex-1 rounded-md border border-[var(--input)] bg-[var(--background)] px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[var(--ring)]"
            />
            <input
              type="text"
              value={createDesc}
              onChange={(e) => setCreateDesc(e.target.value)}
              placeholder="說明（選填）"
              className="flex-1 rounded-md border border-[var(--input)] bg-[var(--background)] px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[var(--ring)]"
            />
          </div>

          <div className="text-sm font-medium mb-2 flex items-center gap-2">
            權限設定
            {!isSystemAdmin && (
              <span className="text-xs font-normal text-[var(--muted-foreground)] italic">
                (新身份組會以「無權限」建立;系統管理員可隨後賦予權限)
              </span>
            )}
          </div>
          <PermissionGrid
            perms={createPerms}
            onChange={(key, value) =>
              setCreatePerms((prev) => ({ ...prev, [key]: value }))
            }
            disabled={!isSystemAdmin}
          />

          <div className="flex items-center gap-2 pt-2">
            <button
              type="submit"
              className="rounded-md bg-[var(--primary)] px-4 py-2 text-sm font-medium text-[var(--primary-foreground)] hover:opacity-90"
            >
              建立
            </button>
            <button
              type="button"
              onClick={() => setShowCreate(false)}
              className="rounded-md border border-[var(--border)] px-4 py-2 text-sm hover:bg-[var(--bg-secondary)]"
            >
              取消
            </button>
          </div>

          {createError && (
            <p className="text-sm text-[var(--destructive)]">{createError}</p>
          )}
        </form>
      )}

      {/* ── Role List ────────────────────────────────────────── */}
      <div className="space-y-3">
        {roles.length === 0 && (
          <div className="text-sm text-[var(--muted-foreground)]">
            尚未建立任何身份組
          </div>
        )}

        {roles.map((role) => (
          <div
            key={role.id}
            className="rounded-lg border border-[var(--border)] bg-[var(--card)] p-4"
          >
            {editingId === role.id ? (
              /* ── Edit Mode ─────────────────────────────────── */
              <form onSubmit={handleSaveEdit} className="space-y-4">
                <div className="flex flex-col gap-3 sm:flex-row">
                  <input
                    type="text"
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    placeholder="身份組名稱"
                    required
                    className="flex-1 rounded-md border border-[var(--input)] bg-[var(--background)] px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[var(--ring)]"
                  />
                  <input
                    type="text"
                    value={editDesc}
                    onChange={(e) => setEditDesc(e.target.value)}
                    placeholder="說明（選填）"
                    className="flex-1 rounded-md border border-[var(--input)] bg-[var(--background)] px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[var(--ring)]"
                  />
                </div>

                <div className="text-sm font-medium mb-2 flex items-center gap-2">
                  權限設定
                  {!isSystemAdmin && (
                    <span className="text-xs font-normal text-[var(--muted-foreground)] italic">
                      (只有系統管理員可修改權限欄位;其它工作空間管理員可改名稱/說明)
                    </span>
                  )}
                </div>
                <PermissionGrid
                  perms={editPerms}
                  onChange={(key, value) =>
                    setEditPerms((prev) => ({ ...prev, [key]: value }))
                  }
                  disabled={!isSystemAdmin}
                />

                <div className="flex items-center gap-2 pt-2">
                  <button
                    type="submit"
                    className="rounded-md bg-[var(--primary)] px-4 py-2 text-sm font-medium text-[var(--primary-foreground)] hover:opacity-90"
                  >
                    儲存
                  </button>
                  <button
                    type="button"
                    onClick={cancelEdit}
                    className="rounded-md border border-[var(--border)] px-4 py-2 text-sm hover:bg-[var(--bg-secondary)]"
                  >
                    取消
                  </button>
                </div>

                {editError && (
                  <p className="text-sm text-[var(--destructive)]">
                    {editError}
                  </p>
                )}
              </form>
            ) : (
              /* ── Display Mode ──────────────────────────────── */
              <div>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium">{role.name}</span>
                    {role.isSystemDefault && (
                      <span
                        className="rounded border border-[var(--border-strong)] px-1.5 py-0.5 text-xs text-[var(--text-secondary)]"
                        title="此身份組由系統初始化時建立。可以自由編輯名稱/權限/刪除,跟自訂身份組一樣。"
                      >
                        預設建立
                      </span>
                    )}
                    <span className="text-xs text-[var(--muted-foreground)]">
                      {role._count.userRoles} 位成員
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => startEdit(role)}
                      className="rounded px-2 py-1 text-xs text-[var(--accent)] hover:bg-[var(--bg-secondary)] hover:underline"
                    >
                      編輯
                    </button>
                    <button
                      onClick={() => handleDelete(role.id, role.name)}
                      className="rounded px-2 py-1 text-xs text-[var(--destructive)] hover:bg-[var(--destructive)]/10"
                    >
                      刪除
                    </button>
                  </div>
                </div>
                {role.description && (
                  <p className="mt-1 text-xs text-[var(--muted-foreground)]">
                    {role.description}
                  </p>
                )}
                {/* Show active permissions summary */}
                <div className="mt-2 flex flex-wrap gap-1">
                  {ALL_PERMISSION_KEYS.filter((key) => role[key] === true).map(
                    (key) => {
                      const found = PERMISSION_CATEGORIES.flatMap((c) => c.keys).find(
                        (k) => k.key === key
                      );
                      return (
                        <span
                          key={key}
                          className="rounded bg-[var(--bg-secondary)] px-1.5 py-0.5 text-xs text-[var(--text-secondary)]"
                        >
                          {found?.label || key}
                        </span>
                      );
                    }
                  )}
                  {ALL_PERMISSION_KEYS.filter((key) => role[key] === true)
                    .length === 0 && (
                    <span className="text-xs text-[var(--muted-foreground)] italic">
                      無權限
                    </span>
                  )}
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
