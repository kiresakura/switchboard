"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { useParams, useRouter } from "next/navigation";
import { useHasPermission } from "@/components/layout/workspace-permissions";
import { RefreshCw, Search, User, EyeOff, Eye, X, Tag, Users, MessageCircle, Megaphone, Trash2 } from "lucide-react";
import { safeTitle } from "@/lib/utils";
import { useGroupRenameListener } from "@/hooks/use-group-rename-listener";
import { PageHeader } from "@/components/ui/section";
import { useToast } from "@/hooks/use-toast";

type ChatType = "GROUP" | "PRIVATE" | "CHANNEL";

type Group = {
  id: string;
  title: string;
  platformGroupId: string;
  chatType: ChatType;
  tags: string[];
  customerName: string | null;
  notes: string | null;
  isHidden: boolean;
  platform: string;
  accountMemberships: {
    isListeningAccount: boolean;
    account: { displayName: string; status?: string };
  }[];
  _count: { accountMemberships: number };
};

type TabKey = "all" | "GROUP" | "PRIVATE" | "HIDDEN";

// 「已隱藏」= isHidden=true 或所有 active membership 都 listening=false。
// 規格 2026-05-05:把以前的「已忽略」(只看 listening 狀態)併進「已隱藏」
// 標籤裡 — 兩者語意都是「不要顯示、不要通知」,沒必要當作兩個分類給使用者
// 心智負擔。新版「隱藏」按鈕會 cascade listening=false,所以未來新隱藏的
// 群組兩個條件會同時成立;舊資料(只 listening=false 沒 isHidden)會繼續
// 在這裡被歸到「已隱藏」tab。
function isEffectivelyHidden(g: Group): boolean {
  if (g.isHidden) return true;
  if (!g.accountMemberships || g.accountMemberships.length === 0) return true;
  return g.accountMemberships.every((m) => !m.isListeningAccount);
}

export default function GroupsPage() {
  const { workspaceId } = useParams<{ workspaceId: string }>();
  const router = useRouter();
  const canManage = useHasPermission("canManageGroupRegistry");
  const { toast, confirm } = useToast();
  const [groups, setGroups] = useState<Group[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshMsg, setRefreshMsg] = useState("");
  const [syncPreview, setSyncPreview] = useState<Array<{
    platformGroupId: string; title: string; chatType: string;
    accountId: string; accountName: string; isNew: boolean;
    isReactivatable?: boolean;
    isCurrentlyListening?: boolean;
    wasPreviouslyPaired?: boolean;
    wasPreviouslyHidden?: boolean;
  }> | null>(null);
  const [syncSelected, setSyncSelected] = useState<Set<string>>(new Set());
  const [activeTab, setActiveTab] = useState<TabKey>("GROUP"); // 預設顯示群組（最常用）
  const [search, setSearch] = useState("");
  const [tagFilter, setTagFilter] = useState<string>("");
  const [editingId, setEditingId] = useState<string | null>(null);
  // 獨立於 full-edit (editingId) 之外的「只改備註」inline 狀態。
  // 點群組卡片上的備註文字會走這條路徑,不會跳出含 tags / 客戶名 / 備註
  // 的完整編輯表單,單純就改一個欄位。
  const [editingNotesId, setEditingNotesId] = useState<string | null>(null);
  const [editingNotesDraft, setEditingNotesDraft] = useState("");
  const [editingNotesSaving, setEditingNotesSaving] = useState(false);
  const [editTags, setEditTags] = useState<string[]>([]);
  const [editTagInput, setEditTagInput] = useState("");
  const [editCustomerName, setEditCustomerName] = useState("");
  const [editNotes, setEditNotes] = useState("");
  const refreshMsgTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Cleanup timer on unmount
  useEffect(() => {
    return () => {
      if (refreshMsgTimerRef.current) clearTimeout(refreshMsgTimerRef.current);
    };
  }, []);

  const fetchGroups = useCallback(async () => {
    const res = await fetch(
      `/api/workspaces/${workspaceId}/groups?includeHidden=true`,
    );
    if (res.ok) {
      const data = await res.json();
      setGroups(data.groups);
    }
    setLoading(false);
  }, [workspaceId]);

  // 進入群組管理頁時，呼叫 auto-sync 做完整同步：
  //   1. 從 Telegram 拉最新群組清單（透過 bridge）
  //   2. 自動註冊所有新群組 + 復原可恢復的（不彈 dialog）
  //   3. 合併同名重複群組
  //   4. 修正 CHANNEL→GROUP 誤分類
  //   5. 復原停用配對
  // 失敗（bridge 沒跑等）→ 安靜略過，仍正常載清單；使用者仍可手動點「從 Telegram 同步」當保險。
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await fetch(`/api/workspaces/${workspaceId}/groups/auto-sync`, {
          method: "POST",
        });
      } catch {
        // 失敗不阻塞主流程
      }
      if (!cancelled) await fetchGroups();
    })();
    return () => {
      cancelled = true;
    };
  }, [workspaceId, fetchGroups]);

  // Live-update group titles when Telegram notifies us of a rename.
  // Local-only patch is safer than full refetch — no race with in-flight
  // edits on this page.
  useGroupRenameListener(workspaceId, ({ groupId, newTitle }) => {
    setGroups((prev) =>
      prev.map((g) => (g.id === groupId ? { ...g, title: newTitle } : g)),
    );
  });

  async function handleRefreshPreview() {
    setRefreshing(true);
    setRefreshMsg("");
    setSyncPreview(null);
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/groups/refresh`);
      const data = await res.json();
      if (res.ok && data.groups) {
        type RefreshGroup = {
          platformGroupId: string;
          title: string;
          chatType: string;
          accountId: string;
          accountName: string;
          isNew: boolean;
          isReactivatable?: boolean;
          isCurrentlyListening?: boolean;
          wasPreviouslyPaired?: boolean;
          wasPreviouslyHidden?: boolean;
        };
        const allChats: RefreshGroup[] = data.groups;

        // 規格 2026-05-06:同步流程不再處理私訊。私訊改由 TG 端「直接打過來」
        // 自動入庫(bridge auto-register),要不要監聽 / 隱藏由群組管理頁面
        // 個別操作。同步 dialog 純粹處理 GROUP / CHANNEL,讓使用者集中精力
        // 在客戶群上。
        const groupOrChannel = allChats.filter((g) => g.chatType !== "PRIVATE");
        const actionableChats = groupOrChannel.filter(
          (g) => g.isNew || g.isReactivatable,
        );
        const newCount = actionableChats.filter((g) => g.isNew).length;
        const reactivatableCount = actionableChats.filter((g) => g.isReactivatable).length;

        // 處理單一帳號失敗（client 未連線等）→ UI 給明確訊息
        const errorMsg =
          Array.isArray(data.errors) && data.errors.length > 0
            ? data.errors
                .map(
                  (e: { accountName: string; error: string }) =>
                    `「${e.accountName}」${e.error}`
                )
                .join("；")
            : "";

        if (actionableChats.length === 0) {
          if (errorMsg) {
            setRefreshMsg(`同步未完成：${errorMsg}`);
          } else {
            setRefreshMsg(
              `掃描完成,沒有發現新對話(共 ${data.totalCount} 個對話已同步)`
            );
          }
        } else {
          // 排序：群組 → 頻道（已不含私訊;讓使用者依重要性瀏覽）
          const sortKey = (t: string) =>
            t === "GROUP" ? 0 : t === "CHANNEL" ? 1 : 2;
          const sorted = [...actionableChats].sort((a, b) => {
            const k = sortKey(a.chatType) - sortKey(b.chatType);
            if (k !== 0) return k;
            return a.title.localeCompare(b.title);
          });
          setSyncPreview(sorted);
          // 規格 2026-05-06 — 預設勾選邏輯改成「系統自動判斷」:
          //   情境 A:**該帳號完全沒同步記錄**(此次掃描出來的 chats 全是
          //          isNew=true,DB 還沒留下任何痕跡)→ 預勾全部,讓
          //          初次設置一鍵搞定。
          //   情境 B:**已經有同步記錄**(至少一個 chat 在 DB 找得到)→
          //          預勾「已配對過」(wasPreviouslyPaired)且「沒被使用者
          //          刻意隱藏」(!wasPreviouslyHidden)的群組。
          //          典型情境是刪掉Telegram 帳號後重新加回,使用者期待「舊配對
          //          自動接回去,先前隱藏的繼續隱藏」。
          //
          // 為什麼不勾「未配對且未隱藏」的歷史群組?那些 group 上次同步
          // 後可能就沒在用了,自動勾起來會把它們又活起來增加客服心智負擔;
          // 要的話讓使用者自己勾。
          const workspaceHasAnyHistory = sorted.some((g) => !g.isNew);
          const presets = sorted
            .filter((g) => {
              if (!workspaceHasAnyHistory) return true;
              if (g.wasPreviouslyHidden) return false;
              return !!g.wasPreviouslyPaired;
            })
            .map((g) => g.platformGroupId);
          setSyncSelected(new Set(presets));
          const newGroupCount = actionableChats.filter(
            (g) => g.isNew && g.chatType === "GROUP"
          ).length;
          const newChannelCount = actionableChats.filter(
            (g) => g.isNew && g.chatType === "CHANNEL"
          ).length;
          const summaryParts: string[] = [];
          if (newCount > 0) {
            const subParts: string[] = [];
            if (newGroupCount > 0) subParts.push(`${newGroupCount} 群組`);
            if (newChannelCount > 0) subParts.push(`${newChannelCount} 頻道`);
            summaryParts.push(`${newCount} 個新對話（${subParts.join(" + ")}）`);
          }
          if (reactivatableCount > 0)
            summaryParts.push(`${reactivatableCount} 個可恢復對話`);
          const summary = summaryParts.join("、");
          setRefreshMsg(
            errorMsg
              ? `發現 ${summary}（部分帳號失敗：${errorMsg}）`
              : `發現 ${summary}，請確認後送出同步`
          );
        }
      } else {
        setRefreshMsg(data.error || "同步失敗");
      }
    } catch {
      setRefreshMsg("無法連接同步服務");
    } finally {
      setRefreshing(false);
    }
  }

  async function handleSyncSelected() {
    if (!syncPreview) return;
    setRefreshing(true);
    // 把整份 preview 都送出 — 沒勾的也加入系統，但 isHidden=true：
    //   - 已被使用者明確選 → isHidden=false（顯示在預設清單）
    //   - 未被勾選 → isHidden=true（不顯示在預設清單，但已加入 DB，
    //     避免下次同步又把同樣的「新群組」翻出來打擾）
    const allItems = syncPreview.map((g) => ({
      platformGroupId: g.platformGroupId,
      title: g.title,
      chatType: g.chatType,
      accountId: g.accountId,
      isHidden: !syncSelected.has(g.platformGroupId),
    }));
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/groups/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ groups: allItems }),
      });
      const data = await res.json();
      if (res.ok) {
        setRefreshMsg(data.message || `已同步 ${data.registered} 個群組`);
        setSyncPreview(null);
        setSyncSelected(new Set());
        await fetchGroups();
        // 新同步進來的群組是「未配對」，警示計數會增加
        router.refresh();
      } else {
        setRefreshMsg(data.error || "同步失敗");
      }
    } catch {
      setRefreshMsg("同步失敗");
    } finally {
      setRefreshing(false);
      refreshMsgTimerRef.current = setTimeout(() => setRefreshMsg(""), 5000);
    }
  }

  async function handleSave(groupId: string) {
    const res = await fetch(`/api/workspaces/${workspaceId}/groups/${groupId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tags: editTags,
        customerName: editCustomerName || null,
        notes: editNotes,
      }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      toast.error(data.error || "儲存失敗");
      return;
    }
    setEditingId(null);
    fetchGroups();
  }

  async function handleSaveNotesInline(groupId: string) {
    setEditingNotesSaving(true);
    try {
      const res = await fetch(
        `/api/workspaces/${workspaceId}/groups/${groupId}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ notes: editingNotesDraft }),
        },
      );
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        toast.error(data.error || "備註儲存失敗");
        return;
      }
      const newNotes = editingNotesDraft.trim() ? editingNotesDraft : null;
      // Optimistic local update — fetchGroups would also work but adds a
      // round-trip; the SSE/polling path will reconcile if anything's stale.
      setGroups((prev) =>
        prev.map((g) => (g.id === groupId ? { ...g, notes: newNotes } : g)),
      );
      setEditingNotesId(null);
      toast.success("備註已儲存");
    } finally {
      setEditingNotesSaving(false);
    }
  }

  function startEditNotesInline(g: Group) {
    setEditingNotesId(g.id);
    setEditingNotesDraft(g.notes || "");
  }

  async function handleDeleteGroup(groupId: string, title: string) {
    if (!await confirm({
      message: `確定要刪除群組「${title}」嗎？\n\n如果此群組有配對引用,會改為停用而非刪除。`,
      danger: true,
    })) return;
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/groups/${groupId}`, {
        method: "DELETE",
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || "刪除失敗");
        return;
      }
      if (data.method === "deactivated") {
        toast.info(data.message);
      }
      fetchGroups();
    } catch {
      toast.error("刪除失敗,請檢查網路連線");
    }
  }

  async function handleToggleHidden(groupId: string, currentlyHidden: boolean) {
    const res = await fetch(`/api/workspaces/${workspaceId}/groups/${groupId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ isHidden: !currentlyHidden }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      toast.error(data.error || "操作失敗");
      return;
    }
    fetchGroups();
    // 隱藏 / 取消隱藏會影響 layout 的「未配對群組」警示計數
    router.refresh();
  }

  function startEdit(group: Group) {
    setEditingId(group.id);
    setEditTags(group.tags || []);
    setEditTagInput("");
    setEditCustomerName(group.customerName || "");
    setEditNotes(group.notes || "");
  }

  function addTag() {
    const tag = editTagInput.trim();
    if (!tag || editTags.includes(tag)) {
      setEditTagInput("");
      return;
    }
    setEditTags([...editTags, tag]);
    setEditTagInput("");
  }

  function removeTag(tag: string) {
    setEditTags(editTags.filter((t) => t !== tag));
  }

  // 收集所有已使用過的標籤（供篩選下拉選單用）
  const allTags = Array.from(
    new Set(groups.flatMap((g) => g.tags || []))
  ).sort();

  // Tab 類別計數。
  const typeCounts = {
    all: groups.length,
    GROUP: groups.filter(
      (g) =>
        (g.chatType === "GROUP" || g.chatType === "CHANNEL") &&
        !isEffectivelyHidden(g),
    ).length,
    PRIVATE: groups.filter((g) => g.chatType === "PRIVATE" && !isEffectivelyHidden(g)).length,
    HIDDEN: groups.filter(isEffectivelyHidden).length,
  };

  // 篩選
  const filtered = groups.filter((g) => {
    // Tab 篩選:
    //   - GROUP / PRIVATE:把「已隱藏」的群組排除,讓它們只出現在 HIDDEN tab,
    //     避免一個隱藏的群組同時冒在多個 tab 讓人困惑。
    //   - HIDDEN:橫切分類,顯示所有 isEffectivelyHidden 的群組。
    if (activeTab === "GROUP") {
      if (g.chatType !== "GROUP" && g.chatType !== "CHANNEL") return false;
      if (isEffectivelyHidden(g)) return false;
    }
    if (activeTab === "PRIVATE") {
      if (g.chatType !== "PRIVATE") return false;
      if (isEffectivelyHidden(g)) return false;
    }
    if (activeTab === "HIDDEN" && !isEffectivelyHidden(g)) return false;
    if (tagFilter && !(g.tags || []).includes(tagFilter)) return false;
    if (search) {
      const q = search.toLowerCase();
      return (
        g.title.toLowerCase().includes(q) ||
        (g.customerName && g.customerName.toLowerCase().includes(q)) ||
        (g.tags || []).some((t) => t.toLowerCase().includes(q)) ||
        g.accountMemberships.some((m) => m.account.displayName.toLowerCase().includes(q))
      );
    }
    return true;
  });

  const activeGroups = filtered.filter((g) => !isEffectivelyHidden(g));
  const hiddenGroups = filtered.filter(isEffectivelyHidden);

  if (loading) {
    return <div className="text-sm text-[var(--muted-foreground)]">載入中...</div>;
  }

  function renderGroupCard(g: Group, isHiddenSection: boolean) {
    return (
      <div
        key={g.id}
        className={`rounded-lg border border-[var(--border)] bg-[var(--card)] px-4 py-3 ${
          isHiddenSection ? "opacity-50" : ""
        }`}
      >
        {editingId === g.id ? (
          <div className="space-y-3">
            <div className="text-sm font-medium truncate" title={g.title}>
              <bdi>{safeTitle(g.title, 80)}</bdi>
            </div>

            {/* Tags editor */}
            <div>
              <label className="mb-1 block text-xs font-medium text-[var(--muted-foreground)]">
                標籤（任意分類，例：A-供應、B-需求、VIP、緊急）
              </label>
              <div className="flex flex-wrap gap-1 mb-2">
                {editTags.map((tag) => (
                  <span
                    key={tag}
                    className="inline-flex items-center gap-1 rounded-full bg-[var(--primary)]/10 px-2 py-0.5 text-xs text-[var(--primary)]"
                  >
                    {tag}
                    <button
                      onClick={() => removeTag(tag)}
                      className="hover:bg-[var(--primary)]/20 rounded-full"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </span>
                ))}
              </div>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={editTagInput}
                  onChange={(e) => setEditTagInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === ",") {
                      e.preventDefault();
                      addTag();
                    }
                  }}
                  placeholder="輸入標籤後 Enter"
                  className="flex-1 rounded-md border border-[var(--input)] bg-[var(--background)] px-3 py-1.5 text-sm outline-none"
                />
                <button
                  onClick={addTag}
                  className="rounded border border-[var(--border)] px-3 py-1 text-xs hover:bg-[var(--bg-secondary)]"
                >
                  加入
                </button>
              </div>
            </div>

            <input
              type="text"
              value={editCustomerName}
              onChange={(e) => setEditCustomerName(e.target.value)}
              placeholder="客戶名稱（選填）"
              className="w-full rounded-md border border-[var(--input)] bg-[var(--background)] px-3 py-2 text-sm outline-none"
            />
            <textarea
              value={editNotes}
              onChange={(e) => setEditNotes(e.target.value)}
              placeholder="備註與注意事項..."
              rows={2}
              className="w-full rounded-md border border-[var(--input)] bg-[var(--background)] px-3 py-2 text-sm outline-none"
            />
            <div className="flex gap-2">
              <button
                onClick={() => handleSave(g.id)}
                className="rounded bg-[var(--primary)] px-3 py-1 text-xs text-[var(--primary-foreground)]"
              >
                儲存
              </button>
              <button
                onClick={() => setEditingId(null)}
                className="rounded border border-[var(--border)] px-3 py-1 text-xs"
              >
                取消
              </button>
            </div>
          </div>
        ) : (
          <div className="flex items-center justify-between">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 flex-wrap">
                {/* Chat type icon */}
                {g.chatType === "PRIVATE" ? (
                  <MessageCircle className="w-4 h-4 text-gray-500" aria-label="私訊" />
                ) : g.chatType === "CHANNEL" ? (
                  <Megaphone className="w-4 h-4 text-purple-500" aria-label="頻道" />
                ) : (
                  <Users className="w-4 h-4 text-blue-500" aria-label="群組" />
                )}
                {canManage ? (
                  <button
                    type="button"
                    onClick={() => startEdit(g)}
                    title={`${g.title}(點擊編輯)`}
                    className="text-sm font-medium truncate max-w-[28rem] text-left text-[var(--foreground)] hover:text-[var(--primary)] hover:underline underline-offset-2 transition-colors cursor-pointer"
                  >
                    <bdi>{safeTitle(g.title, 80)}</bdi>
                  </button>
                ) : (
                  <span className="text-sm font-medium truncate max-w-[28rem]" title={g.title}>
                    <bdi>{safeTitle(g.title, 80)}</bdi>
                  </span>
                )}

                {/* Tags */}
                {g.tags && g.tags.length > 0 && g.tags.map((tag) => (
                  <span
                    key={tag}
                    className="inline-flex items-center gap-1 rounded-full bg-[var(--primary)]/10 px-2 py-0.5 text-xs text-[var(--primary)] border border-[var(--primary)]/20"
                  >
                    <Tag className="w-2.5 h-2.5" />
                    {tag}
                  </span>
                ))}

                {/* (Pairing status badge removed in H4 — no Pairing table any more.) */}
                {g.isHidden && (
                  <span className="rounded bg-gray-500/10 px-1.5 py-0.5 text-xs text-[var(--muted-foreground)]">
                    已隱藏
                  </span>
                )}
              </div>

              {/* Account membership badges */}
              {g.accountMemberships.length > 0 && (
                <div className="mt-1.5 flex items-center gap-1 flex-wrap">
                  <User className="w-3 h-3 text-[var(--muted-foreground)]" />
                  {g.accountMemberships.map((m) => (
                    <span
                      key={m.account.displayName}
                      className="inline-flex items-center gap-1 rounded-full bg-[var(--bg-secondary)] px-2 py-0.5 text-xs text-[var(--text-secondary)]"
                    >
                      {m.account.displayName}
                    </span>
                  ))}
                </div>
              )}

              {g.customerName && (
                <div className="mt-1 text-xs font-medium text-[var(--foreground)]">
                  客戶：{g.customerName}
                </div>
              )}
              {/* 備註欄位 — 三種狀態:
                    1. inline 編輯中 → 顯示 textarea + 儲存/取消(只改備註,
                       不開啟完整編輯表單)
                    2. 有備註 + 可管理 → 點文字直接進 inline 編輯
                    3. 有備註 + 不可管理 → 純文字 */}
              {editingNotesId === g.id ? (
                <div className="mt-1 space-y-1">
                  <textarea
                    value={editingNotesDraft}
                    onChange={(e) => setEditingNotesDraft(e.target.value)}
                    placeholder="寫下這個群組的備註..."
                    rows={3}
                    autoFocus
                    disabled={editingNotesSaving}
                    onKeyDown={(e) => {
                      if (e.key === "Escape") {
                        e.preventDefault();
                        setEditingNotesId(null);
                      }
                      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                        e.preventDefault();
                        handleSaveNotesInline(g.id);
                      }
                    }}
                    className="w-full rounded border border-[var(--input)] bg-[var(--background)] px-2 py-1 text-xs outline-none focus:ring-1 focus:ring-[var(--ring)] disabled:opacity-50"
                  />
                  <div className="flex items-center justify-end gap-1">
                    <span className="mr-auto text-[10px] text-[var(--muted-foreground)]">
                      Esc 取消 · ⌘/Ctrl+Enter 儲存
                    </span>
                    <button
                      type="button"
                      onClick={() => setEditingNotesId(null)}
                      disabled={editingNotesSaving}
                      className="rounded border border-[var(--border)] px-2 py-0.5 text-xs hover:bg-[var(--bg-secondary)] disabled:opacity-50"
                    >
                      取消
                    </button>
                    <button
                      type="button"
                      onClick={() => handleSaveNotesInline(g.id)}
                      disabled={editingNotesSaving}
                      className="rounded bg-[var(--primary)] px-2 py-0.5 text-xs font-medium text-[var(--primary-foreground)] hover:opacity-90 disabled:opacity-50"
                    >
                      {editingNotesSaving ? "儲存中…" : "儲存"}
                    </button>
                  </div>
                </div>
              ) : g.notes ? (
                canManage ? (
                  <button
                    type="button"
                    onClick={() => startEditNotesInline(g)}
                    title="點擊以編輯備註"
                    className="mt-1 block w-full rounded text-left text-xs text-[var(--muted-foreground)] whitespace-pre-wrap break-words cursor-pointer hover:bg-[var(--accent-bg)] hover:text-[var(--foreground)] hover:ring-1 hover:ring-[var(--border-strong)] -mx-1 px-1 py-0.5 transition-colors"
                  >
                    {g.notes}
                  </button>
                ) : (
                  <div className="mt-1 text-xs text-[var(--muted-foreground)] whitespace-pre-wrap break-words">
                    {g.notes}
                  </div>
                )
              ) : null}
            </div>
            {canManage && (
              <div className="ml-3 flex items-center gap-2 flex-wrap">
                {/* 規格 2026-05-05:把以前的「停止監聽」/「重新監聽」獨立按鈕
                    收掉,合併成單一「隱藏」動作。隱藏會 cascade 把 listening
                    關掉、不出通知、跑到「已隱藏」tab;已配對的群組無法隱藏
                    (server PATCH 會擋下)。 */}
                {/* H4 後不再有「配對引用」門檻 — 群組隨時可隱藏 / 恢復。 */}
                {(() => {
                  return (
                    <button
                      onClick={() => handleToggleHidden(g.id, g.isHidden)}
                      className="flex items-center gap-1 rounded border border-[var(--border)] px-2 py-1 text-xs hover:bg-[var(--bg-secondary)]"
                      title={g.isHidden ? "恢復顯示" : "隱藏群組"}
                    >
                      {g.isHidden ? (
                        <>
                          <Eye className="w-3.5 h-3.5" />
                          恢復
                        </>
                      ) : (
                        <>
                          <EyeOff className="w-3.5 h-3.5" />
                          隱藏
                        </>
                      )}
                    </button>
                  );
                })()}
                <button
                  onClick={() => startEdit(g)}
                  className="rounded border border-[var(--border)] px-2 py-1 text-xs hover:bg-[var(--bg-secondary)]"
                >
                  編輯
                </button>
                <button
                  onClick={() => handleDeleteGroup(g.id, g.title)}
                  className="rounded border border-[var(--destructive)]/30 px-2 py-1 text-xs text-[var(--destructive)] hover:bg-[var(--destructive)]/10"
                  title="刪除群組"
                  aria-label="刪除群組"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-7xl space-y-4">
      <PageHeader
        title="帳號管理"
        description="管理 Telegram 帳號同步的所有對話 — 群組、私訊、頻道、標籤分類"
        actions={
          <button
            onClick={handleRefreshPreview}
            disabled={refreshing}
            className="flex items-center gap-2 rounded-md bg-[var(--primary)] px-3 py-1.5 text-sm font-medium text-[var(--primary-foreground)] hover:opacity-90 disabled:opacity-50"
          >
            <RefreshCw className={`w-4 h-4 ${refreshing ? "animate-spin" : ""}`} />
            {refreshing ? "同步中..." : "從 Telegram 同步"}
          </button>
        }
      />

      {refreshMsg && (
        <div className={`mb-4 rounded-md px-3 py-2 text-sm ${
          refreshMsg.includes("完成") || refreshMsg.includes("已同步")
            ? "bg-green-500/10 text-green-600 border border-green-500/20"
            : "bg-yellow-500/10 text-yellow-600 border border-yellow-500/20"
        }`}>
          {refreshMsg}
        </div>
      )}

      {/* Sync preview — read-only system-decided selection.
          規格 2026-05-06:勾選結果完全由系統決定(已配對 + 未隱藏 → 勾;其餘
          不勾;workspace 沒任何歷史 → 全勾)。使用者不能手動覆寫;這是為了
          避免使用者在 dialog 上「漏勾」造成需要二次處理。要納入或排除某個
          群組,改去群組管理頁面對個別群組「隱藏 / 恢復」即可。 */}
      {syncPreview && (
        <div className="mb-4 rounded-lg border border-[var(--border)] bg-[var(--card)] p-4 space-y-3">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <h3 className="text-sm font-medium">同步預覽（自動處理）</h3>
              <p className="mt-0.5 text-xs text-[var(--muted-foreground)]">
                預設規則:已配對過且未被隱藏的對話會啟用;其餘以隱藏狀態加入,
                之後可在帳號管理頁逐一恢復。<strong>本清單為唯讀</strong> —
                要排除某個對話請到帳號管理頁按「隱藏」。
              </p>
            </div>
          </div>
          <div className="max-h-60 overflow-y-auto space-y-1">
            {/* 排序:勾選的(系統判定要啟用)排在最上方,未勾選的(會被加進
                隱藏)往下沉,讓使用者一眼看到「實際會啟用什麼」。 */}
            {[...syncPreview]
              .sort((a, b) => {
                const aSel = syncSelected.has(a.platformGroupId) ? 0 : 1;
                const bSel = syncSelected.has(b.platformGroupId) ? 0 : 1;
                if (aSel !== bSel) return aSel - bSel;
                return 0; // keep stable order from prior sort (chatType + title)
              })
              .map((g) => (
              <div
                key={g.platformGroupId}
                className={`flex items-center gap-3 rounded-md border px-3 py-2 text-sm transition-colors ${
                  syncSelected.has(g.platformGroupId)
                    ? "border-[var(--primary)] bg-[var(--primary)]/5"
                    : "border-[var(--border)] opacity-60"
                }`}
                title={
                  syncSelected.has(g.platformGroupId)
                    ? "系統判定:會啟用(已配對過或為全新工作空間)"
                    : "系統判定:加入但隱藏(之前被隱藏過、或不在歷史配對裡)"
                }
              >
                <input
                  type="checkbox"
                  checked={syncSelected.has(g.platformGroupId)}
                  readOnly
                  disabled
                  aria-label="系統決定的同步狀態(唯讀)"
                  className="rounded cursor-not-allowed"
                />
                <span className="flex-1 min-w-0 text-[var(--foreground)] flex items-center gap-2" title={g.title}>
                  <bdi className="truncate">{safeTitle(g.title, 60)}</bdi>
                  {g.isNew && (
                    <span className="text-xs text-green-500 font-medium shrink-0">新</span>
                  )}
                  {g.isReactivatable && (
                    <span className="text-[10px] rounded-full bg-amber-500/10 text-amber-600 dark:text-amber-300 px-1.5 py-0.5 shrink-0">
                      已停用
                    </span>
                  )}
                  {g.wasPreviouslyPaired && (
                    <span className="text-[10px] rounded-full bg-emerald-500/10 text-emerald-600 dark:text-emerald-300 px-1.5 py-0.5 shrink-0">
                      已配對過
                    </span>
                  )}
                  {g.wasPreviouslyHidden && (
                    <span className="text-[10px] rounded-full bg-gray-500/10 text-gray-600 dark:text-gray-300 px-1.5 py-0.5 shrink-0">
                      之前已隱藏
                    </span>
                  )}
                </span>
                <span className="text-xs text-[var(--muted-foreground)]">
                  {g.chatType === "CHANNEL" ? "頻道" : "群組"}
                  {" · "}
                  {g.accountName}
                </span>
              </div>
            ))}
          </div>
          <div className="flex gap-2">
            <button
              onClick={handleSyncSelected}
              disabled={refreshing || !syncPreview || syncPreview.length === 0}
              className="rounded-md bg-[var(--primary)] px-4 py-2 text-sm font-medium text-[var(--primary-foreground)] hover:opacity-90 disabled:opacity-50"
            >
              {refreshing ? "同步中…" : `確認同步(啟用 ${syncSelected.size} / 共 ${syncPreview?.length ?? 0})`}
            </button>
            <button
              onClick={() => { setSyncPreview(null); setSyncSelected(new Set()); setRefreshMsg(""); }}
              className="rounded-md border border-[var(--border)] px-4 py-2 text-sm"
            >
              取消
            </button>
          </div>
        </div>
      )}

      <div className="mb-4 rounded-md bg-[var(--primary)]/5 border border-[var(--primary)]/20 px-3 py-2 text-xs text-[var(--primary)]">
        群組來自已連線的 Telegram 帳號。可用「標籤」自由分類（同一群組可同時有多個標籤）。預設顯示全部類型，可切換上方 Tab 篩選。
      </div>

      {/* Tabs */}
      {groups.length > 0 && (
        <div className="mb-4 flex border-b border-[var(--border)] flex-wrap">
          {[
            { key: "GROUP" as TabKey, label: "群組", icon: Users, count: typeCounts.GROUP },
            { key: "PRIVATE" as TabKey, label: "私訊", icon: MessageCircle, count: typeCounts.PRIVATE },
            { key: "HIDDEN" as TabKey, label: "已隱藏", icon: EyeOff, count: typeCounts.HIDDEN },
            { key: "all" as TabKey, label: "全部", icon: null, count: typeCounts.all },
          ].map(({ key, label, icon: Icon, count }) => (
            <button
              key={key}
              onClick={() => setActiveTab(key)}
              className={`flex items-center gap-1.5 px-4 py-2 text-sm border-b-2 transition-colors -mb-px ${
                activeTab === key
                  ? "border-[var(--primary)] text-[var(--primary)] font-medium"
                  : "border-transparent text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
              }`}
            >
              {Icon && <Icon className="w-4 h-4" />}
              {label}
              <span className={`rounded-full px-1.5 py-0.5 text-xs ${
                activeTab === key ? "bg-[var(--accent-bg)] text-[var(--accent)]" : "bg-[var(--bg-secondary)] text-[var(--text-secondary)]"
              }`}>
                {count}
              </span>
            </button>
          ))}
        </div>
      )}

      {/* Search & Filter */}
      {groups.length > 0 && (
        <div className="mb-4 flex gap-2 flex-wrap">
          <div className="relative flex-1 min-w-[200px]">
            <Search className="w-4 h-4 absolute left-3 top-2.5 text-[var(--muted-foreground)]" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="搜尋群組名稱、客戶、標籤、帳號..."
              className="w-full rounded-md border border-[var(--input)] bg-[var(--background)] pl-10 pr-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[var(--ring)]"
            />
          </div>
          {allTags.length > 0 && (
            <select
              value={tagFilter}
              onChange={(e) => setTagFilter(e.target.value)}
              className="rounded-md border border-[var(--input)] bg-[var(--background)] px-3 py-2 text-sm outline-none"
            >
              <option value="">全部標籤</option>
              {allTags.map((t) => (
                <option key={t} value={t}>標籤：{t}</option>
              ))}
            </select>
          )}
        </div>
      )}

      {groups.length === 0 ? (
        <p className="text-sm text-[var(--muted-foreground)]">
          尚未發現任何群組。請先新增 Telegram 帳號並完成連線，然後點「從 Telegram 同步」。
        </p>
      ) : filtered.length === 0 ? (
        <p className="text-sm text-[var(--muted-foreground)]">
          無符合條件的群組
        </p>
      ) : (
        <>
          {activeGroups.length > 0 && (
            <div className="space-y-2">
              {activeGroups.map((g) => renderGroupCard(g, false))}
            </div>
          )}

          {hiddenGroups.length > 0 && (
            <div className="mt-6">
              <div className="mb-2 flex items-center gap-2 text-sm text-[var(--muted-foreground)]">
                <EyeOff className="w-4 h-4" />
                <span>已隱藏的群組 ({hiddenGroups.length})</span>
              </div>
              <div className="space-y-2">
                {hiddenGroups.map((g) => renderGroupCard(g, true))}
              </div>
            </div>
          )}

          {activeGroups.length === 0 && hiddenGroups.length > 0 && (
            <p className="mb-4 text-sm text-[var(--muted-foreground)]">
              所有符合條件的群組皆已隱藏。
            </p>
          )}
        </>
      )}
    </div>
  );
}
