"use client";

/**
 * ConversationPanel — 直面對話「對話資訊」面板。
 *
 * 2026-05-22 改建為雙 tab 設計:
 *   一級（CRM tab）：標籤 + AI 語意分析 — 直接展開，前置 CRM 工作區功能。
 *   二級（資訊 tab）：身分卡 + 通知靜音 + 個人資訊 + 共同群 + 共享媒體 + 對話統計
 *                      — 鏡像 Telegram 個人檔案，折疊式展示。
 *
 * chatType 自適應:
 *   - PRIVATE:大頭照 + 名稱 + 上線狀態,@username / 電話 / 簡介 / TG ID,共同群
 *             —— 全部來自 /api/.../users/profile(真實 TG 資料,缺的欄位直接不顯示)。
 *   - GROUP / CHANNEL:大頭照 + 名稱 + 類型。
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { X, AtSign, Phone, Bell, BellOff, Info, Hash, ChevronDown, PhoneCall } from "lucide-react";
import { cn } from "@/lib/utils";
import { ChatAvatar } from "@/components/chat/avatar";
import { AIAnalysisCard } from "@/components/chat/ai-analysis-card";
import { formatUserStatus, type Profile } from "@/components/chat/user-profile-modal";
import { ConversationMedia } from "@/components/direct-chat/conversation-media";

type PanelGroup = {
  id: string;
  title: string;
  platformGroupId: string;
  chatType: "GROUP" | "PRIVATE" | "CHANNEL";
  customerName?: string;
  notificationsMutedUntil?: string | null;
  tags?: string[];
  accountMemberships: { account: { id: string; displayName: string } }[];
};

type PanelConversation = {
  id: string;
  title: string;
  kind: "DIRECT" | "GROUP";
  conversationStatus: "OPEN" | "SNOOZED" | "CLOSED";
  conversationAssignedAt: string | null;
  conversationClosedAt: string | null;
  lastInboundAt: string | null;
  lastOutboundAt: string | null;
  conversationOwner: {
    id: string;
    displayName: string;
    username: string;
  } | null;
} | null;

type Props = {
  workspaceId: string;
  groupId: string;
  group: PanelGroup;
  conversation: PanelConversation;
  messageStats?: { sent: number; received: number };
  /** 關閉面板(header 的 X / 窄螢幕遮罩)。 */
  onClose: () => void;
  /** 切換靜音 —— 沿用 direct-chat 既有的 handleToggleMute(樂觀更新 groups state)。 */
  onToggleMute?: () => void;
  /** PRIVATE 對話:開啟 Telegram 原生通話入口。 */
  onStartCall?: (mode: "voice" | "video") => void;
  /** 對話標籤更新後回推父層 groups state,讓列表同步顯示。 */
  onTagsUpdated?: (tags: string[], meta?: { updatedAt?: string }) => void;
  /** 對話 metadata 更新後回推父層 state。 */
  onConversationUpdated?: (conversation: NonNullable<PanelConversation>) => void;
};

type WorkspaceTag = { id: string; name: string; color: string | null };
type Assignee = { id: string; username: string; displayName: string; isSystemAdmin: boolean };
type SlaConfig = { enabled: boolean; responseMinutes: number };
type OverdueConversation = { id: string; dueAt: string | null; lastInboundAt: string | null };

const CHAT_TYPE_LABEL: Record<PanelGroup["chatType"], string> = {
  PRIVATE: "私訊",
  GROUP: "群組",
  CHANNEL: "頻道",
};

function formatWhen(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("zh-TW", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function formatMinutesLabel(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes <= 0) return "—";
  if (minutes % 1440 === 0) return `${minutes / 1440} 天`;
  if (minutes % 60 === 0) return `${minutes / 60} 小時`;
  return `${minutes} 分鐘`;
}

function PanelRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-2">
      <dt className="shrink-0 text-[var(--muted-foreground)]">{label}</dt>
      <dd className="truncate text-right text-[var(--foreground)]">{value}</dd>
    </div>
  );
}

/** TG 個人檔案的資訊列:icon + 主值 + 下方說明(對齊 TG profile 的列樣式)。 */
function InfoRow({
  icon,
  value,
  hint,
  href,
}: {
  icon: ReactNode;
  value: string;
  hint: string;
  href?: string;
}) {
  return (
    <div className="flex items-start gap-2.5 px-2 py-1.5">
      <span className="mt-0.5 shrink-0 text-[var(--muted-foreground)]">
        {icon}
      </span>
      <div className="min-w-0">
        <div className="break-words text-sm text-[var(--foreground)]">
          {href ? (
            <a href={href} className="hover:underline">
              {value}
            </a>
          ) : (
            value
          )}
        </div>
        <div className="text-[11px] text-[var(--muted-foreground)]">{hint}</div>
      </div>
    </div>
  );
}

export function ConversationPanel({
  workspaceId,
  groupId,
  group,
  conversation,
  messageStats,
  onClose,
  onToggleMute,
  onStartCall,
  onTagsUpdated,
  onConversationUpdated,
}: Props) {
  const [activeTab, setActiveTab] = useState<"crm" | "info">("crm");
  const [tags, setTags] = useState<string[]>([]);
  const [vocab, setVocab] = useState<WorkspaceTag[]>([]);
  const [tagInput, setTagInput] = useState("");
  const [tagError, setTagError] = useState("");
  const [profile, setProfile] = useState<Profile | null>(null);
  const [assignees, setAssignees] = useState<Assignee[]>([]);
  const [assignBusy, setAssignBusy] = useState(false);
  const [assignError, setAssignError] = useState("");
  const [slaConfig, setSlaConfig] = useState<SlaConfig>({ enabled: false, responseMinutes: 60 });
  const [overdue, setOverdue] = useState<OverdueConversation | null>(null);
  const [slaBusy, setSlaBusy] = useState(false);
  const [slaError, setSlaError] = useState("");
  const onTagsUpdatedRef = useRef(onTagsUpdated);

  const isPrivate = group.chatType === "PRIVATE";

  useEffect(() => {
    onTagsUpdatedRef.current = onTagsUpdated;
  }, [onTagsUpdated]);

  useEffect(() => {
    if (Array.isArray(group.tags)) setTags(group.tags);
  }, [group.tags]);

  // PRIVATE 對話:抓對方的 TG 個人檔案(username / bio / phone / 上線狀態 / 共同群)。
  // 失敗(bridge 不可達等)→ profile 維持 null,面板只顯示基本身分,不報錯。
  useEffect(() => {
    if (!isPrivate || !group.platformGroupId) return;
    let cancelled = false;
    fetch(
      `/api/workspaces/${workspaceId}/users/profile?platformUserId=${encodeURIComponent(
        group.platformGroupId,
      )}`,
    )
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!cancelled && d) setProfile(d as Profile);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [workspaceId, group.platformGroupId, isPrivate]);

  // 載入此對話目前套用的標籤。換對話時父層用 key={groupId} 讓本元件 remount。
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/workspaces/${workspaceId}/groups/${groupId}/tags`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!cancelled && d) {
          const serverTags = Array.isArray(d.tags) ? d.tags : [];
          setTags(serverTags);
          onTagsUpdatedRef.current?.(serverTags);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [workspaceId, groupId]);

  // 載入工作區標籤詞彙(建議用;與對話無關,workspace 切換才重抓)。
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/workspaces/${workspaceId}/workspace-tags`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!cancelled && d) setVocab(Array.isArray(d.tags) ? d.tags : []);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  // 載入可指派成員。權限不足時維持空陣列,面板只顯示目前負責人。
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/workspaces/${workspaceId}/conversation-assignees`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!cancelled && d) setAssignees(Array.isArray(d.members) ? d.members : []);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  // SLA 狀態:workspace 設定 + 此對話是否已超時。
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/workspaces/${workspaceId}/sla-settings`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (cancelled || !d) return;
        if (d.slaConfig) setSlaConfig(d.slaConfig as SlaConfig);
        const list = Array.isArray(d.overdueConversations) ? d.overdueConversations : [];
        setOverdue((list as OverdueConversation[]).find((item) => item.id === groupId) ?? null);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [workspaceId, groupId]);

  const saveTags = useCallback(
    async (next: string[], prev: string[]) => {
      setTags(next); // 樂觀更新
      onTagsUpdated?.(next);
      setTagError("");
      try {
        const res = await fetch(
          `/api/workspaces/${workspaceId}/groups/${groupId}/tags`,
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ tags: next }),
          },
        );
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          setTagError(data.error || "標籤儲存失敗");
          setTags(prev); // rollback
          onTagsUpdated?.(prev);
        } else if (Array.isArray(data.tags)) {
          const updatedAt =
            typeof data.group?.updatedAt === "string"
              ? data.group.updatedAt
              : undefined;
          setTags(data.tags); // 以 server 正規化後的結果為準
          onTagsUpdated?.(data.tags, { updatedAt });
        }
      } catch {
        setTagError("網路錯誤,標籤儲存失敗");
        setTags(prev);
        onTagsUpdated?.(prev);
      }
    },
    [workspaceId, groupId, onTagsUpdated],
  );

  function addTag(name: string) {
    const t = name.trim();
    setTagInput("");
    if (!t || t.length > 32 || tags.includes(t)) return;
    void saveTags([...tags, t], tags);
  }
  function removeTag(name: string) {
    void saveTags(
      tags.filter((x) => x !== name),
      tags,
    );
  }

  async function assignConversation(ownerUserId: string) {
    if (!ownerUserId) return;
    setAssignBusy(true);
    setAssignError("");
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/conversations/${groupId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ownerAction: "assign", ownerUserId }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setAssignError(data.error || "指派失敗");
        return;
      }
      if (data.conversation) onConversationUpdated?.(data.conversation);
    } catch {
      setAssignError("網路錯誤,指派失敗");
    } finally {
      setAssignBusy(false);
    }
  }

  async function updateSlaConfig(patch: Partial<SlaConfig>) {
    const next = { ...slaConfig, ...patch };
    setSlaBusy(true);
    setSlaError("");
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/sla-settings`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(next),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setSlaError(data.error || "SLA 設定儲存失敗");
        return;
      }
      if (data.slaConfig) setSlaConfig(data.slaConfig as SlaConfig);
    } catch {
      setSlaError("網路錯誤,SLA 設定儲存失敗");
    } finally {
      setSlaBusy(false);
    }
  }

  // 建議:詞彙表裡尚未套用、且符合輸入字串的標籤
  const suggestions = useMemo(() => {
    const applied = new Set(tags);
    const f = tagInput.trim().toLowerCase();
    return vocab
      .filter(
        (v) => !applied.has(v.name) && (!f || v.name.toLowerCase().includes(f)),
      )
      .slice(0, 8);
  }, [vocab, tags, tagInput]);

  const colorOf = (name: string) =>
    vocab.find((v) => v.name === name)?.color ?? null;

  const headlineName = group.customerName?.trim() || group.title;
  const accountName = group.accountMemberships?.[0]?.account.displayName ?? "—";
  const isMuted = !!(
    group.notificationsMutedUntil &&
    new Date(group.notificationsMutedUntil) > new Date()
  );
  const avatarSrc = group.platformGroupId
    ? `/api/workspaces/${workspaceId}/group-avatars/${encodeURIComponent(
        group.platformGroupId,
      )}`
    : null;
  // 上線狀態只在 PRIVATE 且 profile 已載入時顯示;否則退回顯示對話類型。
  const status =
    isPrivate && profile?.status ? formatUserStatus(profile.status) : null;
  const statusLine = status ? status.label : CHAT_TYPE_LABEL[group.chatType];

  return (
    <div className="flex flex-col">
      {/* ── Header ── */}
      <div className="mb-3 flex items-center justify-between">
        <span className="text-sm font-semibold text-[var(--foreground)]">
          對話資訊
        </span>
        <button
          type="button"
          onClick={onClose}
          aria-label="關閉對話資訊"
          className="rounded p-1 text-[var(--muted-foreground)] hover:bg-[var(--bg-secondary)] hover:text-[var(--foreground)]"
        >
          <X className="size-4" />
        </button>
      </div>

      {/* ── Tab bar ── */}
      <div className="mb-3 flex rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] p-0.5">
        <button
          type="button"
          onClick={() => setActiveTab("crm")}
          className={cn(
            "flex-1 rounded-md py-1.5 text-xs font-medium transition-colors",
            activeTab === "crm"
              ? "bg-[var(--card)] text-[var(--foreground)] shadow-sm"
              : "text-[var(--muted-foreground)] hover:text-[var(--foreground)]",
          )}
        >
          CRM
        </button>
        <button
          type="button"
          onClick={() => setActiveTab("info")}
          className={cn(
            "flex-1 rounded-md py-1.5 text-xs font-medium transition-colors",
            activeTab === "info"
              ? "bg-[var(--card)] text-[var(--foreground)] shadow-sm"
              : "text-[var(--muted-foreground)] hover:text-[var(--foreground)]",
          )}
        >
          資訊
        </button>
      </div>

      {/* ══════════════════ CRM tab ══════════════════ */}
      {activeTab === "crm" && (
        <div className="space-y-2">
          {/* 標籤 */}
          <PanelSection title="標籤">
            {tags.length > 0 ? (
              <div className="mb-2 flex flex-wrap gap-1.5">
                {tags.map((t) => {
                  const c = colorOf(t);
                  return (
                    <span
                      key={t}
                      className="inline-flex items-center gap-1 rounded-full border border-[var(--border)] px-2 py-0.5 text-[11px] text-[var(--foreground)]"
                      style={c ? { borderColor: c, color: c } : undefined}
                    >
                      {t}
                      <button
                        type="button"
                        onClick={() => removeTag(t)}
                        className="opacity-60 transition-opacity hover:opacity-100"
                        aria-label={`移除標籤 ${t}`}
                      >
                        <X className="size-3" />
                      </button>
                    </span>
                  );
                })}
              </div>
            ) : (
              <div className="mb-2 text-xs text-[var(--muted-foreground)]">
                尚未加標籤。
              </div>
            )}
            <input
              type="text"
              value={tagInput}
              onChange={(e) => setTagInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addTag(tagInput);
                }
              }}
              placeholder="輸入標籤,Enter 加入…"
              maxLength={32}
              className="w-full rounded-md border border-[var(--input)] bg-[var(--background)] px-2.5 py-1.5 text-xs outline-none focus:ring-2 focus:ring-[var(--ring)]"
            />
            {suggestions.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1">
                {suggestions.map((v) => (
                  <button
                    key={v.id}
                    type="button"
                    onClick={() => addTag(v.name)}
                    className="rounded-full border border-dashed border-[var(--border)] px-2 py-0.5 text-[11px] text-[var(--muted-foreground)] hover:bg-[var(--bg-secondary)] hover:text-[var(--foreground)]"
                    title="點擊加入此標籤"
                  >
                    + {v.name}
                  </button>
                ))}
              </div>
            )}
            {tagError && (
              <p className="mt-1.5 text-[11px] text-[var(--destructive)]">
                {tagError}
              </p>
            )}
          </PanelSection>

          {/* 內部協作 / SLA */}
          <PanelSection title="內部協作 / SLA">
            <div className="space-y-3 text-xs">
              <div>
                <div className="mb-1 text-[var(--muted-foreground)]">目前負責人</div>
                <div className="rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-2.5 py-2 text-[var(--foreground)]">
                  {conversation?.conversationOwner
                    ? `${conversation.conversationOwner.displayName} (@${conversation.conversationOwner.username})`
                    : "尚未指派"}
                </div>
              </div>

              {assignees.length > 0 && (
                <label className="block">
                  <span className="mb-1 block text-[var(--muted-foreground)]">指派給成員</span>
                  <select
                    value={conversation?.conversationOwner?.id ?? ""}
                    disabled={assignBusy}
                    onChange={(e) => void assignConversation(e.target.value)}
                    className="w-full rounded-md border border-[var(--input)] bg-[var(--background)] px-2.5 py-1.5 outline-none focus:ring-2 focus:ring-[var(--ring)] disabled:opacity-60"
                  >
                    <option value="" disabled>選擇成員…</option>
                    {assignees.map((member) => (
                      <option key={member.id} value={member.id}>
                        {member.displayName} (@{member.username})
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {assignError && <p className="text-[11px] text-[var(--destructive)]">{assignError}</p>}

              <div className="rounded-md border border-[var(--border)] p-2">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="font-medium text-[var(--foreground)]">SLA 回覆時限提醒</div>
                    <p className="mt-1 leading-5 text-[var(--muted-foreground)]">
                      SLA 是服務等級承諾。這裡用來設定「客戶最後一次來訊後，客服必須在多久內回覆」；
                      如果期限內沒有我方回覆，系統會把此對話標記為超時，提醒優先處理。
                    </p>
                  </div>
                  <input
                    type="checkbox"
                    checked={slaConfig.enabled}
                    disabled={slaBusy}
                    aria-label="啟用 SLA 回覆時限提醒"
                    onChange={(e) => void updateSlaConfig({ enabled: e.target.checked })}
                  />
                </div>
                <label className="mt-2 block">
                  <span className="mb-1 block text-[var(--muted-foreground)]">回覆時限（分鐘）</span>
                  <input
                    type="number"
                    min={1}
                    max={10080}
                    value={slaConfig.responseMinutes}
                    disabled={slaBusy}
                    onChange={(e) => setSlaConfig((prev) => ({ ...prev, responseMinutes: Number(e.target.value) }))}
                    onBlur={() => void updateSlaConfig({ responseMinutes: slaConfig.responseMinutes })}
                    className="w-full rounded-md border border-[var(--input)] bg-[var(--background)] px-2.5 py-1.5 outline-none focus:ring-2 focus:ring-[var(--ring)] disabled:opacity-60"
                  />
                </label>
                <div className="mt-1 text-[11px] leading-5 text-[var(--muted-foreground)]">
                  目前設定為 {formatMinutesLabel(slaConfig.responseMinutes)}。已結案、目前靜音、或客戶最後來訊後已有我方回覆的對話，不會被標記為超時。
                </div>
                <div className={cn(
                  "mt-2 rounded px-2 py-1 text-[11px]",
                  overdue
                    ? "border border-[var(--destructive)]/30 bg-[var(--destructive)]/5 text-[var(--destructive)]"
                    : "text-[var(--muted-foreground)]",
                )}>
                  {overdue
                    ? `此對話已超過 SLA 回覆時限，原本應於 ${formatWhen(overdue.dueAt)} 前回覆。請優先處理或指派負責人。`
                    : slaConfig.enabled
                      ? "此對話目前未超時；代表仍在回覆時限內，或最近一則客戶來訊後已經有我方回覆。"
                      : "SLA 尚未啟用；系統目前不會依回覆時限標記超時對話。"}
                </div>
                {slaError && <p className="mt-1 text-[11px] text-[var(--destructive)]">{slaError}</p>}
              </div>
            </div>
          </PanelSection>

          {/* AI 語意分析 */}
          <PanelSection title="AI 語意分析">
            <div className="-mx-3 -my-3">
              <AIAnalysisCard workspaceId={workspaceId} groupId={groupId} />
            </div>
          </PanelSection>
        </div>
      )}

      {/* ══════════════════ 資訊 tab ══════════════════ */}
      {activeTab === "info" && (
        <div className="space-y-2">
          {/* 身分卡 */}
          <div className="flex flex-col items-center rounded-lg border border-[var(--border)] bg-[var(--card)] px-3 py-4 text-center">
            <ChatAvatar
              name={headlineName}
              seed={group.id || group.platformGroupId}
              src={avatarSrc}
              size="xl"
            />
            <div className="mt-2 max-w-full truncate text-base font-semibold text-[var(--foreground)]">
              <bdi>{headlineName}</bdi>
            </div>
            <div
              className={cn(
                "text-xs",
                status?.tone === "online"
                  ? "text-[var(--success)]"
                  : "text-[var(--muted-foreground)]",
              )}
            >
              {statusLine}
            </div>
            {isPrivate && onStartCall && (
              <div className="mt-3 flex items-center justify-center gap-2">
                <button
                  type="button"
                  onClick={() => onStartCall("voice")}
                  className="inline-flex size-9 items-center justify-center rounded-full border border-[var(--border)] text-[var(--muted-foreground)] transition-colors hover:bg-[var(--bg-secondary)] hover:text-[var(--foreground)]"
                  title="內嵌 Telegram 通話"
                  aria-label="內嵌 Telegram 通話"
                >
                  <PhoneCall className="size-4" />
                </button>
              </div>
            )}
          </div>

          {/* 通知靜音開關 */}
          {onToggleMute && (
            <button
              type="button"
              onClick={onToggleMute}
              className="flex w-full items-center justify-between rounded-lg border border-[var(--border)] bg-[var(--card)] px-3 py-2.5 text-left transition-colors hover:bg-[var(--bg-secondary)]"
            >
              <span className="flex items-center gap-2 text-sm text-[var(--foreground)]">
                {isMuted ? (
                  <BellOff className="size-4 text-[var(--muted-foreground)]" />
                ) : (
                  <Bell className="size-4 text-[var(--muted-foreground)]" />
                )}
                通知
              </span>
              <span
                className={cn(
                  "text-xs",
                  isMuted
                    ? "text-[var(--muted-foreground)]"
                    : "text-[var(--success)]",
                )}
              >
                {isMuted ? "已靜音" : "開啟"}
              </span>
            </button>
          )}

          {/* 個人資訊（PRIVATE only） */}
          {isPrivate && (
            <PanelSection title="個人資訊" defaultOpen={false}>
              <div className="-mx-3 -my-3">
                {profile?.username && (
                  <InfoRow
                    icon={<AtSign className="size-4" />}
                    value={`@${profile.username}`}
                    hint="使用者名稱"
                  />
                )}
                {profile?.phone && (
                  <InfoRow
                    icon={<Phone className="size-4" />}
                    value={profile.phone}
                    hint="電話"
                    href={`tel:${profile.phone}`}
                  />
                )}
                {profile?.bio && (
                  <InfoRow
                    icon={<Info className="size-4" />}
                    value={profile.bio}
                    hint="簡介"
                  />
                )}
                <InfoRow
                  icon={<Hash className="size-4" />}
                  value={group.platformGroupId}
                  hint="Telegram ID"
                />
              </div>
            </PanelSection>
          )}

          {/* 共同群（PRIVATE only） */}
          {isPrivate && profile && profile.accounts.length > 0 && (
            <PanelSection title="共同群" defaultOpen={false}>
              <div className="space-y-2">
                {profile.accounts.map((a) => (
                  <div key={a.accountId}>
                    <div className="text-[11px] font-medium text-[var(--foreground)]">
                      {a.accountName}
                    </div>
                    <ul className="mt-0.5 space-y-0.5">
                      {a.sharedGroups.length === 0 ? (
                        <li className="text-[11px] text-[var(--muted-foreground)]">—</li>
                      ) : (
                        a.sharedGroups.map((g) => (
                          <li
                            key={g.id}
                            className="truncate text-[11px] text-[var(--muted-foreground)]"
                          >
                            · {g.title}
                          </li>
                        ))
                      )}
                    </ul>
                  </div>
                ))}
              </div>
            </PanelSection>
          )}

          {/* 共享媒體 */}
          <PanelSection title="共享媒體" defaultOpen={false}>
            <div className="-mx-3 -my-3">
              <ConversationMedia workspaceId={workspaceId} groupId={groupId} />
            </div>
          </PanelSection>

          {/* 對話統計 */}
          <PanelSection title="對話統計" defaultOpen={false}>
            <dl className="space-y-1 text-xs">
              <PanelRow label="處理帳號" value={accountName} />
              {messageStats && (
                <PanelRow
                  label="訊息"
                  value={`收 ${messageStats.received} · 發 ${messageStats.sent}`}
                />
              )}
              <PanelRow
                label="最近來訊"
                value={formatWhen(conversation?.lastInboundAt ?? null)}
              />
              <PanelRow
                label="最近回覆"
                value={formatWhen(conversation?.lastOutboundAt ?? null)}
              />
            </dl>
          </PanelSection>
        </div>
      )}
    </div>
  );
}

// ── 可折疊面板區塊 ─────────────────────────────────────────────────────────────
function PanelSection({
  title,
  defaultOpen = true,
  children,
}: {
  title: string;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--card)]">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between px-3 py-2.5 text-left transition-colors hover:bg-[var(--bg-secondary)]"
        aria-expanded={open}
      >
        <span className="text-xs font-semibold uppercase tracking-wide text-[var(--muted-foreground)]">
          {title}
        </span>
        <ChevronDown
          className={cn(
            "size-3.5 shrink-0 text-[var(--muted-foreground)] transition-transform duration-200",
            open && "rotate-180",
          )}
        />
      </button>
      {open && (
        <div className="border-t border-[var(--border)] p-3">{children}</div>
      )}
    </div>
  );
}
