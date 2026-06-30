"use client";

/**
 * ChatBubble — Telegram-style message bubble.
 *
 * Renders a chat bubble (rounded, tail, max-width, side-anchored) with
 * Telegram-like affordances:
 *   - optional sender name above content (colored per-sender like TG)
 *   - reply snippet (vertical accent bar + quoted text) when replying
 *   - text / image / file / sticker body
 *   - footer row: edit mark, time, sent/forward status ticks
 *
 * Shared by the broker message-history view and the direct-chat view.
 */

import { useState, useEffect, useRef, useCallback } from "react";
import { createPortal } from "react-dom";
import { Check, CheckCheck, AlertTriangle, Trash2, Reply, Pencil, Smile, Languages, X as XIcon, Forward, CornerDownRight, Pin, PinOff } from "lucide-react";
import { cn, mediaThumbUrl } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import { peerColorIndex, TG_PEER_COLORS } from "./avatar";
import { openLightbox } from "./image-lightbox";
import { MessageText } from "./message-text";
import { MessageLinkPreview } from "./message-link-preview";
import { DownloadButton } from "./download-button";
import { TgsSticker } from "./tgs-sticker";

export type ChatBubbleSide = "left" | "right";

/**
 * Bubble 的傳送狀態(對應 TG client 右下角 tick):
 *   sent       — 1 灰勾(送到伺服器,還沒投遞)
 *   delivered  — 2 灰勾(對方裝置已收到,但尚未閱讀)
 *   read       — 2 藍勾(對方已讀)
 *   pending    — 灰圓圈(本地 optimistic,還沒 ack)
 *   failed     — 警示 icon
 *   rejected   — 被攔截 icon
 *
 * 2026-05-21 修正:把舊的 "forwarded"(誤標「已轉傳」實際語意是 delivered)
 * 改為正確的「delivered = 2 灰勾」+ 新增「read = 2 藍勾」。
 * 從 DCM 來源:platformMessageId=null → sent? pending;readAt 有值 → read;
 * deliveredAt 有值 → delivered;其餘 → sent。
 */
export type ChatBubbleStatus =
  | "sent"       // single check — sent to TG server
  | "delivered"  // double check (grey) — delivered to other device
  | "read"       // double check (blue) — read by recipient
  | "pending"    // clock — awaiting
  | "failed"     // ⚠️ — send failed
  | "rejected"   // 🚫 — blocked by reviewer
  /**
   * @deprecated 改用 "delivered"。保留 union 成員避免外部使用者全部炸開,
   *             render 時 fallthrough 到 delivered 樣式。
   */
  | "forwarded";

export type ReplyContext = {
  senderName: string | null;
  content: string;
  mediaFileName?: string | null;
  /** P3: TG quote reply — 引用片段。有值時優先顯示這個取代 content。 */
  quoteText?: string | null;
};

/** Bytes-less payload — shape mirrors `MediaMetadata` in client-manager.ts. */
export type ChatMediaMetadata = {
  geo?: { lat: number; lng: number; livePeriod?: number };
  contact?: { firstName?: string; lastName?: string; phone?: string; userId?: string };
  poll?: {
    question: string;
    options: Array<{ text: string; voters?: number }>;
    totalVoters?: number;
    closed?: boolean;
  };
  /** P3 動畫表情(🎲🎯🏀⚽🎰)— TG server-side roll 的結果值；outbound optimistic 時可能尚未回填。 */
  dice?: { emoticon: string; value?: number };
  /** P3 故事轉發(MessageMediaStory)— 顯示「📖 故事」placeholder。 */
  story?: { storyId: number; peerId?: string; expired?: boolean };
};

export type MediaInfo = {
  messageType?: "TEXT" | "IMAGE" | "DOCUMENT" | "AUDIO" | "VIDEO" | "STICKER" | "VOICE" | "VIDEO_NOTE" | "LOCATION" | "CONTACT" | "POLL" | "DICE" | "STORY";
  mediaUrl?: string | null;
  mediaType?: string | null;
  mediaSize?: number | null;
  mediaFileName?: string | null;
  /** Bytes-less payload (LOCATION / CONTACT / POLL)。 */
  mediaMetadata?: ChatMediaMetadata | null;
};

export type ChatBubbleProps = {
  side: ChatBubbleSide;
  content: string;
  /** Shown above content in bold. Optional — hide for successive bubbles by same sender. */
  senderName?: string | null;
  /** Deterministic color index (0-7) so the same sender always gets the same color. */
  senderColorIndex?: number;
  /** Reply snippet — rendered above content with TG-style vertical bar. */
  reply?: ReplyContext | null;
  /** Unix-compatible timestamp (ISO string or Date). */
  timestamp: string | Date;
  status?: ChatBubbleStatus;
  /** Pre-edit content, if the message was edited in place (TG "edited" mark). */
  editedAt?: string | null;
  isDeleted?: boolean;
  /** When the message was deleted on the sending side (only set if isDeleted). */
  deletedAt?: string | null;
  /**
   * When provided, the "已編輯" / "已刪除" footer marker becomes a button that
   * invokes this callback. Caller typically opens a history dialog to show
   * previous-version content. Null/undefined = non-interactive (current).
   */
  onShowHistory?: () => void;
  /** Optional tooltip on the status tick — useful for failure reasons. */
  statusTooltip?: string;
  /** Media attachments */
  media?: MediaInfo;
  /** Per-bubble accent color override (rare — e.g. for quoted side). */
  accentClass?: string;
  /** Extra content above the sender name (e.g. "forwarded from X"). */
  header?: React.ReactNode;
  /** Extra content below the bubble (e.g. forward status / reviewer info). */
  footer?: React.ReactNode;
  /**
   * Avatar rendered on the OUTER side of the bubble (left of a left bubble,
   * right of a right bubble). Pass null/undefined to omit — TG hides the
   * avatar on consecutive bubbles from the same sender.
   */
  avatar?: React.ReactNode;
  /**
   * 客服自己發出的訊息可由 UI 觸發「編輯」— 提供 callback 即會在 bubble 上
   * 顯示編輯動作。傳 newContent 給 callback；callback 失敗（throw）會 alert。
   * 適用於 direct-chat 的 OUTBOUND 訊息（CS 帳號池發出的）。
   */
  onEdit?: (newContent: string) => Promise<void>;
  /**
   * 客服自己發出的訊息可由 UI 觸發「刪除」— 提供 callback 即會在 bubble 上
   * 顯示刪除動作。callback 失敗（throw）會 alert。
   */
  onDelete?: () => Promise<void>;
  /**
   * 對訊息加 emoji reaction（透過 bridge 送到 TG）。提供 callback 才會在
   * 右鍵選單裡顯示「Emoji」選項。傳 null = 清除目前 reaction。
   * 對所有訊息（自發 / 收到）都可用 — 所以條件比 onEdit/onDelete 寬。
   */
  onReact?: (emoji: string | null) => Promise<void>;
  /**
   * 已存在的 reactions 摘要（從 TG 同步回來的）。為 null 表示還沒收到 TG
   * 推播 / 沒人 react；空陣列表示曾有 reaction 但都被清掉了。
   * 點 chip = 切換自己的這個 emoji（和 picker 的點選同邏輯）。
   */
  reactions?: ReactionSummary[] | null;
  /**
   * P1: 點 reply 預覽方塊跳到原始訊息。caller 通常用 platformMessageId 在
   * 訊息陣列中找,再呼叫 VirtualChatList.scrollToKey + 設定 highlightedId。
   * 不提供就退化成靜態顯示(舊行為)。
   */
  onReplyClick?: () => void;
  /**
   * 翻譯回 callback。提供時 hover toolbar 出現「翻譯」按鈕,點完把
   * 結果暫存到 bubble 內部 state 顯示在原文下方。
   *
   * 2026-05-21 簽名變更:從 `(text) => Promise<string>` 改為 `() => Promise<string>`。
   * Parent 端在 renderDirectChatItem 用 message id 創建 closure,內部優先打 native
   * TG translation API (per-message, cached on server),非同步訊息退回 Google /api/translate。
   * bubble 不需要再傳 content,messageId 知道得更精準也方便快取。
   */
  onTranslate?: () => Promise<string>;
  /**
   * P1: 轉發此訊息到其他對話。提供時 hover toolbar 出現「轉發」按鈕。
   * Parent 通常打開 chat picker modal,選定後 POST /api/.../messages/forward。
   * 已刪除訊息不會顯示 forward 按鈕(沒 platformMessageId 也不會,由 parent 自決)。
   */
  onForward?: () => void;
  /** 釘選 / 取消釘選此訊息(Switchboard 內部標記,釘到對話視窗頂端)。對所有訊息都可用。 */
  onPin?: () => void;
  /** 此訊息是否已釘選。 */
  isPinned?: boolean;
  /**
   * P2:轉發來源 metadata。提供時 bubble 上方多一行「Forwarded from X」header。
   * shape 對齊 TG MessageFwdHeader 的常見欄位(senderName 用於顯示文字)。
   */
  forwardedFrom?: {
    senderName?: string | null;
    channelTitle?: string | null;
    date?: string | null;
  } | null;
  /**
   * P2 forum topic id — supergroup with forum 開啟才有值。
   * UI 顯示一個小 "🧵 #N" chip 在 senderName 旁,提示「這則在哪個 topic」。
   * 我們暫不解析 topic 名稱(需要額外 GetForumTopics call);MVP 顯示 id 已足夠。
   */
  topicId?: number | null;
  /** P3: Channel post 觀看數;非 channel 為 null。footer 顯示「👁 N」。 */
  viewCount?: number | null;
  /**
   * 2026-05-21 TG parity:Message entities(由 bridge 從 TG `message.entities[]` normalize)。
   * 提供時 MessageText 走 entity-driven renderer,精確標記 Bold/Italic/Spoiler/
   * Blockquote/CustomEmoji/TextUrl/MentionName 等。null/undefined → 退回 regex 抓取。
   */
  entities?:
    | Array<{
        type: string;
        offset: number;
        length: number;
        url?: string;
        userId?: string;
        documentId?: string;
        language?: string;
      }>
    | null;
  /**
   * 2026-05-21 TG parity — Album sibling count。
   * 對 TG album(同 grouped_id 的 N 筆媒體)我們只渲染 lead bubble,
   * 把 N-1 個 sibling 收成一個「📎 +N」chip 顯示在 bubble 角落,
   * 提醒主管/員工此訊息是「一次送 N 個附件」的代表。
   * 0 / undefined / null = 不是 album lead。
   */
  albumSiblingCount?: number | null;
  /**
   * 2026-05-21 TG parity — Album extras。
   * 同 grouped_id 的後續 N-1 筆訊息媒體;有值且 lead 是 IMAGE/VIDEO 時,
   * 取代單一 media 渲染、改為 2×2 / 2×3 / 3×3 thumbnail grid。
   * Non-image album(極少見)仍 fallback +N chip。
   */
  albumExtras?: Array<{
    id: string;
    mediaUrl: string | null;
    mediaType: string | null;
    messageType: string;
  }> | null;
  /**
   * 2026-05-21 訊息按鈕:bot / 服務帳號訊息的 inline keyboard。
   * 渲染在 bubble 下方;callback 按鈕點擊走 onClickButton,url 按鈕直接開連結。
   */
  replyMarkup?: {
    type: string;
    rows: Array<
      Array<{ text: string; kind: string; data?: string; url?: string }>
    >;
  } | null;
  /**
   * callback 按鈕點擊 callback。傳 base64 callback data,回 bot 的 answer。
   * 由 parent 包成 message-bound closure。
   */
  onClickButton?: (
    data: string,
  ) => Promise<{ message?: string | null; alert?: boolean; url?: string | null }>;
  /**
   * P2:抓「誰按了反應」的 callback。提供時 reactions 列右邊出現「查看」icon,
   * 點開 popover 顯示反應者清單。callback 失敗 → toast.error。
   */
  onShowReactors?: () => Promise<
    Array<{
      platformUserId: string;
      displayName: string;
      username: string | null;
      emoji: string;
      date: string | null;
    }>
  >;
  /**
   * 2026-05-21 二線(round 4):「誰已讀我方訊息」popover callback。
   * 只對 OUTBOUND 群組訊息有意義(`messages.GetMessageReadParticipants`,小群 + ≤7 天)。
   * UI 重用 reactors popover 樣式(複用 onShowReactors 視為 emoji=✓✓ 的 reactor list)。
   */
  onShowReaders?: () => Promise<
    Array<{
      platformUserId: string;
      displayName: string;
      username: string | null;
      emoji: string;
      date: string | null;
    }>
  >;
  /**
   * P1 多選模式:true 時 bubble 顯示 checkbox indicator,點 bubble = 切換選取。
   * hover toolbar / context-menu / 編輯 / 刪除等互動會被 disable,避免干擾。
   */
  selectionMode?: boolean;
  /** 多選模式下「此 bubble 是否被選取」。selected ⇒ 顯示打勾 + accent ring */
  selected?: boolean;
  /** 切換選取的 callback;multi-select toolbar 用 selectedIds 收。 */
  onToggleSelect?: () => void;
  /**
   * P1: 跳轉到此 bubble 時的短暫 highlight ring(jump-to-reply 用)。
   * 由 parent 控,~1.5s 後 reset。
   */
  highlighted?: boolean;
  /**
   * P1: in-chat search 命中此 bubble 時加微弱 accent 背景,協助使用者
   * 在 listing 中目視定位。
   */
  searchMatch?: boolean;
  /**
   * P1: bubble root 帶 data-platform-msg-id 屬性,scrollToKey 找不到時的
   * fallback (querySelector + scrollIntoView)。
   */
  platformMessageId?: string | null;
};

export type ReactionSummary = {
  emoji: string;
  count: number;
  chosen: boolean;
};

// The 7 peer colors Telegram ships by default (src/util/theme.ts
// updatePeerColors fallback list). We also use these for avatar backgrounds.
const SENDER_COLORS = TG_PEER_COLORS;

export function pickSenderColorIndex(seed: string | null | undefined): number {
  return peerColorIndex(seed);
}

function formatTime(iso: string | Date): string {
  const d = typeof iso === "string" ? new Date(iso) : iso;
  return d.toLocaleTimeString("zh-TW", { hour: "2-digit", minute: "2-digit", hour12: false });
}

function getFileIcon(mimeType?: string | null): string {
  if (!mimeType) return "📄";
  if (mimeType.startsWith("image/")) return "🖼️";
  if (mimeType.startsWith("audio/")) return "🎵";
  if (mimeType.startsWith("video/")) return "🎬";
  if (mimeType === "application/pdf") return "📕";
  if (mimeType.includes("word")) return "📝";
  if (mimeType.includes("excel") || mimeType.includes("sheet")) return "📊";
  return "📄";
}

// TG tick colors (2026-05-21 Backend-first 校正):
//   sent      → 1 灰勾(送到伺服器)
//   delivered → 2 灰勾(對方裝置收到)— 舊 "forwarded" 用此色避免破壞舊資料
//   read      → 2 藍勾(對方已讀)— TG 經典藍 #5DA9D9
// 注意:舊資料把 "forwarded" 當作「已送出且 archive 雙寫」用,語意對應到
// 現在的 delivered;直接 fallthrough 即可,不需 migration。
function StatusTick({ status, tooltip }: { status?: ChatBubbleStatus; tooltip?: string }) {
  if (!status) return null;
  const common = "size-3 shrink-0";
  if (status === "sent")
    return <Check className={cn(common, "text-current opacity-70")} aria-label={tooltip || "已送出"} />;
  if (status === "delivered" || status === "forwarded")
    return (
      <CheckCheck
        className={cn(common, "text-current opacity-70")}
        aria-label={tooltip || "已送達"}
      />
    );
  if (status === "read")
    return (
      <CheckCheck
        className={cn(common, "text-[#5DA9D9]")}
        aria-label={tooltip || "已讀"}
      />
    );
  if (status === "pending")
    return (
      <span
        className="size-3 shrink-0 animate-pulse rounded-full border border-current opacity-70"
        title={tooltip || "處理中"}
      />
    );
  if (status === "failed")
    return <AlertTriangle className={cn(common, "text-[var(--destructive)]")} aria-label={tooltip || "失敗"} />;
  if (status === "rejected")
    return <Trash2 className={cn(common, "text-[var(--destructive)]")} aria-label="已攔截" />;
  return null;
}

/**
 * MessageButtons — 渲染 TG 訊息的 inline keyboard(bot / 服務帳號訊息常帶)。
 *
 * 2026-05-21:
 *   - url 按鈕:直接開連結(新分頁)
 *   - callback 按鈕:呼叫 onClickButton(base64 data)→ bot 回 answer
 *     answer.url → 開連結;answer.message → toast 顯示
 *   - other 按鈕(buy / game / switch_inline…):顯示但 disabled
 *
 * bot 點完 callback 後常會「編輯訊息」換頁 — 那由 SSE message:edited +
 * replyMarkup 同步處理,這個元件只負責「送出點擊」。
 */
function MessageButtons({
  replyMarkup,
  onClickButton,
}: {
  replyMarkup: NonNullable<ChatBubbleProps["replyMarkup"]>;
  onClickButton?: ChatBubbleProps["onClickButton"];
}) {
  const { toast } = useToast();
  const [busyKey, setBusyKey] = useState<string | null>(null);

  return (
    <div className="mt-1.5 flex flex-col gap-1">
      {replyMarkup.rows.map((row, ri) => (
        <div key={ri} className="flex gap-1">
          {row.map((btn, bi) => {
            const key = `${ri}-${bi}`;
            const isOther = btn.kind === "other";
            const isBusy = busyKey === key;
            return (
              <button
                key={key}
                type="button"
                disabled={isOther || isBusy}
                title={
                  isOther
                    ? "Switchboard 尚不支援此類型按鈕(付款 / 遊戲 / 內聯切換)"
                    : btn.kind === "url"
                      ? btn.url
                      : undefined
                }
                onClick={async (e) => {
                  e.stopPropagation();
                  if (btn.kind === "url" && btn.url) {
                    window.open(btn.url, "_blank", "noopener,noreferrer");
                    return;
                  }
                  if (btn.kind === "callback" && btn.data && onClickButton) {
                    setBusyKey(key);
                    try {
                      const ans = await onClickButton(btn.data);
                      if (ans.url) {
                        window.open(ans.url, "_blank", "noopener,noreferrer");
                      }
                      if (ans.message) {
                        toast.info(ans.message);
                      }
                    } catch (err) {
                      toast.error(
                        err instanceof Error ? err.message : "按鈕操作失敗",
                      );
                    } finally {
                      setBusyKey(null);
                    }
                  }
                }}
                className={cn(
                  "flex-1 rounded-md border px-2 py-1.5 text-xs leading-tight transition-colors",
                  "border-[var(--border)] bg-[var(--bg-primary)] text-[var(--foreground)]",
                  isOther
                    ? "opacity-50 cursor-not-allowed"
                    : "hover:bg-[var(--bg-secondary)] cursor-pointer",
                )}
              >
                {isBusy ? "…" : btn.text}
                {btn.kind === "url" && <span className="ml-0.5 opacity-60">↗</span>}
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}

export function ChatBubble({
  side,
  content,
  senderName,
  senderColorIndex,
  reply,
  timestamp,
  status,
  editedAt,
  isDeleted,
  deletedAt,
  onShowHistory,
  statusTooltip,
  media,
  accentClass,
  header,
  footer,
  avatar,
  onEdit,
  onDelete,
  onReact,
  reactions,
  onReplyClick,
  onTranslate,
  onForward,
  onPin,
  isPinned = false,
  highlighted,
  searchMatch,
  platformMessageId,
  forwardedFrom,
  topicId,
  viewCount,
  entities,
  albumSiblingCount,
  albumExtras,
  replyMarkup,
  onClickButton,
  onShowReactors,
  onShowReaders,
  selectionMode,
  selected,
  onToggleSelect,
}: ChatBubbleProps) {
  const { toast, confirm } = useToast();
  const [imageErrored, setImageErrored] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState("");
  const [actionBusy, setActionBusy] = useState(false);
  // P1 翻譯 state — null = 沒翻過;字串 = 已翻譯內容;"loading" = 進行中
  const [translatedText, setTranslatedText] = useState<string | null>(null);
  const [translating, setTranslating] = useState(false);
  // P2 看誰按了反應 — popover 顯示時抓清單。null = 未開;array = 已開且資料 ready
  const [reactorList, setReactorList] = useState<
    Array<{
      platformUserId: string;
      displayName: string;
      username: string | null;
      emoji: string;
      date: string | null;
    }> | null
  >(null);
  const [reactorsLoading, setReactorsLoading] = useState(false);
  // hover 顯示 toolbar(對齊 bubble 頂端)+ click toolbar 的 emoji 按鈕展開 picker。
  // 兩個都 portal 出去,避免被 react-virtuoso 的 row stacking context 遮擋。
  const [hoverMenuOpen, setHoverMenuOpen] = useState(false);
  const [emojiPickerOpen, setEmojiPickerOpen] = useState(false);
  const bubbleRef = useRef<HTMLDivElement>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const pickerRef = useRef<HTMLDivElement>(null);
  const closeMenuTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // bubble 的 viewport 座標,scroll/resize 時 portal 更新位置
  const [bubbleRect, setBubbleRect] = useState<DOMRect | null>(null);
  const isLeft = side === "left";
  const canModify = !!(onEdit || onDelete) && !isDeleted;
  // 翻譯按鈕的閘:有 callback + bubble 有文字內容才顯示。
  const canTranslate = !!onTranslate && content.trim().length > 0 && !isDeleted;
  // 轉發按鈕的閘:有 callback + 訊息已同步到 TG(platformMessageId 存在) + 未刪除。
  const canForward = !!onForward && !!platformMessageId && !isDeleted;
  // 多選模式下完全關閉 hover toolbar / context menu — 避免操作衝突。
  const canShowMenu =
    !selectionMode &&
    (canModify || !!onReact || canTranslate || canForward || !!onPin) &&
    !isDeleted &&
    !isEditing;

  const refreshBubbleRect = useCallback(() => {
    if (bubbleRef.current) {
      setBubbleRect(bubbleRef.current.getBoundingClientRect());
    }
  }, []);

  // hover bubble or toolbar → 顯示 toolbar;移開兩者都會在 80ms 後消失
  // (給游標一個從 bubble 跨到 toolbar 的時間,不會閃爍)。
  function clearCloseTimer() {
    if (closeMenuTimeoutRef.current) {
      clearTimeout(closeMenuTimeoutRef.current);
      closeMenuTimeoutRef.current = null;
    }
  }
  function scheduleClose() {
    clearCloseTimer();
    closeMenuTimeoutRef.current = setTimeout(() => {
      setHoverMenuOpen(false);
    }, 80);
  }
  function openMenu() {
    clearCloseTimer();
    if (!canShowMenu) return;
    refreshBubbleRect();
    setHoverMenuOpen(true);
  }

  // 隨著 bubble 滾動更新 portal 位置;picker 開啟時也維持。
  useEffect(() => {
    if (!hoverMenuOpen && !emojiPickerOpen) return;
    function update() {
      refreshBubbleRect();
    }
    window.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
    };
  }, [hoverMenuOpen, emojiPickerOpen, refreshBubbleRect]);

  useEffect(() => {
    return () => clearCloseTimer();
  }, []);
  const colorHex =
    senderName != null
      ? SENDER_COLORS[senderColorIndex ?? pickSenderColorIndex(senderName)]
      : null;
  // Reply quote vertical bar — uses the sender's stable color on left
  // (matches the sender-name color so the eye can connect the quoted
  // message back to who wrote it). On right (own bubble, near-black bg)
  // a soft cream stripe reads cleanly without competing with the accent.
  const replyBarColor = isLeft ? (colorHex ?? "var(--accent)") : "rgba(244, 243, 238, 0.5)";

  async function handleEditSave() {
    if (!onEdit) return;
    const trimmed = editValue.trim();
    if (!trimmed || trimmed === content) {
      setIsEditing(false);
      return;
    }
    setActionBusy(true);
    try {
      await onEdit(trimmed);
      setIsEditing(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "編輯失敗");
    } finally {
      setActionBusy(false);
    }
  }

  async function handleDelete() {
    if (!onDelete) return;
    const ok = await confirm({
      title: "刪除訊息",
      message:
        "確定要刪除這則訊息?此動作會同步刪除 Telegram 端的訊息,且無法復原。",
      confirmText: "刪除",
      danger: true,
    });
    if (!ok) return;
    setActionBusy(true);
    try {
      await onDelete();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "刪除失敗");
    } finally {
      setActionBusy(false);
    }
  }

  async function handleReact(emoji: string | null) {
    if (!onReact) return;
    setActionBusy(true);
    setEmojiPickerOpen(false);
    try {
      await onReact(emoji);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Reaction 失敗");
    } finally {
      setActionBusy(false);
    }
  }

  // P2 看誰按了反應 — 點 chip 旁的「查看」icon 開 popover,抓 reactor list。
  async function handleShowReactors() {
    if (!onShowReactors) return;
    if (reactorList != null) {
      // 已開 → 再點關掉
      setReactorList(null);
      return;
    }
    setReactorsLoading(true);
    try {
      const list = await onShowReactors();
      setReactorList(list);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "查不到反應者");
      setReactorList(null);
    } finally {
      setReactorsLoading(false);
    }
  }

  // 翻譯:已翻過再點 = 收起;沒翻過就觸發 message-bound callback(parent 內部
  // 處理 native TG / Google fallback)。失敗時 toast.error,state 拉回 null 供重試。
  async function handleTranslate() {
    if (!onTranslate || !content.trim()) return;
    if (translatedText != null) {
      // toggle off:再點一次就把翻譯收起來
      setTranslatedText(null);
      return;
    }
    setTranslating(true);
    setHoverMenuOpen(false);
    try {
      const result = await onTranslate();
      setTranslatedText(result);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "翻譯失敗");
      setTranslatedText(null);
    } finally {
      setTranslating(false);
    }
  }

  // Esc 關閉 picker;點 picker / toolbar / bubble 之外的地方也關
  // (但因為 portal 跑出去,document click 時用 ref.contains 判斷)
  useEffect(() => {
    if (!emojiPickerOpen) return;
    function handleClick(e: MouseEvent) {
      const t = e.target as Node;
      if (
        pickerRef.current?.contains(t) ||
        toolbarRef.current?.contains(t) ||
        bubbleRef.current?.contains(t)
      ) {
        return;
      }
      setEmojiPickerOpen(false);
    }
    function handleEsc(e: KeyboardEvent) {
      if (e.key === "Escape") setEmojiPickerOpen(false);
    }
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleEsc);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleEsc);
    };
  }, [emojiPickerOpen]);

  return (
    <div
      className={cn(
        "flex w-full items-end gap-2",
        isLeft ? "justify-start" : "justify-end",
        // P1 多選模式:整 row 可點;selected 加 accent ring + bg wash 給強回饋
        selectionMode && "cursor-pointer rounded-md px-1 py-0.5 -mx-1 -my-0.5",
        selectionMode && selected && "bg-[var(--accent-bg)]",
      )}
      onMouseEnter={selectionMode ? undefined : openMenu}
      onMouseLeave={selectionMode ? undefined : scheduleClose}
      onClick={
        selectionMode && onToggleSelect
          ? (e) => {
              e.stopPropagation();
              onToggleSelect();
            }
          : undefined
      }
    >
      {/* P1 多選模式 checkbox indicator — 永遠在 row 最左邊,跟 avatar 不衝突 */}
      {selectionMode && (
        <div
          className={cn(
            "flex size-5 shrink-0 items-center justify-center rounded-full border-2 transition-colors",
            selected
              ? "border-[var(--accent)] bg-[var(--accent)] text-white"
              : "border-[var(--border-strong)] bg-transparent",
          )}
          aria-hidden
        >
          {selected && (
            <Check className="size-3" strokeWidth={3} />
          )}
        </div>
      )}

      {/* Avatar gutter on the OUTER side (TG only shows on incoming side by default,
          but we allow right-side avatars for broker views where we care which
          account spoke). */}
      {isLeft && avatar ? avatar : <div className={cn(avatar ? "size-8 shrink-0 opacity-0" : "hidden")} />}

      <div className={cn("flex max-w-[75%] flex-col gap-0.5", isLeft ? "items-start" : "items-end")}>
        {header}
        <div
          ref={bubbleRef}
          // P1: data attribute 給 jump-to-reply fallback 用(VirtualChatList
          // scrollToKey 找不到時可以 querySelector 走 DOM)。
          data-platform-msg-id={platformMessageId ?? undefined}
          className={cn(
            // Editorial bubble: 16px radius, asymmetric corner toward the
            // sender. Flat — no shadow. Incoming = bg-secondary cream lift
            // with a 1px border; own = inverse near-black with cream text.
            // Single terracotta accent is reserved for sender-name + status
            // chrome — bubble surfaces stay quiet.
            "relative rounded-[16px] px-3 py-1.5 text-[14px] transition-shadow",
            isLeft
              ? "rounded-bl-[6px] bg-[var(--message-bubble)] text-[var(--text-primary)] border border-[var(--border)]"
              : "rounded-br-[6px] bg-[var(--message-bubble-own)] text-[var(--message-bubble-own-text)]",
            // P1: 跳到此 bubble 時的 highlight ring;~1.5s 後 parent 會把 prop 拉掉
            highlighted && "ring-2 ring-[var(--accent)] ring-offset-2 ring-offset-[var(--bg-primary)]",
            // P1: in-chat search 命中此 bubble 的 subtle accent 背景
            searchMatch && "ring-1 ring-[var(--accent)]/40",
            accentClass,
          )}
          // 右鍵打開 emoji picker(最常用的「對訊息按右鍵 → 表情」)。
          // SecurityProvider 會在 document 級 preventDefault 瀏覽器原生選單,
          // 我們的 React handler 仍會在那之前跑、所以兩邊不衝突。
          // 編輯 / 刪除仍在 hover 浮動 toolbar 的小按鈕(context menu 太擠)。
          onContextMenu={(e) => {
            if (!onReact || isDeleted || isEditing) return;
            e.preventDefault();
            e.stopPropagation();
            refreshBubbleRect();
            setEmojiPickerOpen((v) => !v);
          }}
        >
          {(senderName || topicId || (albumSiblingCount && albumSiblingCount > 0)) && (
            <div className="flex items-center gap-1.5 text-[13px] font-semibold leading-tight">
              {senderName && (
                <span style={{ color: isLeft ? (colorHex ?? undefined) : undefined }}>
                  {senderName}
                </span>
              )}
              {/* P2 forum topic chip — 提示主管「這在 topic #N」,非 forum 群組不顯示 */}
              {topicId != null && (
                <span
                  className={cn(
                    "rounded px-1 py-0.5 text-[10px] font-normal",
                    isLeft
                      ? "bg-[var(--bg-primary)] text-[var(--text-muted)]"
                      : "bg-[var(--message-bubble-own-text)]/15 text-[var(--message-bubble-own-text)]/70",
                  )}
                  title={`Forum topic #${topicId}`}
                >
                  🧵 #{topicId}
                </span>
              )}
              {/* 2026-05-21 TG parity:Album sibling chip — 提示「此訊息其實是一次送 N+1 個」 */}
              {albumSiblingCount && albumSiblingCount > 0 ? (
                <span
                  className={cn(
                    "rounded px-1 py-0.5 text-[10px] font-normal",
                    isLeft
                      ? "bg-[var(--bg-primary)] text-[var(--text-muted)]"
                      : "bg-[var(--message-bubble-own-text)]/15 text-[var(--message-bubble-own-text)]/70",
                  )}
                  title={`此訊息與後續 ${albumSiblingCount} 個附件原為單一相簿`}
                >
                  📎 +{albumSiblingCount}
                </span>
              ) : null}
            </div>
          )}

          {/* P2: 轉發 attribution — "Forwarded from X" header,在 reply box / 內容上方。
              TG 慣例字體偏小、灰色 italic。channelTitle 優先(channel post 比 user
              更常見的轉發來源);否則 senderName;再不然顯示「未知來源」。*/}
          {forwardedFrom && (
            <div
              className={cn(
                "mt-1 flex items-center gap-1 text-[11px] italic",
                isLeft ? "text-[var(--text-muted)]" : "text-[var(--message-bubble-own-text)]/65",
              )}
            >
              <CornerDownRight className="size-3 shrink-0" aria-hidden />
              <span className="truncate">
                轉發自{" "}
                <span className="font-medium not-italic">
                  {forwardedFrom.channelTitle ||
                    forwardedFrom.senderName ||
                    "未知來源"}
                </span>
              </span>
            </div>
          )}

          {reply && (
            // P1: onReplyClick 提供時整塊變按鈕 — 點擊回跳到原始訊息(由 parent
            // 處理 scrollToKey + 短暫 highlight)。沒提供就退化成靜態 div(舊行為)。
            (() => {
              const replyContent = (
                <div
                  className={cn(
                    "mt-1 flex items-stretch gap-2 overflow-hidden rounded-md bg-black/5 py-1 pr-2 dark:bg-white/10",
                    onReplyClick && "cursor-pointer hover:bg-black/10 dark:hover:bg-white/15 transition-colors",
                  )}
                  style={{ borderLeft: `3px solid ${replyBarColor}` }}
                >
                  <div className="flex min-w-0 flex-col py-0.5 pl-2">
                    <span
                      className="text-[12px] font-semibold"
                      style={{ color: isLeft ? replyBarColor : undefined }}
                    >
                      {reply.senderName ?? "回覆"}
                    </span>
                    <span className="line-clamp-1 text-[12px] opacity-80">
                      {/* P3 quote reply: 優先顯示引用片段(加引號 + italic),
                          沒選引用就退化成 reply 目標的完整 content。 */}
                      {reply.quoteText ? (
                        <span className="italic">「{reply.quoteText}」</span>
                      ) : (
                        reply.content ||
                        (reply.mediaFileName ? `📎 ${reply.mediaFileName}` : "")
                      )}
                    </span>
                  </div>
                </div>
              );
              return onReplyClick ? (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onReplyClick();
                  }}
                  className="block w-full text-left"
                  title="跳到原始訊息"
                  aria-label="跳到原始訊息"
                >
                  {replyContent}
                </button>
              ) : (
                replyContent
              );
            })()
          )}

          {/* Media — 2026-05-21 TG parity:Album 偵測。
              所有 album member(lead + extras)都 IMAGE 時走 grid;否則 fallback single-image。 */}
          {(() => {
            // album grid 條件:有 extras + 全部是 IMAGE/VIDEO + 主訊息也是 IMAGE/VIDEO
            const albumAllImages =
              albumExtras &&
              albumExtras.length > 0 &&
              (media?.messageType === "IMAGE" || media?.messageType === "VIDEO") &&
              media?.mediaUrl &&
              albumExtras.every((x) => x.mediaUrl && (x.messageType === "IMAGE" || x.messageType === "VIDEO"));
            if (!albumAllImages) return null;
            const all = [
              {
                id: "lead",
                mediaUrl: media!.mediaUrl!,
                mediaType: media!.mediaType ?? null,
                messageType: media!.messageType ?? "IMAGE",
              },
              ...albumExtras!.map((x) => ({
                id: x.id,
                mediaUrl: x.mediaUrl!,
                mediaType: x.mediaType,
                messageType: x.messageType,
              })),
            ];
            // 2 → 2 列;3-4 → 2x2;5-6 → 2x3;7+ → 3x3(超出 9 在第 9 格上疊「+N」)
            const total = all.length;
            const cols = total <= 2 ? 2 : total <= 4 ? 2 : 3;
            const visibleSlots = Math.min(9, total);
            const overflow = total - visibleSlots;
            return (
              <div
                className="-mx-1 mt-1 mb-0.5 grid gap-0.5 overflow-hidden rounded-xl"
                style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
              >
                {all.slice(0, visibleSlots).map((item, idx) => {
                  const isLast = idx === visibleSlots - 1 && overflow > 0;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() =>
                        openLightbox({
                          src: item.mediaUrl,
                          alt: undefined,
                          fileName: null,
                        })
                      }
                      className="relative aspect-square overflow-hidden bg-black/5 cursor-zoom-in"
                    >
                      {item.messageType === "VIDEO" ? (
                        <video
                          src={item.mediaUrl}
                          muted
                          preload="metadata"
                          className="size-full object-cover"
                        />
                      ) : (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={mediaThumbUrl(item.mediaUrl, 400)}
                          alt={`album ${idx + 1}/${total}`}
                          className="size-full object-cover"
                          loading="lazy"
                        />
                      )}
                      {isLast && (
                        <span className="absolute inset-0 flex items-center justify-center bg-black/55 text-lg font-semibold text-white">
                          +{overflow}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            );
          })()}

          {/* 單一 IMAGE — album 已渲染就跳過 */}
          {media?.messageType === "IMAGE" &&
            media.mediaUrl &&
            !imageErrored &&
            !(albumExtras && albumExtras.length > 0 && albumExtras.every((x) => x.messageType === "IMAGE" || x.messageType === "VIDEO")) && (
              <div className="-mx-1 mt-1 mb-0.5 overflow-hidden rounded-xl">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={mediaThumbUrl(media.mediaUrl, 800)}
                  alt={media.mediaFileName || "圖片"}
                  className="max-h-80 w-full cursor-zoom-in object-cover"
                  onClick={() =>
                    openLightbox({
                      src: media.mediaUrl!,
                      alt: media.mediaFileName ?? undefined,
                      fileName: media.mediaFileName,
                    })
                  }
                  onError={() => setImageErrored(true)}
                />
              </div>
            )}
          {media?.messageType === "IMAGE" && imageErrored && (
            <div className="mt-1 rounded-md bg-black/10 dark:bg-white/10 px-2 py-1.5 text-[11px] opacity-80">
              🖼️ 圖片載入失敗{media.mediaFileName ? ` · ${media.mediaFileName}` : ""}
            </div>
          )}
          {/* Audio (music) — inline player with file caption */}
          {media?.messageType === "AUDIO" && media.mediaUrl && (
            <div className="mt-1 flex flex-col gap-1">
              <audio controls preload="metadata" src={media.mediaUrl} className="w-full max-w-[280px]" />
              {media.mediaFileName && (
                <span className="text-[11px] opacity-70 truncate">
                  🎵 {media.mediaFileName}
                </span>
              )}
            </div>
          )}

          {/* Voice note — same player but distinct 🎙️ affordance */}
          {media?.messageType === "VOICE" && media.mediaUrl && (
            <div className="mt-1 flex items-center gap-2">
              <span className="text-lg shrink-0" aria-hidden>🎙️</span>
              <audio controls preload="metadata" src={media.mediaUrl} className="flex-1 max-w-[240px]" />
            </div>
          )}

          {/* Video — inline player. GIF (TG animated) 走同分支,reader 自然 loop */}
          {media?.messageType === "VIDEO" && media.mediaUrl && (
            <div className="-mx-1 mt-1 mb-0.5 overflow-hidden rounded-xl">
              <video controls preload="metadata" src={media.mediaUrl} className="max-h-80 w-full bg-black" />
            </div>
          )}

          {/* Video note (round selfie) — 圓形 mask */}
          {media?.messageType === "VIDEO_NOTE" && media.mediaUrl && (
            <div className="mt-1">
              <video controls preload="metadata" src={media.mediaUrl} className="size-48 rounded-full object-cover bg-black" />
            </div>
          )}

          {/* Document — file download (沒有 inline preview) */}
          {media?.messageType === "DOCUMENT" && media.mediaUrl && (
            <DownloadButton
              url={media.mediaUrl}
              fileName={media.mediaFileName}
              sizeBytes={media.mediaSize}
              icon={<span className="text-xl">{getFileIcon(media.mediaType)}</span>}
              className={cn("mt-1", isLeft ? "" : "bg-white/20 hover:bg-white/25 dark:bg-white/10")}
            />
          )}

          {/* Sticker — 三種格式分支:
              - TGS (application/x-tgsticker / application/gzip) → Lottie 動畫
              - WEBM (video sticker) → <video autoplay loop muted>
              - PNG / WEBP / 其他靜態 → <img>
              TGS 的解析 + 渲染走 dynamic import,只有真正看到 TGS 才會 load
              lottie + pako(總 ~226KB,不該佔在常駐 bundle)。 */}
          {media?.messageType === "STICKER" && media.mediaUrl && (
            (() => {
              const mt = media.mediaType ?? "";
              if (/x-tgsticker|gzip/i.test(mt)) {
                return <TgsSticker url={media.mediaUrl} size={128} />;
              }
              if (/webm/i.test(mt)) {
                return (
                  <video
                    src={media.mediaUrl}
                    autoPlay
                    loop
                    muted
                    playsInline
                    className="mt-1 size-32 object-contain"
                  />
                );
              }
              return (
                /* eslint-disable-next-line @next/next/no-img-element */
                <img src={media.mediaUrl} alt="貼圖" className="mt-1 size-32 object-contain" />
              );
            })()
          )}
          {media?.messageType === "STICKER" && !media.mediaUrl && (
            // 沒下載到 bytes(罕見 — 例如過期 file_reference)→ fallback
            <div className="mt-1 text-[12px] opacity-70">🎭 動畫貼圖載入失敗</div>
          )}

          {/* Location — 點開到 Google Maps,顯示經緯度 */}
          {media?.messageType === "LOCATION" && media.mediaMetadata?.geo && (
            <a
              href={`https://www.google.com/maps?q=${media.mediaMetadata.geo.lat},${media.mediaMetadata.geo.lng}`}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-1 flex items-center gap-2 rounded-md border border-[var(--border)] px-3 py-2 hover:bg-[var(--bg-secondary)]/50 transition-colors"
            >
              <span className="text-xl shrink-0" aria-hidden>📍</span>
              <div className="min-w-0 text-[12px]">
                <div className="font-medium">
                  {media.mediaMetadata.geo.livePeriod ? "即時位置" : "位置"}
                </div>
                <div className="opacity-70 truncate">
                  {media.mediaMetadata.geo.lat.toFixed(5)}, {media.mediaMetadata.geo.lng.toFixed(5)}
                </div>
              </div>
            </a>
          )}

          {/* Contact (vCard) — 名片小卡片;有 phone 就提供 tel: 連結 */}
          {media?.messageType === "CONTACT" && media.mediaMetadata?.contact && (
            <div className="mt-1 flex items-center gap-2 rounded-md border border-[var(--border)] px-3 py-2">
              <span className="text-xl shrink-0" aria-hidden>👤</span>
              <div className="min-w-0 text-[12px]">
                <div className="font-medium truncate">
                  {[
                    media.mediaMetadata.contact.firstName,
                    media.mediaMetadata.contact.lastName,
                  ]
                    .filter(Boolean)
                    .join(" ") || "聯絡人"}
                </div>
                {media.mediaMetadata.contact.phone && (
                  <a
                    href={`tel:${media.mediaMetadata.contact.phone}`}
                    className="opacity-70 hover:underline"
                  >
                    {media.mediaMetadata.contact.phone}
                  </a>
                )}
              </div>
            </div>
          )}

          {/* Poll — 問題 + 選項 + 票數 (唯讀,Switchboard 不支援投票) */}
          {media?.messageType === "POLL" && media.mediaMetadata?.poll && (
            <div className="mt-1 space-y-1.5 rounded-md border border-[var(--border)] px-3 py-2">
              <div className="text-[13px] font-medium">
                📊 {media.mediaMetadata.poll.question}
              </div>
              {media.mediaMetadata.poll.options.map((o, i) => {
                const total = media.mediaMetadata!.poll!.totalVoters ?? 0;
                const pct =
                  total > 0 && o.voters != null
                    ? Math.round((o.voters / total) * 100)
                    : null;
                return (
                  <div
                    key={i}
                    className="flex items-baseline justify-between gap-2 text-[12px]"
                  >
                    <span className="truncate">{o.text}</span>
                    {o.voters != null && (
                      <span className="shrink-0 opacity-70">
                        {o.voters}
                        {pct != null ? ` (${pct}%)` : ""}
                      </span>
                    )}
                  </div>
                );
              })}
              {media.mediaMetadata.poll.totalVoters != null && (
                <div className="text-[10px] opacity-60">
                  {media.mediaMetadata.poll.totalVoters} 人投票
                  {media.mediaMetadata.poll.closed ? " · 已關閉" : ""}
                </div>
              )}
            </div>
          )}

          {/* P3 Dice — 大 emoji 顯示 + 擲出值。TG 客戶端會跑動畫,我們只顯示結果。 */}
          {media?.messageType === "DICE" && media.mediaMetadata?.dice && (
            <div className="mt-1 flex items-center gap-2">
              <span className="text-5xl leading-none" aria-hidden>
                {media.mediaMetadata.dice.emoticon}
              </span>
              <span
                className={cn(
                  "rounded-md px-1.5 py-0.5 text-xs",
                  isLeft
                    ? "bg-[var(--bg-primary)] text-[var(--text-secondary)]"
                    : "bg-[var(--message-bubble-own-text)]/15 text-[var(--message-bubble-own-text)]/85",
                )}
              >
                = {media.mediaMetadata.dice.value}
              </span>
            </div>
          )}

          {/* P3 Story repost — 「📖 轉發故事」placeholder。Switchboard 不自己渲染 story
              內容(只保 reference + 期限狀態);沒過期就外連到 t.me/c/<peer>/s/<id>。*/}
          {media?.messageType === "STORY" && media.mediaMetadata?.story && (
            <div
              className={cn(
                "mt-1 flex items-center gap-2 rounded-md border px-3 py-2 text-[12px]",
                isLeft
                  ? "border-[var(--border)]"
                  : "border-[var(--message-bubble-own-text)]/20",
              )}
            >
              <span className="text-xl shrink-0" aria-hidden>📖</span>
              <div className="min-w-0 flex-1">
                <div className="font-medium">
                  {media.mediaMetadata.story.expired ? "已過期的故事" : "Telegram 故事"}
                </div>
                <div className="opacity-70 truncate">
                  Story #{media.mediaMetadata.story.storyId}
                  {media.mediaMetadata.story.expired
                    ? " · 對方刪除或超過 24 小時"
                    : " · 點擊到 Telegram 觀看"}
                </div>
              </div>
              {!media.mediaMetadata.story.expired && media.mediaMetadata.story.peerId && (
                <a
                  href={`https://t.me/c/${media.mediaMetadata.story.peerId.replace(/^-100/, "")}/s/${media.mediaMetadata.story.storyId}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={cn(
                    "shrink-0 rounded px-2 py-0.5 text-[11px]",
                    isLeft
                      ? "text-[var(--accent)] hover:bg-[var(--accent-bg)]"
                      : "text-[var(--message-bubble-own-text)] hover:bg-[var(--message-bubble-own-text)]/10",
                  )}
                >
                  打開
                </a>
              )}
            </div>
          )}

          {/* Text body — MessageText inlines @mentions + clickable URLs.
              Deleted messages render their original content with strikethrough
              so operators can still see the evidence (Spec 2026-04-23: 刪除前
              原文必須保留)；a separate "已刪除" footer marker disambiguates.
              isEditing 模式：把 body 換成 textarea + 儲存/取消按鈕。 */}
          {isEditing ? (
            <div className={cn("leading-snug", senderName || media ? "mt-1" : "")}>
              <textarea
                value={editValue}
                onChange={(e) => setEditValue(e.target.value)}
                disabled={actionBusy}
                rows={Math.max(2, Math.min(6, editValue.split("\n").length))}
                className="w-full min-w-[200px] resize-y rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-2 py-1 text-[14px] text-[var(--text-primary)] outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]"
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    void handleEditSave();
                  } else if (e.key === "Escape") {
                    setIsEditing(false);
                  }
                }}
                autoFocus
              />
              <div className="mt-1 flex gap-2 justify-end text-[12px]">
                <button
                  type="button"
                  onClick={() => setIsEditing(false)}
                  disabled={actionBusy}
                  className="rounded px-2 py-0.5 text-[var(--text-secondary)] hover:bg-[var(--bg-primary)] disabled:opacity-50"
                >
                  取消
                </button>
                <button
                  type="button"
                  onClick={() => void handleEditSave()}
                  disabled={actionBusy || !editValue.trim()}
                  className="rounded bg-[var(--accent)] px-2 py-0.5 text-white transition-colors hover:bg-[var(--accent-hover)] disabled:opacity-50"
                >
                  {actionBusy ? "儲存中…" : "儲存"}
                </button>
              </div>
              <div className="mt-0.5 text-[11px] opacity-60">
                ⌘/Ctrl + Enter 儲存、Esc 取消
              </div>
            </div>
          ) : (
            content && (
              <div
                className={cn(
                  "leading-snug",
                  isDeleted && "line-through opacity-60 italic",
                  senderName || media ? "mt-1" : "",
                )}
              >
                <MessageText
                  text={content}
                  // 2026-05-21 TG parity:把 server normalize 過的 entities 餵進去,
                  // 沒 entities 就退回 regex tokenize(maintain backward compat)。
                  // type 寬鬆 — runtime walker 只認得自己 union 內的;其他 entity 類型
                  // 不在 ChatBubbleProps 的 type union 裡也會被 walker ignore。
                  entities={
                    entities as
                      | import("@/lib/telegram/client-manager").NormalizedMessageEntity[]
                      | null
                      | undefined
                  }
                  // Inside the inverse (own) bubble, links use cream
                  // underline against the near-black surface — terracotta
                  // would tint the body text per §2 (don't tint body text
                  // with accent). The default left-bubble accent stays
                  // terracotta via MessageText's own accent var.
                  accentClass={isLeft ? undefined : "text-[var(--message-bubble-own-text)] underline"}
                />
              </div>
            )
          )}

          {/* P1: 翻譯結果 — 顯示在原文下方,加 divider + 🌐 標記 + 「收起翻譯」按鈕。
              翻譯內容用 italic + 70% opacity 跟原文視覺區隔,避免使用者誤把翻譯當原文截圖。*/}
          {(translating || translatedText != null) && (
            <div
              className={cn(
                "mt-1.5 border-t pt-1.5 text-[13px] italic opacity-90",
                isLeft ? "border-[var(--border)]/60" : "border-[var(--message-bubble-own-text)]/20",
              )}
            >
              <div className="flex items-start gap-1.5">
                <Languages className="mt-0.5 size-3 shrink-0 opacity-60" aria-hidden />
                <div className="flex-1 leading-snug">
                  {translating ? (
                    <span className="opacity-60">翻譯中…</span>
                  ) : (
                    translatedText
                  )}
                </div>
                {translatedText != null && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setTranslatedText(null);
                    }}
                    className="rounded p-0.5 opacity-50 hover:opacity-100"
                    title="收起翻譯"
                    aria-label="收起翻譯"
                  >
                    <XIcon className="size-3" />
                  </button>
                )}
              </div>
            </div>
          )}

          {/* Link preview — renders a TG-style card below the text for the
              first http(s) URL in the message, if any. No-op when the URL
              has no OG metadata. */}
          {!isDeleted && content && (
            <MessageLinkPreview text={content} side={side} />
          )}

          {/* 2026-05-21 訊息按鈕 — bot / 服務帳號的 inline keyboard。
              渲染在內容下方、reactions 上方。 */}
          {replyMarkup && replyMarkup.rows.length > 0 && !isDeleted && (
            <MessageButtons
              replyMarkup={replyMarkup}
              onClickButton={onClickButton}
            />
          )}

          {/* Reaction chips — TG 同步回來的 reactions 顯示在 bubble 底端、
              footer 上方。點 chip = 切換自己的那個 emoji（chosen 狀態），
              效果跟 emoji picker 點選同 emoji 一樣。 */}
          {reactions && reactions.length > 0 && (
            <div className="mt-1.5 flex flex-wrap items-center gap-1">
              {reactions.map((r) => (
                <button
                  key={r.emoji}
                  type="button"
                  disabled={!onReact || actionBusy}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (!onReact) return;
                    // chosen 狀態下再點 = 清掉自己的；沒點過 = 加上去。
                    void handleReact(r.chosen ? null : r.emoji);
                  }}
                  className={cn(
                    "flex items-center gap-1 rounded-full px-2 py-0.5 text-xs leading-none transition-colors",
                    r.chosen
                      // Chosen — terracotta tint either side; one accent
                      // moment per bubble (the reaction the operator picked).
                      ? isLeft
                        ? "bg-[var(--accent-bg)] text-[var(--accent)]"
                        : "bg-[var(--message-bubble-own-text)]/15 text-[var(--message-bubble-own-text)]"
                      : isLeft
                        ? "bg-[var(--bg-primary)] text-[var(--text-secondary)] hover:bg-[var(--border)]"
                        : "bg-[var(--message-bubble-own-text)]/10 text-[var(--message-bubble-own-text)]/85 hover:bg-[var(--message-bubble-own-text)]/15",
                    !onReact && "cursor-default",
                  )}
                  title={
                    r.chosen
                      ? `已用 ${r.emoji} 反應 — 點再次取消`
                      : onReact
                        ? `用 ${r.emoji} 反應`
                        : `${r.emoji} ${r.count}`
                  }
                >
                  <span>{r.emoji}</span>
                  {r.count > 1 && <span className="font-medium">{r.count}</span>}
                </button>
              ))}
              {/* P2 看誰按了反應 — 點 icon 抓 reactor list 並顯示 inline 面板。
                  按 chip 維持「切換我自己的反應」行為,不衝突。 */}
              {onShowReactors && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    void handleShowReactors();
                  }}
                  disabled={reactorsLoading}
                  className={cn(
                    "ml-0.5 rounded-full px-1.5 py-0.5 text-[10px] leading-none transition-colors",
                    isLeft
                      ? "text-[var(--muted-foreground)] hover:bg-[var(--border)]"
                      : "text-[var(--message-bubble-own-text)]/60 hover:bg-[var(--message-bubble-own-text)]/10",
                  )}
                  title={reactorList != null ? "收起反應者清單" : "查看誰按了反應"}
                >
                  {reactorsLoading ? "…" : reactorList != null ? "✕" : "👁"}
                </button>
              )}
            </div>
          )}

          {/* P2 反應者清單 inline panel — 點「查看」icon 後展開。
              依 emoji group,每 group 列出 displayName(若有 @username 補在後面)。*/}
          {reactorList != null && reactorList.length > 0 && (
            <div
              className={cn(
                "mt-1 rounded-md border px-2 py-1.5 text-[11px]",
                isLeft
                  ? "border-[var(--border)] bg-[var(--bg-primary)]"
                  : "border-[var(--message-bubble-own-text)]/15 bg-[var(--message-bubble-own-text)]/5",
              )}
            >
              {Object.entries(
                reactorList.reduce<Record<string, typeof reactorList>>(
                  (acc, r) => {
                    (acc[r.emoji] ??= []).push(r);
                    return acc;
                  },
                  {},
                ),
              ).map(([emoji, list]) => (
                <div key={emoji} className="flex flex-wrap items-baseline gap-1.5 leading-relaxed">
                  <span className="text-sm shrink-0">{emoji}</span>
                  <span className="text-[var(--text-muted)]">
                    {list.map((u, i) => (
                      <span key={u.platformUserId}>
                        {i > 0 && "、"}
                        <span className="text-[var(--text-secondary)]">{u.displayName}</span>
                        {u.username && (
                          <span className="opacity-60"> @{u.username}</span>
                        )}
                      </span>
                    ))}
                  </span>
                </div>
              ))}
            </div>
          )}
          {reactorList != null && reactorList.length === 0 && (
            <div className="mt-1 text-[10px] italic text-[var(--text-muted)]">
              無法取得反應者清單(可能權限不足或訊息太舊)
            </div>
          )}

          {/* Footer (time + edited/deleted marker + status) at bottom-right.
              When onShowHistory is provided, the 已編輯/已刪除 mark becomes a
              clickable button that opens a version-history popover. */}
          <div
            className={cn(
              "mt-0.5 flex items-center justify-end gap-1 text-[11px] leading-none",
              isLeft
                ? "text-[var(--muted-foreground)]"
                // TG own-bubble meta color: a muted dark-green that works on the
                // pastel bubble background.
                : "text-[#4FAE4E] dark:text-white/70",
            )}
          >
            {isDeleted ? (
              onShowHistory ? (
                <button
                  type="button"
                  onClick={onShowHistory}
                  title={
                    deletedAt
                      ? `刪除於 ${new Date(deletedAt).toLocaleString("zh-TW")}`
                      : "已刪除"
                  }
                  className="underline decoration-dotted hover:opacity-80"
                >
                  已刪除
                </button>
              ) : (
                <span
                  title={
                    deletedAt
                      ? `刪除於 ${new Date(deletedAt).toLocaleString("zh-TW")}`
                      : "已刪除"
                  }
                >
                  已刪除
                </span>
              )
            ) : editedAt ? (
              onShowHistory ? (
                <button
                  type="button"
                  onClick={onShowHistory}
                  title={`編輯於 ${new Date(editedAt).toLocaleString("zh-TW")}`}
                  className="underline decoration-dotted hover:opacity-80"
                >
                  已編輯
                </button>
              ) : (
                <span title={`編輯於 ${new Date(editedAt).toLocaleString("zh-TW")}`}>
                  已編輯
                </span>
              )
            ) : null}
            {/* P3: Channel post 觀看數 — 只有 broadcast channel 才會有值 */}
            {viewCount != null && viewCount > 0 && (
              <span className="opacity-70" title={`${viewCount} 次觀看`}>
                👁 {viewCount >= 1000 ? `${(viewCount / 1000).toFixed(1)}k` : viewCount}
              </span>
            )}
            {/* 釘選的訊息常駐顯示 📌 — 不用 hover 就一眼看出哪幾則被釘(對齊 Telegram)。 */}
            {isPinned && (
              <Pin
                className="size-3 shrink-0 text-[var(--accent)] rotate-45"
                aria-label="已釘選"
              />
            )}
            <span>{formatTime(timestamp)}</span>
            <StatusTick status={status} tooltip={statusTooltip} />
            {/* 2026-05-21 二線:OUTBOUND 群組訊息額外提供「看誰已讀」按鈕。
                重用 reactor popover 機制(emoji=✓✓ 視為一種 "reactor"),
                點開後在 reactor list 區域顯示已讀名單。 */}
            {onShowReaders && !isLeft && (
              <button
                type="button"
                onClick={async (e) => {
                  e.stopPropagation();
                  try {
                    setReactorsLoading(true);
                    const list = await onShowReaders();
                    setReactorList(list);
                  } catch {
                    // 失敗就跳過
                  } finally {
                    setReactorsLoading(false);
                  }
                }}
                className="opacity-60 hover:opacity-100 text-[10px]"
                title="看誰已讀(小群 ≤100 + 訊息 ≤7 天)"
                aria-label="看誰已讀"
              >
                👁
              </button>
            )}
          </div>
        </div>

        {footer}
      </div>

      {/* Right-side avatar gutter symmetry — so left/right bubbles line up. */}
      {!isLeft && avatar ? avatar : <div className={cn(avatar ? "size-8 shrink-0 opacity-0" : "hidden")} />}

      {/* ───────── Portaled hover toolbar(脫離 row stacking,永遠在最上層)───────── */}
      {hoverMenuOpen &&
        canShowMenu &&
        bubbleRect &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            ref={toolbarRef}
            role="group"
            aria-label="訊息動作"
            // Hover toolbar — flat cream surface with 1px border, a single
            // modal-grade shadow (only place allowed per §6) so it floats
            // legibly above the bubble underneath.
            className={cn(
              "fixed z-[1000] flex gap-0.5 rounded-md border border-[var(--border)] bg-[var(--bg-primary)]",
              "shadow-[0_8px_24px_rgba(25,24,23,0.08)]",
              "animate-[fade-in_120ms_ease-out]",
            )}
            style={{
              top: Math.min(window.innerHeight - 48, bubbleRect.bottom + 4),
              left: isLeft
                ? Math.min(window.innerWidth - 160, bubbleRect.left + 8)
                : Math.max(8, bubbleRect.right - 8 - 120),
            }}
            onMouseEnter={openMenu}
            onMouseLeave={scheduleClose}
            onClick={(e) => e.stopPropagation()}
          >
            {onReact && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  refreshBubbleRect();
                  setEmojiPickerOpen((v) => !v);
                }}
                disabled={actionBusy}
                className="px-2 py-1 hover:bg-[var(--bg-secondary)] disabled:opacity-50"
                title="加 emoji reaction"
                aria-label="加 emoji reaction"
              >
                <Smile className="size-3.5 text-[var(--muted-foreground)]" />
              </button>
            )}
            {canTranslate && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  void handleTranslate();
                }}
                disabled={translating}
                className="px-2 py-1 hover:bg-[var(--bg-secondary)] disabled:opacity-50"
                title={translatedText != null ? "收起翻譯" : "翻譯為繁中"}
                aria-label="翻譯"
              >
                <Languages
                  className={cn(
                    "size-3.5",
                    translatedText != null ? "text-[var(--accent)]" : "text-[var(--muted-foreground)]",
                  )}
                />
              </button>
            )}
            {canForward && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setHoverMenuOpen(false);
                  onForward?.();
                }}
                className="px-2 py-1 hover:bg-[var(--bg-secondary)]"
                title="轉發到其他對話"
                aria-label="轉發訊息"
              >
                <Forward className="size-3.5 text-[var(--muted-foreground)]" />
              </button>
            )}
            {onPin && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setHoverMenuOpen(false);
                  onPin();
                }}
                className="px-2 py-1 hover:bg-[var(--bg-secondary)]"
                title={isPinned ? "取消釘選" : "釘選到對話頂端"}
                aria-label={isPinned ? "取消釘選訊息" : "釘選訊息"}
              >
                {isPinned ? (
                  <PinOff className="size-3.5 text-[var(--accent)]" />
                ) : (
                  <Pin className="size-3.5 text-[var(--muted-foreground)]" />
                )}
              </button>
            )}
            {onEdit && !isLeft && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setEditValue(content);
                  setIsEditing(true);
                  setHoverMenuOpen(false);
                  setEmojiPickerOpen(false);
                }}
                disabled={actionBusy}
                className="px-2 py-1 hover:bg-[var(--bg-secondary)] disabled:opacity-50"
                title="編輯訊息(48 小時內可改)"
                aria-label="編輯訊息"
              >
                <Pencil className="size-3.5 text-[var(--muted-foreground)]" />
              </button>
            )}
            {onDelete && !isLeft && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setHoverMenuOpen(false);
                  void handleDelete();
                }}
                disabled={actionBusy}
                className="px-2 py-1 hover:bg-[var(--destructive)]/10 disabled:opacity-50"
                title="刪除訊息"
                aria-label="刪除訊息"
              >
                <Trash2 className="size-3.5 text-[var(--destructive)]" />
              </button>
            )}
          </div>,
          document.body,
        )}

      {/* ───────── Portaled emoji picker ───────── */}
      {emojiPickerOpen &&
        onReact &&
        bubbleRect &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            ref={pickerRef}
            role="menu"
            aria-label="選擇 emoji"
            className="fixed z-[1000] flex gap-1 rounded-md border border-[var(--border)] bg-[var(--bg-primary)] p-2 shadow-[0_8px_24px_rgba(25,24,23,0.08)] animate-[slide-in-from-top_140ms_ease-out]"
            style={{
              // 預設展開在 bubble 下方;若超出 viewport 底端,改放上方
              top:
                bubbleRect.bottom + 8 + 56 > window.innerHeight
                  ? Math.max(8, bubbleRect.top - 56)
                  : bubbleRect.bottom + 8,
              left: isLeft
                ? Math.min(window.innerWidth - 320, bubbleRect.left)
                : Math.max(8, bubbleRect.right - 320),
            }}
            onClick={(e) => e.stopPropagation()}
          >
            {["👍", "❤️", "🔥", "😂", "😢", "👏", "👎", "🤔", "🎉"].map((emoji) => (
              <button
                key={emoji}
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  void handleReact(emoji);
                }}
                disabled={actionBusy}
                className="text-lg leading-none p-1 rounded hover:bg-[var(--bg-secondary)] disabled:opacity-50"
                title={`Reaction: ${emoji}`}
                aria-label={`Reaction ${emoji}`}
              >
                {emoji}
              </button>
            ))}
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                void handleReact(null);
              }}
              disabled={actionBusy}
              className="ml-1 text-xs px-2 rounded text-[var(--text-muted)] hover:bg-[var(--bg-secondary)] disabled:opacity-50 self-center"
              title="清除 reaction"
            >
              清除
            </button>
          </div>,
          document.body,
        )}
    </div>
  );
}

export function DateSeparator({ date }: { date: string | Date }) {
  const d = typeof date === "string" ? new Date(date) : date;
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  let label: string;
  if (d.toDateString() === today.toDateString()) label = "今天";
  else if (d.toDateString() === yesterday.toDateString()) label = "昨天";
  else
    label = d.toLocaleDateString("zh-TW", {
      year: d.getFullYear() !== today.getFullYear() ? "numeric" : undefined,
      month: "short",
      day: "numeric",
    });
  return (
    // Editorial date separator: small caps tracked-out label on cream
    // surface, no backdrop blur (anti-glass per §9).
    <div className="sticky top-2 z-10 my-3 flex justify-center">
      <span className="ui-label rounded-sm bg-[var(--bg-secondary)] px-2 py-0.5 text-[var(--text-muted)]">
        {label}
      </span>
    </div>
  );
}

export function SystemNote({
  children,
  icon: Icon,
}: {
  children: React.ReactNode;
  icon?: typeof Reply;
}) {
  return (
    <div className="my-2 flex justify-center">
      <span className="inline-flex items-center gap-1 rounded-full bg-[var(--muted)]/80 px-2.5 py-0.5 text-[10px] text-[var(--muted-foreground)]">
        {Icon && <Icon className="size-3" />}
        {children}
      </span>
    </div>
  );
}
