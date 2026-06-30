"use client";

/**
 * ChatListItem — TG-style row for the group/chat sidebar.
 *
 * Layout:
 *   [Avatar]   [Name]                    [time]
 *              [preview (1 line, truncated)]
 *
 * Used by the direct-chat page. Pass the decorated group
 * row (with `lastMessage`) produced by /api/workspaces/:id/groups?includePreview=true.
 */

import { ChatAvatar } from "./avatar";
import { cn } from "@/lib/utils";
import { safeTitle } from "@/lib/utils";
import { Pin, PinOff, BellOff, Bell, CheckSquare, Square } from "lucide-react";

export type ChatListItemMessage = {
  content: string;
  timestamp: string;
  senderName: string | null;
  senderPlatformId: string | null;
  direction: "incoming" | "outgoing";
  messageType: string;
};

export type ChatListItemProps = {
  workspaceId: string;
  groupId: string;
  /** Telegram chat id (negative int for groups, positive for 1:1 DMs, or "-100…" for channels). Used for the group-avatar lookup. */
  platformGroupId?: string | null;
  title: string;
  /** Fallback circle content when the group has no avatar (e.g. "內" for internal). */
  initialsFallback?: string;
  /** Subtitle beneath the name (e.g. customer name). Hidden when `lastMessage` is present. */
  subtitle?: string | null;
  /** When provided, rendered as the 2nd row; subtitle is then suppressed. */
  lastMessage?: ChatListItemMessage | null;
  /** Optional unread count badge. */
  unreadCount?: number;
  isActive?: boolean;
  onClick?: () => void;
  /** P1: ISO timestamp 表示置頂時間;null/undefined = 沒釘。 */
  pinnedAt?: string | null;
  /** P1: 切換置頂的 callback。給就出現 pin/unpin icon 按鈕。 */
  onTogglePin?: () => void;
  /** P2: 靜音通知截止 ISO timestamp;有值且 > now = 靜音中。 */
  mutedUntil?: string | null;
  /** P2: 切換靜音的 callback。給就出現 bell/bell-off icon 按鈕。 */
  onToggleMute?: () => void;
  /** 對話標籤 — 頭像旁最多顯示 3 個小標籤。 */
  tags?: string[];
  /** 批量選取模式:true 時點整列 = 切換選取(不開對話),左側顯示勾選框。 */
  selectionMode?: boolean;
  selected?: boolean;
  onSelectToggle?: () => void;
};

/** 相對時間：1 分鐘內=「剛剛」、當天=「HH:mm」、昨天=「昨天」、一週內=星期、更早=「M/D」。 */
export function formatRelativeTime(iso: string): string {
  const date = new Date(iso);
  if (isNaN(date.getTime())) return "";
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffSec = Math.floor(diffMs / 1000);

  if (diffSec < 60) return "剛剛";

  // 同一天 → HH:mm
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  if (sameDay) {
    return `${date.getHours().toString().padStart(2, "0")}:${date
      .getMinutes()
      .toString()
      .padStart(2, "0")}`;
  }

  // 昨天
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const isYesterday =
    date.getFullYear() === yesterday.getFullYear() &&
    date.getMonth() === yesterday.getMonth() &&
    date.getDate() === yesterday.getDate();
  if (isYesterday) return "昨天";

  // 一週內 → 星期
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  if (diffDays < 7) {
    const weekdays = ["週日", "週一", "週二", "週三", "週四", "週五", "週六"];
    return weekdays[date.getDay()];
  }

  // 更早 → M/D
  return `${date.getMonth() + 1}/${date.getDate()}`;
}

/** 訊息內容預覽：媒體類型用 icon+label 取代文字，長訊息截斷。 */
export function formatMessagePreview(msg: ChatListItemMessage): string {
  const prefix = msg.direction === "outgoing" ? "你: " : "";
  const labels: Record<string, string> = {
    IMAGE: "📷 圖片",
    VIDEO: "🎥 影片",
    AUDIO: "🎵 音訊",
    VOICE: "🎙️ 語音訊息",
    VIDEO_NOTE: "🎥 視訊訊息",
    DOCUMENT: "📎 檔案",
    STICKER: "🎨 貼圖",
    LOCATION: "📍 位置",
    CONTACT: "👤 名片",
    POLL: "📊 投票",
    DICE: "🎲 動畫表情",
    STORY: "📖 轉發故事",
  };
  const bodyLabel = labels[msg.messageType] ?? (msg.content || "").trim();
  const body = bodyLabel.length > 60 ? bodyLabel.slice(0, 60) + "…" : bodyLabel;
  return prefix + body;
}

export function ChatListItem({
  workspaceId,
  groupId,
  platformGroupId,
  title,
  initialsFallback,
  subtitle,
  lastMessage,
  unreadCount = 0,
  isActive = false,
  onClick,
  pinnedAt,
  onTogglePin,
  mutedUntil,
  onToggleMute,
  tags,
  selectionMode = false,
  selected = false,
  onSelectToggle,
}: ChatListItemProps) {
  const isPinned = !!pinnedAt;
  const isMuted = !!(mutedUntil && new Date(mutedUntil) > new Date());
  // Spec 2026-04-24: use the GROUP's own avatar — NOT the last sender's.
  // Sidebar row represents the conversation, not an individual user.
  const avatarSrc = platformGroupId
    ? `/api/workspaces/${workspaceId}/group-avatars/${encodeURIComponent(platformGroupId)}`
    : null;
  // Seed by group id so the initials-fallback color is stable per group.
  const avatarSeed = groupId || platformGroupId || title;

  return (
    <div
      className={cn(
        // P1 釘選列加微弱 accent 底色,跟「目前選中」(也是 accent-bg)堆疊時
        // 仍能區分(selected 用 ring,pinned 用 bg)。
        "group relative w-full transition-colors",
        selectionMode && selected
          ? "bg-[var(--accent-bg)]"
          : isActive
            ? "bg-[var(--accent-bg)]"
            : isPinned
              ? "bg-[var(--accent-bg)]/40 hover:bg-[var(--bg-secondary)]"
              : "hover:bg-[var(--bg-secondary)]",
      )}
    >
      <button
        onClick={selectionMode ? onSelectToggle : onClick}
        className="relative flex w-full items-center gap-2 text-left px-3 py-3 border-b border-[var(--border)] last:border-0"
      >
        {selectionMode && (
          <span className="shrink-0 text-[var(--accent)]" aria-hidden>
            {selected ? <CheckSquare className="size-5" /> : <Square className="size-5 text-[var(--text-muted)]" />}
          </span>
        )}
        <span className="min-w-0 flex-1">
      {/* Active marker — 2px terracotta stripe on the leading edge, same
          vocabulary as the sidebar active state. */}
      {isActive && (
        <span
          aria-hidden
          className="absolute left-0 top-1/2 h-6 w-[2px] -translate-y-1/2 rounded-r bg-[var(--accent)]"
        />
      )}
      <div className="flex items-center gap-3">
        {/* Left: group avatar — real TG photo if cached, colored initials otherwise */}
        <ChatAvatar
          name={initialsFallback ?? title}
          seed={avatarSeed}
          src={avatarSrc}
          size="md"
        />

        {/* Middle: name + preview */}
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            {/* P1 釘選 indicator — 列頭 pin icon,只在 pinned 時出現 */}
            {isPinned && (
              <Pin
                className="size-3 shrink-0 -mt-0.5 text-[var(--accent)] rotate-45"
                aria-hidden
              />
            )}
            {/* P2 靜音 indicator — 名稱旁出現,告訴主管「這 chat 已靜音」 */}
            {isMuted && (
              <BellOff
                className="size-3 shrink-0 -mt-0.5 text-[var(--text-muted)]"
                aria-label="已靜音"
              />
            )}
            <div
              className={cn(
                "truncate text-[14px] font-medium",
                isMuted ? "text-[var(--text-secondary)]" : "text-[var(--text-primary)]",
              )}
              title={title}
            >
              <bdi>{safeTitle(title, 40)}</bdi>
            </div>
            {lastMessage && (
              <div className="ml-auto shrink-0 text-[11px] text-[var(--text-muted)]">
                {formatRelativeTime(lastMessage.timestamp)}
              </div>
            )}
          </div>
          {lastMessage ? (
            <div className="mt-1 flex items-center gap-2">
              <div className="min-w-0 flex-1 truncate text-[12px] leading-snug text-[var(--text-secondary)]">
                {formatMessagePreview(lastMessage)}
              </div>
              {unreadCount > 0 && (
                <span className="shrink-0 rounded-sm bg-[var(--accent)] text-white px-1.5 py-0.5 text-[10px] font-medium leading-none">
                  {unreadCount > 99 ? "99+" : unreadCount}
                </span>
              )}
            </div>
          ) : subtitle ? (
            <div className="mt-1 truncate text-[11px] text-[var(--text-muted)]">
              {subtitle}
            </div>
          ) : null}
          {/* 標籤小徽章 — 最多顯示 3 個,其餘折疊成 +N */}
          {tags && tags.length > 0 && (
            <div className="mt-1 flex flex-wrap gap-1">
              {tags.slice(0, 3).map((t) => (
                <span
                  key={t}
                  className="inline-block max-w-[72px] truncate rounded-full bg-[var(--accent-bg)] px-1.5 py-0.5 text-[9px] font-medium leading-none text-[var(--accent)]"
                  title={t}
                >
                  {t}
                </span>
              ))}
              {tags.length > 3 && (
                <span className="text-[9px] text-[var(--text-muted)]">
                  +{tags.length - 3}
                </span>
              )}
            </div>
          )}
        </div>
      </div>
      </span>
      </button>

      {/* P1 釘選 / P2 靜音 — 桌機靠 hover 顯示(避免每個 row 帶 icon 噪音),
          但觸控裝置沒有 hover,CS 手機主力會「看不到、點不到」釘選鈕 —
          所以手機常駐顯示(opacity-60),md 以上才退回 hover-only。 */}
      {!selectionMode && (onTogglePin || onToggleMute) && (
        <div className="absolute right-3 bottom-3 flex gap-1">
          {onToggleMute && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onToggleMute();
              }}
              className={cn(
                "rounded p-1.5 transition-opacity",
                "text-[var(--text-muted)] hover:bg-[var(--bg-secondary)] hover:text-[var(--accent)]",
                isMuted
                  ? "opacity-70 hover:opacity-100"
                  : "opacity-60 hover:opacity-100 md:opacity-0 md:group-hover:opacity-70 md:hover:opacity-100",
              )}
              title={isMuted ? "取消靜音" : "靜音通知"}
              aria-label={isMuted ? "取消靜音" : "靜音通知"}
            >
              {isMuted ? <Bell className="size-3.5" /> : <BellOff className="size-3.5" />}
            </button>
          )}
          {onTogglePin && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onTogglePin();
              }}
              className={cn(
                "rounded p-1.5 transition-opacity",
                isPinned
                  ? "text-[var(--accent)] hover:bg-[var(--bg-secondary)] opacity-100"
                  : "text-[var(--text-muted)] hover:bg-[var(--bg-secondary)] hover:text-[var(--accent)] opacity-60 hover:opacity-100 md:opacity-0 md:group-hover:opacity-70 md:hover:opacity-100",
              )}
              title={isPinned ? "取消釘選" : "釘選對話"}
              aria-label={isPinned ? "取消釘選" : "釘選對話"}
            >
              {isPinned ? <PinOff className="size-3.5" /> : <Pin className="size-3.5" />}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
