"use client";

import { useEffect, useState, useRef, useMemo, useCallback } from "react";
import { useParams } from "next/navigation";
// 注意：原本還有 Tabs / TabsContent / TabsList / TabsTrigger 跟 ConversationHistory，
// 現已合併「即時對話」+「歷史記錄」兩個 tab 為單一視圖（兩者功能 80% 重複，
// 「歷史記錄」反而漏撈 Message 表的訊息）→ 全部 imports 拿掉以保持精簡。
import { AccountSwitcher, getLastAccountForGroup, saveLastAccountForGroup } from "@/components/direct-chat/AccountSwitcher";
import { ConversationPanel } from "@/components/direct-chat/conversation-panel";
import { EmbeddedTelegramCallModal } from "@/components/direct-chat/embedded-telegram-call-modal";
// ConversationHistory 已不使用（合併到「對話」視圖）— 留 import 註解避免被
// 自動移除腳本誤刪整個 ConversationHistory 元件（仍有 export 路徑可能在
// pairings/messages 之類其他頁參考）。
import { FileUpload } from "@/components/ui/file-upload";
import { ChatBubble, DateSeparator, type ChatBubbleStatus } from "@/components/chat/chat-bubble";
import { MessageHistoryDialog } from "@/components/chat/message-history-dialog";
import { ChatAvatar } from "@/components/chat/avatar";
import {
  ChatListItem,
  type ChatListItemMessage,
} from "@/components/chat/chat-list-item";
import { VirtualChatList, type VirtualChatListHandle } from "@/components/chat/virtual-chat-list";
import { TypingIndicator } from "@/components/chat/typing-indicator";
import { useTypingIndicator } from "@/hooks/use-typing-indicator";
import { SwipeToReply } from "@/components/chat/swipe-to-reply";
import { useSSE } from "@/hooks/use-sse";
import {
  Send, Paperclip, MessageCircle, X, Loader2, ChevronLeft,
  Search, MoreVertical, Bell, BellOff, Users, UserPlus, Ban,
  CheckSquare, History, Info, Pencil, Trash2, Palette, Eraser,
  UserCheck, Smile, Layers, Pin, PinOff, ChevronDown, ChevronUp, Radio, PlayCircle, File, PhoneCall,
  MessageSquareQuote,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { ForwardChatPicker } from "@/components/chat/forward-chat-picker";
import { GroupMembersPanel } from "@/components/chat/group-members-panel";
import {
  QuickReplyAutocomplete,
  type QuickReplyAutocompleteHandle,
  type QuickReply,
} from "@/components/chat/quick-reply-autocomplete";
import { QuickReplyPicker } from "@/components/chat/quick-reply-picker";
import { AICopilotPanel } from "@/components/chat/ai-copilot-panel";
import { EmojiPicker } from "@/components/direct-chat/EmojiPicker";
import { StickerPicker, type StickerInfo } from "@/components/direct-chat/StickerPicker";
import BroadcastPanel, { type BroadcastGroup } from "@/components/direct-chat/BroadcastPanel";
import {
  OutboundComposerPanels,
  OutboundComposerShortcutBar,
  type ComposerPanel,
  type OutboundNativePayload,
} from "@/components/direct-chat/outbound-composer-panels";
import { useToast } from "@/hooks/use-toast";

type Group = {
  id: string;
  title: string;
  platformGroupId: string;
  side: "CUSTOMER" | "INTERNAL" | "UNASSIGNED";
  chatType: "GROUP" | "PRIVATE" | "CHANNEL";
  customerName?: string;
  accountMemberships: { account: { id: string; displayName: string } }[];
  lastMessage?: ChatListItemMessage | null;
  /** P1 釘選對話到頂的 ISO timestamp;null = 沒釘。 */
  conversationPinnedAt?: string | null;
  /** P2 靜音通知截止 ISO timestamp;> now = 靜音中,null = 沒靜音。 */
  notificationsMutedUntil?: string | null;
  /** 對話標籤（從 Group.tags 帶來）。 */
  tags?: string[];
  updatedAt?: string | null;
};

type ChatFilter = "private" | "group" | "all";

type MessageType = "TEXT" | "IMAGE" | "DOCUMENT" | "AUDIO" | "VIDEO" | "STICKER" | "VOICE" | "VIDEO_NOTE" | "LOCATION" | "CONTACT" | "POLL" | "DICE" | "STORY";

type ChatMessage = {
  id: string;
  content: string;
  sender: string;
  /** Raw Telegram user id for bridge messages, null for staff-sent. */
  senderPlatformId?: string | null;
  timestamp: string;
  source: "direct" | "bridge";
  direction: "outgoing" | "incoming";
  messageType: MessageType;
  status?: string;
  isDeleted?: boolean;
  deletedAt?: string | null;
  editedAt?: string | null;
  /** 訊息釘選時間;null = 未釘。釘到對話視窗頂端的內部標記。 */
  pinnedAt?: string | null;
  mediaUrl?: string | null;
  mediaType?: string | null;
  mediaFileName?: string | null;
  /** Bytes-less payload (LOCATION / CONTACT / POLL)。 */
  mediaMetadata?: {
    geo?: { lat: number; lng: number; livePeriod?: number };
    contact?: { firstName?: string; lastName?: string; phone?: string; userId?: string };
    poll?: {
      question: string;
      options: Array<{ text: string; voters?: number }>;
      totalVoters?: number;
      closed?: boolean;
    };
    dice?: { emoticon: string; value?: number };
    story?: { storyId: number; peerId?: string; expired?: boolean };
  } | null;
  /** Telegram platform message id — 給 reaction / reply lookups 用 */
  platformMessageId?: string | null;
  /** Telegram message id this message is a reply to, if any. Used for jump-to-reply. */
  replyToPlatformId?: string | null;
  /** P2: 轉發來源 metadata;原生訊息為 null。 */
  forwardedFrom?: {
    senderName?: string;
    channelTitle?: string;
    channelPlatformId?: string;
    senderPlatformUserId?: string;
    originalMessageId?: string;
    date?: string;
  } | null;
  /** P2: TG forum topic id;非 forum 訊息為 null。 */
  topicId?: number | null;
  /** P3: Channel post 觀看數;非 channel 訊息為 null。 */
  viewCount?: number | null;
  /** P3: TG quote reply 引用片段;一般回覆為 null。 */
  quoteText?: string | null;
  /** TG 同步回來的 emoji reactions（chips 顯示用）*/
  reactions?: Array<{ emoji: string; count: number; chosen: boolean }> | null;
  /**
   * 真實已讀回執 (2026-05-21 Backend-first):
   *   deliveredAt — TG 對方裝置已收到 OUTBOUND 訊息 (2 灰勾)。
   *   readAt      — TG 對方已讀 OUTBOUND 訊息 (2 藍勾)。
   * 兩者只對 outgoing 有意義;incoming 為 null。
   */
  deliveredAt?: string | null;
  readAt?: string | null;
  /**
   * 2026-05-21 TG parity:Message entities + Album grouped_id。
   *   entities  — TG `message.entities[]` normalize 過(bold/italic/spoiler/blockquote
   *               /mention_name/text_url 等);null = 純文字無格式。
   *   groupedId — TG album 共享 id,同 groupId + 同 groupedId 的訊息要合併渲染。
   */
  entities?: Array<{
    type: string;
    offset: number;
    length: number;
    url?: string;
    userId?: string;
    documentId?: string;
    language?: string;
  }> | null;
  groupedId?: string | null;
  /**
   * 2026-05-21 訊息按鈕:bot / 服務帳號訊息的 inline keyboard。
   * null = 沒按鈕。
   */
  replyMarkup?: {
    type: string;
    rows: Array<
      Array<{ text: string; kind: string; data?: string; url?: string }>
    >;
  } | null;
};

type ConversationSummary = {
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
};

type EmbeddedCallState = {
  groupId: string;
  title: string;
  mode: "voice" | "video";
  direction: "outgoing" | "incoming";
  accountId: string;
  gatewaySessionId?: string;
  remoteStateHint?: string;
};

function normalizeGroupTags(tags: unknown): string[] {
  return Array.isArray(tags)
    ? tags.filter((tag): tag is string => typeof tag === "string")
    : [];
}

function sameTags(a: string[] | undefined, b: string[]): boolean {
  const left = normalizeGroupTags(a);
  if (left.length !== b.length) return false;
  return left.every((tag, index) => tag === b[index]);
}

function groupListFingerprint(items: Group[]): string {
  return items
    .map((g) =>
      [
        g.id,
        g.updatedAt ?? "",
        normalizeGroupTags(g.tags).join(","),
        g.conversationPinnedAt ?? "",
        g.notificationsMutedUntil ?? "",
        g.lastMessage?.timestamp ?? "",
        g.lastMessage?.content ?? "",
      ].join(":"),
    )
    .join("|");
}

export default function DirectChatPage() {
  const { workspaceId } = useParams<{ workspaceId: string }>();
  const { toast, confirm } = useToast();
  const [groups, setGroups] = useState<Group[]>([]);
  const [selectedGroup, setSelectedGroup] = useState<string>("");
  const [embeddedCall, setEmbeddedCall] = useState<EmbeddedCallState | null>(null);

  // 當前操作者的顯示名 — 用來組樂觀訊息的「TG名(操作者)」標籤。
  // (2026-05-21:currentUserId 隨「對話持有人 / 接手」功能一起移除。)
  const [currentUserName, setCurrentUserName] = useState<string>("");
  /**
   * 是否為可編輯選單設定的身份（工作空間管理員 OR 系統管理員）。
   * 只控制「是否能看到 ⚙ 選單設定」，不直接決定操作項目的顯示。
   */
  const [canManage, setCanManage] = useState(false);
  useEffect(() => {
    fetch("/api/auth/me")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        const name = d?.user?.displayName;
        if (name) setCurrentUserName(name);
        const isSystemAdmin: boolean = d?.user?.isSystemAdmin ?? false;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const wsPerms = (d?.user?.workspaces as any[])?.find(
          (w) => w.id === workspaceId,
        )?.permissions;
        const isWorkspaceAdmin: boolean =
          wsPerms?.canEditWorkspaceSettings ?? false;
        setCanManage(isSystemAdmin || isWorkspaceAdmin);
      })
      .catch(() => null);
  }, [workspaceId]);

  /**
   * 三個敏感操作的個別顯示開關。
   * 預設全部 false（連管理員也不自動顯示），由主管儀表板（或 ⋮ 選單設定）統一設定。
   * 設定儲存在工作區 DB（workspace.uiConfig）。
   */
  type MenuConfig = { showMute: boolean; showClear: boolean; showDelete: boolean };
  const [menuConfig, setMenuConfig] = useState<MenuConfig>({ showMute: false, showClear: false, showDelete: false });
  const [menuSettingsOpen, setMenuSettingsOpen] = useState(false);

  // Fetch workspace-level ui config on mount.
  useEffect(() => {
    fetch(`/api/workspaces/${workspaceId}/ui-config`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d?.uiConfig?.menuConfig) setMenuConfig(d.uiConfig.menuConfig as MenuConfig);
      })
      .catch(() => null);
  }, [workspaceId]);

  const updateMenuConfig = (patch: Partial<MenuConfig>) => {
    setMenuConfig((prev) => {
      const next = { ...prev, ...patch };
      // Persist to DB; fire-and-forget.
      fetch(`/api/workspaces/${workspaceId}/ui-config`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(next),
      }).catch(() => null);
      return next;
    });
  };

  // Per-group unread：哪一個 chat 有幾筆未讀（給左側列表 badge）。
  // sessionStorage 持久化避免 sidebar / 頁面重新 mount 後 badge 消失。
  const unreadStorageKey = `switchboard_direct_unread_${workspaceId}`;
  const [unreadByGroup, setUnreadByGroup] = useState<Record<string, number>>(
    () => {
      if (typeof window === "undefined") return {};
      try {
        const raw = sessionStorage.getItem(unreadStorageKey);
        return raw ? (JSON.parse(raw) as Record<string, number>) : {};
      } catch {
        return {};
      }
    },
  );
  useEffect(() => {
    try {
      sessionStorage.setItem(unreadStorageKey, JSON.stringify(unreadByGroup));
    } catch {
      // storage 滿 / 不可用 → 安靜略過
    }
  }, [unreadByGroup, unreadStorageKey]);

  // 點進某 chat → 清該 chat badge + 通知側邊欄清整體直面對話 badge
  useEffect(() => {
    if (!selectedGroup) return;
    setUnreadByGroup((prev) => {
      if (!prev[selectedGroup]) return prev;
      const next = { ...prev };
      delete next[selectedGroup];
      // 同步寫回 sessionStorage 讓 sidebar / 別頁也看到清空
      try {
        sessionStorage.setItem(unreadStorageKey, JSON.stringify(next));
      } catch {}
      return next;
    });
    window.dispatchEvent(
      new CustomEvent("switchboard:chat-viewed", { detail: { kind: "direct" } }),
    );
  }, [selectedGroup, unreadStorageKey]);

  // 監聽 sidebar 寫入 per-group unread → 從 storage 重讀
  useEffect(() => {
    function handler(e: Event) {
      const detail = (e as CustomEvent).detail as { kind?: string };
      if (detail.kind !== "direct") return;
      try {
        const raw = sessionStorage.getItem(unreadStorageKey);
        if (raw) setUnreadByGroup(JSON.parse(raw));
      } catch {}
    }
    window.addEventListener("switchboard:unread-updated", handler);
    return () => window.removeEventListener("switchboard:unread-updated", handler);
  }, [unreadStorageKey]);
  const [selectedAccount, setSelectedAccount] = useState<string>("");
  const [input, setInput] = useState("");
  // P3 草稿持久化:每個 (workspace, group) 各自記憶未送出的 composer text。
  // sessionStorage 範圍而非 localStorage — 跨重新整理可保留,跨關閉瀏覽器清空
  // (草稿不應該長期殘留;不同 user 用同瀏覽器登入也不該看到彼此的草稿)。
  const draftStorageKey = (groupId: string) =>
    `switchboard_draft_${workspaceId}_${groupId}`;
  // 切換對話 → 把當前 input 存到「離開的對話」的 draft 槽,然後載入新對話的草稿。
  // 用 ref 記住「上一個 selectedGroup」,避免 effect 依賴本身造成迴圈。
  const prevSelectedGroupRef = useRef<string>("");
  useEffect(() => {
    const prev = prevSelectedGroupRef.current;
    if (prev && prev !== selectedGroup) {
      // 把舊對話的當前 input 寫回去
      try {
        if (input.trim()) {
          sessionStorage.setItem(draftStorageKey(prev), input);
        } else {
          sessionStorage.removeItem(draftStorageKey(prev));
        }
      } catch {}
    }
    if (selectedGroup) {
      try {
        const saved = sessionStorage.getItem(draftStorageKey(selectedGroup));
        setInput(saved ?? "");
      } catch {
        setInput("");
      }
    }
    prevSelectedGroupRef.current = selectedGroup;
    // 只 watch selectedGroup 變化;input 同步存草稿走下面獨立 effect。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedGroup, workspaceId]);
  // 每次 input 變化 → debounce 200ms 寫進當前對話的草稿槽,避免每 keystroke
  // 都打 sessionStorage(連續輸入幾百字時影響可感)。
  useEffect(() => {
    if (!selectedGroup) return;
    const t = setTimeout(() => {
      try {
        if (input.trim()) {
          sessionStorage.setItem(draftStorageKey(selectedGroup), input);
        } else {
          sessionStorage.removeItem(draftStorageKey(selectedGroup));
        }
      } catch {}
    }, 200);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [input, selectedGroup, workspaceId]);
  const [replyingTo, setReplyingTo] = useState<ChatMessage | null>(null);
  /**
   * 2026-05-21 Quote-reply on send:點 reply 時若使用者剛好有選取此訊息的某段文字,
   * 就把該段當「引用片段」一起送(TG 2023+ 的 message.replyTo.quoteText / quoteOffset)。
   * null = 一般 reply(無 quote)。
   *
   * 計算策略:不算 DOM offset(經過 entity-walking render 後跨多個 span 不可靠),
   * 改用「選取文字在原 content 中的 indexOf」當 offset — 對重複片段抓第一次出現,
   * 對 99% 場景夠用。
   */
  const [replyingQuote, setReplyingQuote] = useState<{ text: string; offset: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [showFileUpload, setShowFileUpload] = useState(false);
  const [mediaMode, setMediaMode] = useState<"file" | "voiceNote" | "videoNote">("file");
  const [composerPanel, setComposerPanel] = useState<ComposerPanel>(null);
  const [emojiPickerOpen, setEmojiPickerOpen] = useState(false);
  const [stickerPickerOpen, setStickerPickerOpen] = useState(false);
  const [quickReplyPickerOpen, setQuickReplyPickerOpen] = useState(false);
  // activeTab 已移除（合併「即時對話」+「歷史記錄」為單一視圖）
  const [groupSearch, setGroupSearch] = useState("");
  const [hideSystemConvos, setHideSystemConvos] = useState(true);
  // 篩選器：私聊 / 群組 / 全部 — 預設「私聊」（直面對話最常用就是 1-on-1）。
  // 偏好用 sessionStorage 記住，切回來不用再點。
  const [chatFilter, setChatFilter] = useState<ChatFilter>(() => {
    if (typeof window === "undefined") return "private";
    try {
      const saved = sessionStorage.getItem(`switchboard_direct_filter_${workspaceId}`);
      if (saved === "private" || saved === "group" || saved === "all") return saved;
    } catch {}
    return "private";
  });
  useEffect(() => {
    try {
      sessionStorage.setItem(`switchboard_direct_filter_${workspaceId}`, chatFilter);
    } catch {}
  }, [chatFilter, workspaceId]);
  // Previously a dropdown; now replaced by a persistent left sidebar.
  // State kept as no-op so legacy refactor doesn't trip other effects.
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [chatLoading, setChatLoading] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  // 2026-05-21:直面對話為核心 — 移除「結案 / 持有人 / 分派」這套案件管理概念。
  // conversation 仍保留作「最近客戶來訊」資訊條用;狀態 / 接手 / 釋出 全拿掉。
  const [conversation, setConversation] = useState<ConversationSummary | null>(null);
  // TG 行為:對話資訊面板「預設展開」;可從 ⋮ 選單或 header 頭像 / 名字關閉。
  const [infoPanelOpen, setInfoPanelOpen] = useState(true);
  // 點氣泡 footer 上的「已編輯」/「已刪除」會把 dcm id 塞進這裡 → 開 history dialog
  const [historyMessageId, setHistoryMessageId] = useState<string | null>(null);
  // Auto-scroll is now handled by VirtualChatList's followOutput, no ref needed.
  const selectedGroupRef = useRef(selectedGroup);
  selectedGroupRef.current = selectedGroup;
  const groupsRef = useRef<Group[]>(groups);
  const groupsFingerprintRef = useRef(groupListFingerprint(groups));
  groupsRef.current = groups;
  groupsFingerprintRef.current = groupListFingerprint(groups);

  const replaceGroups = useCallback((next: Group[]) => {
    groupsRef.current = next;
    groupsFingerprintRef.current = groupListFingerprint(next);
    setGroups(next);
  }, []);

  const refreshGroups = useCallback(async () => {
    const res = await fetch(
      `/api/workspaces/${workspaceId}/groups?includePreview=true`,
    );
    if (!res.ok) return null;
    const data = await res.json();
    const fetched: Group[] = Array.isArray(data.groups) ? data.groups : [];
    replaceGroups(fetched);
    return fetched;
  }, [replaceGroups, workspaceId]);

  const applyGroupTags = useCallback(
    (groupId: string, tags: string[], meta?: { updatedAt?: string }) => {
      const nextTags = normalizeGroupTags(tags);
      setGroups((prev) => {
        let changed = false;
        const next = prev.map((g) => {
          if (g.id !== groupId) return g;
          const updatedAt = meta?.updatedAt ?? g.updatedAt ?? null;
          if (sameTags(g.tags, nextTags) && updatedAt === (g.updatedAt ?? null)) {
            return g;
          }
          changed = true;
          return { ...g, tags: nextTags, updatedAt };
        });
        if (!changed) return prev;
        groupsRef.current = next;
        groupsFingerprintRef.current = groupListFingerprint(next);
        return next;
      });
    },
    [],
  );

  // ── 對話訊息快取 ────────────────────────────────────────────────────────────
  // 切換對話時保留已載入的訊息（避免切回來時圖片消失、VirtualList 重建）。
  // messagesRef / hasMoreRef 讓 effect cleanup 永遠拿到最新值。
  const msgCacheRef = useRef<Map<string, { messages: ChatMessage[]; hasMore: boolean }>>(new Map());
  const messagesRef = useRef(messages);
  const hasMoreRef = useRef(hasMore);
  messagesRef.current = messages;
  hasMoreRef.current = hasMore;

  // P1 TG 群組釘選訊息 — 開對話時 fetch 一次,沒有就 null。1 分鐘內不重打。
  type PinnedInfo = {
    platformMessageId: string;
    dcmId: string | null;
    content: string | null;
    messageType: string | null;
    senderDisplayName: string | null;
    timestamp: string | null;
    mediaFileName: string | null;
  };
  const [pinnedInfo, setPinnedInfo] = useState<PinnedInfo | null>(null);
  useEffect(() => {
    if (!selectedGroup) {
      setPinnedInfo(null);
      return;
    }
    let cancelled = false;
    fetch(`/api/workspaces/${workspaceId}/groups/${selectedGroup}/pinned`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!cancelled) setPinnedInfo(d?.pinned ?? null);
      })
      .catch(() => null);
    return () => {
      cancelled = true;
    };
  }, [selectedGroup, workspaceId]);

  // P1 jump-to-reply + in-chat search 共用的 scroll handle。
  // VirtualChatList 暴露 scrollToKey(key),這裡保 ref 給上面的 onReplyJump /
  // 搜尋 hit 切換 / 搜尋第一筆 auto-scroll 使用。
  const virtuosoRef = useRef<VirtualChatListHandle>(null);

  // P1 jump-to-reply 的 highlight 狀態 — 切到目標 bubble 後加 ring,1.5s 後 reset。
  const [highlightedMessageId, setHighlightedMessageId] = useState<string | null>(null);
  useEffect(() => {
    if (!highlightedMessageId) return;
    const t = setTimeout(() => setHighlightedMessageId(null), 1500);
    return () => clearTimeout(t);
  }, [highlightedMessageId]);

  // P1 in-chat search:client-side filter 目前載入訊息,加 server-side 跨歷史。
  //   - searchMatches: 目前載入訊息中的命中(可立刻跳轉)
  //   - serverSearchMatches: 整個對話歷史的命中(包含未載入的更早歷史)
  //   - "更早歷史中還有 N 筆"由兩者差集計算,使用者按「載入往前找」會
  //     loadMore 多次直到 oldest server match 進入視野
  const [searchQuery, setSearchQuery] = useState("");
  const [searchMatchIdx, setSearchMatchIdx] = useState(0);
  const [serverSearchMatches, setServerSearchMatches] = useState<ChatMessage[]>([]);
  // 對話搜尋列預設收合;由 chat header 右上角放大鏡 toggle(2026-05-21)
  const [searchOpen, setSearchOpen] = useState(false);
  // ⋮ 三點選單開關;預設收合
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);
  // 補抓 TG 歷史:busy flag(選單內顯示 spinner)
  const [backfillBusy, setBackfillBusy] = useState(false);
  // 群發面板開關
  const [broadcastOpen, setBroadcastOpen] = useState(false);
  // 頁面載入時自動批次補抓（無訊息的對話）
  const [autoBackfillStatus, setAutoBackfillStatus] = useState<string | null>(null);
  const autoBackfillRunRef = useRef(false);
  const [loadingUntilMatch, setLoadingUntilMatch] = useState(false);
  // 切換對話 / 清空對話清單 → 重置搜尋,避免 stale 高亮
  useEffect(() => {
    setSearchQuery("");
    setSearchMatchIdx(0);
    setServerSearchMatches([]);
  }, [selectedGroup]);

  // Server-side 跨歷史搜尋:debounce 300ms,query 至少 2 字才打。
  // 結果丟到 serverSearchMatches state,UI 用 set diff 顯示「更早歷史 N 筆」。
  useEffect(() => {
    if (!selectedGroup) return;
    const q = searchQuery.trim();
    if (q.length < 2) {
      setServerSearchMatches([]);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(
          `/api/workspaces/${workspaceId}/groups/${selectedGroup}/chat/search?q=${encodeURIComponent(q)}`,
        );
        if (!res.ok || cancelled) return;
        const data = await res.json();
        setServerSearchMatches(data.matches as ChatMessage[]);
      } catch {
        // 非致命,UI fallback 到只用 local matches
      }
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [searchQuery, selectedGroup, workspaceId]);

  const searchMatches = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return [] as ChatMessage[];
    return messages.filter((m) => (m.content ?? "").toLowerCase().includes(q));
  }, [messages, searchQuery]);
  // 第一筆 / 切下一個 hit 時自動 scrollToKey
  useEffect(() => {
    if (searchMatches.length === 0) return;
    const idx = Math.min(searchMatchIdx, searchMatches.length - 1);
    const target = searchMatches[idx];
    if (target) {
      virtuosoRef.current?.scrollToKey(target.id, { align: "center" });
    }
  }, [searchMatches, searchMatchIdx]);
  // 改搜尋字串 → idx 回到最後一筆(最新)
  useEffect(() => {
    if (searchMatches.length > 0) {
      setSearchMatchIdx(searchMatches.length - 1);
    }
  }, [searchMatches.length]);

  // P1 jump-to-reply:把 replyToPlatformId 找回原始訊息的 m.id,scrollToKey + highlight。
  const handleReplyJump = useCallback(
    (replyToPlatformId: string) => {
      const target = messages.find((m) => m.platformMessageId === replyToPlatformId);
      if (!target) {
        // 不在目前載入的訊息範圍 — 之後加 server-side jump 才能補。
        return;
      }
      virtuosoRef.current?.scrollToKey(target.id, { align: "center" });
      setHighlightedMessageId(target.id);
    },
    [messages],
  );

  // 頂端釘選列:目前對話已釘選的訊息,依釘選時間倒序(最新釘的在最前)。
  // 用 localeCompare 確保 comparator 一致(批量釘選會有相同 pinnedAt,相等回 0)。
  const pinnedMessages = useMemo(
    () =>
      messages
        .filter((m) => m.pinnedAt && !m.isDeleted)
        .sort((a, b) => (b.pinnedAt ?? "").localeCompare(a.pinnedAt ?? "")),
    [messages],
  );
  // 私訊:訊息頭像沿用對話頭像。memo 化避免每 render 重算/產生新字串(否則放大
  // 長訊息列表的 re-render)。deps 用基本型別,groups 更新但對話本身不變時不重算。
  const peerGroupForAvatar = groups.find((x) => x.id === selectedGroup);
  const peerAvatarSrc = useMemo(
    () =>
      peerGroupForAvatar?.chatType === "PRIVATE" && peerGroupForAvatar.platformGroupId
        ? `/api/workspaces/${workspaceId}/group-avatars/${encodeURIComponent(peerGroupForAvatar.platformGroupId)}`
        : null,
    [peerGroupForAvatar?.chatType, peerGroupForAvatar?.platformGroupId, workspaceId],
  );
  const jumpToMessage = useCallback((id: string) => {
    virtuosoRef.current?.scrollToKey(id, { align: "center" });
    setHighlightedMessageId(id);
  }, []);
  // 合併「TG 端釘選」(對方在 Telegram 釘的,pinnedInfo)+「我方釘選」(CS 內部釘的,
  // pinnedMessages)成單一釘選清單 — 不再疊兩層 banner。TG 釘選排最前。
  const allPinned = useMemo(() => {
    const out: Array<{
      key: string;
      msgId: string | null;
      source: "tg" | "cs";
      sender: string | null;
      preview: string;
      canUnpin: boolean;
    }> = [];
    const seen = new Set<string>();
    if (pinnedInfo) {
      out.push({
        key: `tg-${pinnedInfo.dcmId ?? pinnedInfo.platformMessageId}`,
        msgId: pinnedInfo.dcmId,
        source: "tg",
        sender: pinnedInfo.senderDisplayName,
        preview: pinnedInfo.content
          ? pinnedInfo.messageType === "TEXT"
            ? pinnedInfo.content
            : pinnedInfo.mediaFileName ?? `[${pinnedInfo.messageType ?? "MEDIA"}]`
          : "(該訊息不在已載入歷史)",
        canUnpin: false,
      });
      if (pinnedInfo.dcmId) seen.add(pinnedInfo.dcmId);
    }
    for (const m of pinnedMessages) {
      if (seen.has(m.id)) continue;
      out.push({
        key: `cs-${m.id}`,
        msgId: m.id,
        source: "cs",
        sender: m.sender ?? null,
        preview: m.content?.trim() || `[${m.messageType}]`,
        canUnpin: true,
      });
    }
    return out;
  }, [pinnedInfo, pinnedMessages]);

  // 釘選面板(LINE 風格):頂端常駐顯示最新釘選,可展開看全部 + 逐則跳轉/取消。
  const [pinPanelOpen, setPinPanelOpen] = useState(false);
  useEffect(() => {
    if (allPinned.length === 0) setPinPanelOpen(false);
  }, [allPinned.length]);

  // P2 群組成員列表 — 顯示 modal,true 才開
  const [showMembersPanel, setShowMembersPanel] = useState(false);

  // P3 批次標記已讀 — 一鍵清空所有 chat 的 per-group 未讀 + sidebar 整體 badge。
  // 純前端狀態,跟現有「點 chat = 清該 chat 未讀」一致,只是一次清全部。
  const handleMarkAllRead = useCallback(() => {
    setUnreadByGroup({});
    try {
      sessionStorage.setItem(unreadStorageKey, JSON.stringify({}));
    } catch {
      // storage 不可用就算了
    }
    // 通知 sidebar 清整體 direct-chat badge — 沿用既有 switchboard:chat-viewed 事件
    window.dispatchEvent(
      new CustomEvent("switchboard:chat-viewed", { detail: { kind: "direct" } }),
    );
    toast.success("已將所有直面對話標記為已讀");
  }, [unreadStorageKey, toast]);

  // P2 原生 TG 資料夾同步 — 員工已在 TG 客戶端分好類,sync 過來當 chat list 快選。
  type TgFolderDecorated = {
    id: string;
    accountId: string;
    accountName: string;
    tgFilterId: number;
    title: string;
    emoticon: string | null;
    groupIds: string[];
    syncedAt: string;
  };
  const [tgFolders, setTgFolders] = useState<TgFolderDecorated[]>([]);
  const [selectedTgFolderId, setSelectedTgFolderId] = useState<string | null>(null);
  const [tgFoldersSyncing, setTgFoldersSyncing] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/workspaces/${workspaceId}/tg-folders`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!cancelled) setTgFolders((d?.folders ?? []) as TgFolderDecorated[]);
      })
      .catch(() => null);
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  async function handleTgFolderSync() {
    if (tgFoldersSyncing) return;
    setTgFoldersSyncing(true);
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/tg-folders`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!res.ok) {
        toast.error("資料夾同步失敗");
        return;
      }
      // 重 fetch
      const refreshed = await fetch(`/api/workspaces/${workspaceId}/tg-folders`);
      if (refreshed.ok) {
        const data = await refreshed.json();
        setTgFolders((data?.folders ?? []) as TgFolderDecorated[]);
      }
      toast.success("已同步 Telegram 資料夾");
    } catch {
      toast.error("無法連線到後端");
    } finally {
      setTgFoldersSyncing(false);
    }
  }

  // 衍生:selectedTgFolderId 對應的 groupId 集合(O(1) lookup)
  const tgFolderGroupIdSet = useMemo(() => {
    if (!selectedTgFolderId) return null;
    const f = tgFolders.find((x) => x.id === selectedTgFolderId);
    return f ? new Set(f.groupIds) : null;
  }, [selectedTgFolderId, tgFolders]);

  // P2 跨對話全域搜尋 — 用既有左側 groupSearch 輸入框觸發,當 query ≥ 2 字
  // 時呼叫 /search,結果顯示在群組清單下方。點結果切到對應 chat + scroll 到該訊息。
  type GlobalSearchMatch = {
    dcmId: string;
    groupId: string;
    groupTitle: string;
    groupCustomerName: string | null;
    groupChatType: string;
    content: string;
    timestamp: string;
    direction: "incoming" | "outgoing";
    senderDisplayName: string | null;
    messageType: string;
  };
  const [globalSearchResults, setGlobalSearchResults] = useState<GlobalSearchMatch[]>([]);
  const [globalSearchLoading, setGlobalSearchLoading] = useState(false);

  // 搜尋分類 tabs — 仿 TG sidebar 搜尋 (聊天室 / 訊息 / 照片 / 影片 / 檔案)
  type SearchTab = "chats" | "messages" | "photo" | "video" | "file";
  const [searchTab, setSearchTab] = useState<SearchTab>("chats");
  type MediaSearchResult = {
    dcmId: string;
    groupId: string;
    groupTitle: string;
    content: string;
    timestamp: string;
    messageType: string;
    mediaUrl: string | null;
    mediaFileName: string | null;
    mediaType: string | null;
  };
  const [mediaSearchResults, setMediaSearchResults] = useState<MediaSearchResult[]>([]);
  const [mediaSearchLoading, setMediaSearchLoading] = useState(false);

  // 「點完搜尋結果後要跳到哪一筆 DCM」 — selectedGroup change 後 useEffect 抓
  // 完訊息會看這欄,在 messages 找得到 → scrollToKey + 清 pending;找不到 → loadUntilMatch。
  const [pendingScrollDcmId, setPendingScrollDcmId] = useState<string | null>(null);

  useEffect(() => {
    const q = groupSearch.trim();
    if (q.length < 2) {
      setGlobalSearchResults([]);
      setGlobalSearchLoading(false);
      return;
    }
    let cancelled = false;
    setGlobalSearchLoading(true);
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(
          `/api/workspaces/${workspaceId}/search?q=${encodeURIComponent(q)}`,
        );
        if (!res.ok || cancelled) {
          if (!cancelled) setGlobalSearchResults([]);
          return;
        }
        const data = await res.json();
        if (!cancelled) setGlobalSearchResults((data.matches ?? []) as GlobalSearchMatch[]);
      } catch {
        if (!cancelled) setGlobalSearchResults([]);
      } finally {
        if (!cancelled) setGlobalSearchLoading(false);
      }
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [groupSearch, workspaceId]);

  // 清空搜尋時重置 tab + 媒體結果
  useEffect(() => {
    if (groupSearch.trim().length === 0) {
      setSearchTab("chats");
      setMediaSearchResults([]);
    }
  }, [groupSearch]);

  // 媒體搜尋 — 照片/影片/檔案 tab 切換或 query 變化時觸發
  useEffect(() => {
    const isMediaTab = searchTab === "photo" || searchTab === "video" || searchTab === "file";
    if (!isMediaTab) {
      setMediaSearchResults([]);
      setMediaSearchLoading(false);
      return;
    }
    let cancelled = false;
    setMediaSearchLoading(true);
    const q = groupSearch.trim();
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(
          `/api/workspaces/${workspaceId}/search?type=${searchTab}&q=${encodeURIComponent(q)}&limit=100`,
        );
        if (!res.ok || cancelled) {
          if (!cancelled) setMediaSearchResults([]);
          return;
        }
        const data = await res.json();
        if (!cancelled) setMediaSearchResults((data.matches ?? []) as MediaSearchResult[]);
      } catch {
        if (!cancelled) setMediaSearchResults([]);
      } finally {
        if (!cancelled) setMediaSearchLoading(false);
      }
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [searchTab, groupSearch, workspaceId]);

  // 當 pendingScrollDcmId 變化(搜尋結果點擊後)+ messages 也載完後,做跳轉
  useEffect(() => {
    if (!pendingScrollDcmId || messages.length === 0) return;
    const target = messages.find((m) => m.id === pendingScrollDcmId);
    if (target) {
      virtuosoRef.current?.scrollToKey(target.id, { align: "center" });
      setHighlightedMessageId(target.id);
      setPendingScrollDcmId(null);
    } else if (hasMore) {
      // 不在已載入訊息中 → 啟動 loadUntilMatch 把舊歷史拉進來
      void loadUntilMatch(pendingScrollDcmId);
      setPendingScrollDcmId(null); // loadUntilMatch 內部會處理 highlight
    } else {
      // 沒更多歷史可載且找不到 — 安靜放棄(可能訊息已被刪)
      setPendingScrollDcmId(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingScrollDcmId, messages, hasMore]);

  // P2 看誰按了反應:DCM id → API /reactors → 回 popover 用的 displayName 清單。
  const handleShowReactors = useCallback(
    async (messageId: string) => {
      if (!selectedGroup) return [];
      const res = await fetch(
        `/api/workspaces/${workspaceId}/groups/${selectedGroup}/messages/${messageId}/reactors`,
      );
      if (!res.ok) return [];
      const data = await res.json();
      return (data.reactors ?? []) as Array<{
        platformUserId: string;
        displayName: string;
        username: string | null;
        emoji: string;
        date: string | null;
      }>;
    },
    [workspaceId, selectedGroup],
  );

  // 2026-05-21 二線(round 4)看誰已讀我方訊息(小群 ≤100 members + 訊息 ≤7 天):
  // DCM id → API /read-by → 回 popover 用的 readers 清單。
  // 後台 bridge 透過 messages.GetMessageReadParticipants 取得;大群 / 過舊回空名單。
  // UI 重用 reactors popover 樣式(共享 onShowReactors 機制簡化整合)。
  const handleShowReaders = useCallback(
    async (messageId: string) => {
      const res = await fetch(
        `/api/workspaces/${workspaceId}/messages/${messageId}/read-by`,
      );
      if (!res.ok) return [];
      const data = await res.json();
      const readers = (data.readers ?? []) as Array<{
        platformUserId: string;
        displayName: string | null;
        avatarUrl: string | null;
      }>;
      // 對齊 reactors shape(supplier 一致的元件不需要分支)
      return readers.map((r) => ({
        platformUserId: r.platformUserId,
        displayName: r.displayName ?? "(未知用戶)",
        username: null,
        emoji: "✓✓",
        date: null,
      }));
    },
    [workspaceId],
  );

  // 2026-05-21 訊息按鈕:點 callback 按鈕 → API → bot 的 answer。
  // url 按鈕由 chat-bubble 自己開連結,不會走這支。
  const handleClickButton = useCallback(
    async (messageId: string, data: string) => {
      const res = await fetch(
        `/api/workspaces/${workspaceId}/messages/${messageId}/click-button`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ data }),
        },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error || "按鈕操作失敗");
      }
      const d = await res.json();
      return {
        message: (d?.message as string | null) ?? null,
        alert: Boolean(d?.alert),
        url: (d?.url as string | null) ?? null,
      };
    },
    [workspaceId],
  );

  // 翻譯:message-bound,優先打 native TG translation(per-message + 伺服端 cached
  // 進 ConversationMessageTranslation),422 (訊息尚未與 TG 同步) 才退回舊
  // /api/translate(Google 免費端點)。前者比後者:
  //   - 免費(計入 TG 帳號 quota,不吃我們的);
  //   - 高品質;
  //   - cache 在 server 端,跨員工跨裝置共用;
  //   - 對媒體 caption / 多語混排處理較好。
  const handleTranslateMessage = useCallback(
    async (messageId: string, fallbackText: string): Promise<string> => {
      // (1) 試 native TG 路線
      try {
        const res = await fetch(
          `/api/workspaces/${workspaceId}/messages/${messageId}/translate?lang=zh-TW`,
        );
        if (res.ok) {
          const data = await res.json();
          if (typeof data.translatedText === "string") {
            return data.translatedText as string;
          }
        } else if (res.status !== 422) {
          // 422 是「此訊息沒 platformMessageId」— 預期的降級條件。其他 4xx/5xx
          // 顯示原始 error 讓使用者知道發生什麼。
          const body = await res.json().catch(() => ({}));
          throw new Error(body?.error || `翻譯失敗 (HTTP ${res.status})`);
        }
      } catch (err) {
        // network fail → fall through to Google
        if (err instanceof Error && /HTTP \d+/.test(err.message)) {
          // server-side error 已 throw 過,別吞;只有 network/JSON 失敗才 fallthrough
          throw err;
        }
      }
      // (2) Google fallback — 用 bubble 傳進來的純文字
      const res = await fetch(`/api/translate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: fallbackText, targetLang: "zh-TW" }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error || "翻譯失敗");
      }
      const data = await res.json();
      return data.translated as string;
    },
    [workspaceId],
  );

  // P1 轉發 — 支援單條 + 多選批次轉發。forwardingMessage / forwardingBatch
  // 兩個 state 互斥:單條用前者(從 bubble 觸發);多選用後者(從 toolbar 觸發)。
  const [forwardingMessage, setForwardingMessage] = useState<ChatMessage | null>(null);
  const [forwardingBatch, setForwardingBatch] = useState<ChatMessage[] | null>(null);
  const [forwardBusy, setForwardBusy] = useState(false);

  // P1 多選模式 — 進入後 bubble 變成「點 = 切換選取」,toolbar 出「刪除」「轉發」
  // 「取消」三個 bulk action。退出 selection mode 自動清空 selectedIds。
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  // 切換對話 / 退出 selection mode 都清掉
  useEffect(() => {
    if (!selectionMode) setSelectedIds(new Set());
  }, [selectionMode]);
  useEffect(() => {
    setSelectionMode(false);
  }, [selectedGroup]);
  function toggleSelect(m: ChatMessage) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(m.id)) next.delete(m.id);
      else next.add(m.id);
      return next;
    });
  }
  const selectedMessages = useMemo(
    () => messages.filter((m) => selectedIds.has(m.id)),
    [messages, selectedIds],
  );
  async function handleForwardPick(targetGroupId: string) {
    if (!selectedGroup) return;
    // 單條 vs 多選:取決於哪個 state 有值
    const messageIds = forwardingBatch
      ? forwardingBatch.map((m) => m.id)
      : forwardingMessage
        ? [forwardingMessage.id]
        : [];
    if (messageIds.length === 0) return;
    setForwardBusy(true);
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/messages/forward`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fromGroupId: selectedGroup,
          messageIds,
          toGroupId: targetGroupId,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error || "轉發失敗");
        return;
      }
      const targetTitle = groups.find((g) => g.id === targetGroupId)?.title ?? "對話";
      toast.success(
        messageIds.length > 1
          ? `已轉發 ${messageIds.length} 則訊息到「${targetTitle}」`
          : `已轉發到「${targetTitle}」`,
      );
      setForwardingMessage(null);
      setForwardingBatch(null);
      // 多選後完成自動退出 selection mode
      if (selectionMode) setSelectionMode(false);
    } catch {
      toast.error("無法連線到後端");
    } finally {
      setForwardBusy(false);
    }
  }

  // P1 批次刪除 — loop 個別 DELETE endpoint。失敗的單筆會回報、不影響其他。
  // 樂觀更新:UI 立刻把這些訊息標 isDeleted(server SSE 也會跟著修正)。
  async function handleBulkDelete() {
    if (selectedMessages.length === 0) return;
    const ok = await confirm({
      title: "批次刪除訊息",
      message: `確定要刪除選取的 ${selectedMessages.length} 則訊息?同步刪除 Telegram 端,無法復原。`,
      confirmText: "刪除",
      danger: true,
    });
    if (!ok) return;

    const ids = selectedMessages.map((m) => m.id);
    // 樂觀更新
    setMessages((prev) =>
      prev.map((x) =>
        ids.includes(x.id)
          ? { ...x, isDeleted: true, deletedAt: new Date().toISOString() }
          : x,
      ),
    );
    let okCount = 0;
    let failCount = 0;
    for (const id of ids) {
      try {
        const res = await fetch(
          `/api/workspaces/${workspaceId}/direct-chat/messages/${id}`,
          { method: "DELETE" },
        );
        if (res.ok) okCount++;
        else failCount++;
      } catch {
        failCount++;
      }
    }
    if (failCount === 0) {
      toast.success(`已刪除 ${okCount} 則訊息`);
    } else {
      toast.error(`刪除完成 ${okCount} / ${okCount + failCount} 則,${failCount} 則失敗`);
    }
    setSelectionMode(false);
  }

  // P2 靜音切換 — 簡化版「8 小時」/「取消」二選一(MVP)。日後想加 dropdown 選
  // 持續時間再擴展。樂觀更新 + 失敗 toast。
  const handleToggleMute = useCallback(
    async (g: Group) => {
      const isMuted = !!(g.notificationsMutedUntil && new Date(g.notificationsMutedUntil) > new Date());
      const willMute = !isMuted;
      const optimistic = willMute
        ? new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString()
        : null;
      setGroups((prev) =>
        prev.map((x) =>
          x.id === g.id ? { ...x, notificationsMutedUntil: optimistic } : x,
        ),
      );
      try {
        const res = await fetch(
          `/api/workspaces/${workspaceId}/conversations/${g.id}`,
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ mute: willMute ? "8h" : false }),
          },
        );
        if (!res.ok) throw new Error("更新失敗");
        toast.success(willMute ? "已靜音 8 小時" : "已恢復通知");
      } catch {
        setGroups((prev) =>
          prev.map((x) =>
            x.id === g.id ? { ...x, notificationsMutedUntil: g.notificationsMutedUntil ?? null } : x,
          ),
        );
        toast.error("靜音切換失敗");
      }
    },
    [workspaceId, toast],
  );

  // 批量釘選對話 — 選取模式 + 多選 + 一次 batch PATCH。
  const [pinSelectMode, setPinSelectMode] = useState(false);
  const [selectedConvIds, setSelectedConvIds] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (!pinSelectMode) setSelectedConvIds(new Set());
  }, [pinSelectMode]);
  const toggleConvSelect = useCallback((id: string) => {
    setSelectedConvIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // P1 釘選對話到頂:PATCH conversations endpoint + 樂觀更新 groups state。
  // 失敗時 toast.error + 重 fetch groups (rollback)。
  const handleTogglePin = useCallback(
    async (g: Group) => {
      const willPin = !g.conversationPinnedAt;
      const optimisticTs = willPin ? new Date().toISOString() : null;
      setGroups((prev) =>
        prev.map((x) =>
          x.id === g.id ? { ...x, conversationPinnedAt: optimisticTs } : x,
        ),
      );
      try {
        const res = await fetch(
          `/api/workspaces/${workspaceId}/conversations/${g.id}`,
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ pin: willPin }),
          },
        );
        if (!res.ok) {
          throw new Error("更新失敗");
        }
        // 重 fetch groups 讓 server-side sort 立刻生效 (pinned 順序排到上面)
        const reload = await fetch(
          `/api/workspaces/${workspaceId}/groups?includePreview=true`,
        );
        if (reload.ok) {
          const data = await reload.json();
          replaceGroups(Array.isArray(data.groups) ? data.groups : []);
        }
      } catch {
        // 失敗 → rollback 樂觀更新
        setGroups((prev) =>
          prev.map((x) =>
            x.id === g.id ? { ...x, conversationPinnedAt: g.conversationPinnedAt ?? null } : x,
          ),
        );
      }
    },
    [replaceGroups, workspaceId],
  );

  // 批量釘選 / 取消釘選選取的對話。樂觀更新 + 重抓 groups 套用 server-side 排序。
  const batchPin = useCallback(
    async (pin: boolean) => {
      const ids = Array.from(selectedConvIds);
      if (ids.length === 0) return;
      const idSet = new Set(ids);
      const optimisticTs = pin ? new Date().toISOString() : null;
      setGroups((prev) =>
        prev.map((x) => (idSet.has(x.id) ? { ...x, conversationPinnedAt: optimisticTs } : x)),
      );
      const reloadGroups = async () => {
        const reload = await fetch(
          `/api/workspaces/${workspaceId}/groups?includePreview=true`,
        );
        if (reload.ok) {
          const data = await reload.json();
          replaceGroups(Array.isArray(data.groups) ? data.groups : []);
        }
      };
      try {
        const res = await fetch(
          `/api/workspaces/${workspaceId}/conversations/batch`,
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ groupIds: ids, pin }),
          },
        );
        if (!res.ok) throw new Error("批量釘選失敗");
        // 後端只更新使用者可見的對話;若有不可見的 id,updated < 送出數,如實提示。
        const data = (await res.json().catch(() => ({}))) as { updated?: number };
        const done = typeof data.updated === "number" ? data.updated : ids.length;
        await reloadGroups();
        setSelectedConvIds(new Set());
        setPinSelectMode(false);
        if (done < ids.length) {
          toast.success(
            pin
              ? `已釘選 ${done}/${ids.length} 個對話(部分無權限)`
              : `已取消釘選 ${done}/${ids.length} 個對話`,
          );
        } else {
          toast.success(
            pin ? `已釘選 ${ids.length} 個對話` : `已取消釘選 ${ids.length} 個對話`,
          );
        }
      } catch {
        await reloadGroups();
        toast.error("批量釘選失敗");
      }
    },
    [selectedConvIds, workspaceId, replaceGroups, toast],
  );

  // 訊息釘選(message pin)— 切換單則訊息的釘選狀態(釘到對話視窗頂端)。
  // Switchboard 內部標記,樂觀更新 + 呼叫 pin API;失敗 rollback。
  const handlePinMessage = useCallback(
    async (messageId: string) => {
      const cur = messagesRef.current.find((m) => m.id === messageId);
      const willPin = !cur?.pinnedAt;
      const ts = willPin ? new Date().toISOString() : null;
      setMessages((prev) => prev.map((m) => (m.id === messageId ? { ...m, pinnedAt: ts } : m)));
      try {
        const res = await fetch(
          `/api/workspaces/${workspaceId}/direct-chat/messages/pin`,
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ messageIds: [messageId], pin: willPin }),
          },
        );
        if (!res.ok) throw new Error("釘選失敗");
      } catch {
        setMessages((prev) =>
          prev.map((m) => (m.id === messageId ? { ...m, pinnedAt: cur?.pinnedAt ?? null } : m)),
        );
        toast.error("釘選失敗");
      }
    },
    [workspaceId, toast],
  );

  // 批量釘選 / 取消釘選選取的訊息(訊息多選模式的 toolbar 動作)。
  const handleBatchPinMessages = useCallback(
    async (pin: boolean) => {
      const ids = Array.from(selectedIds);
      if (ids.length === 0) return;
      const idSet = new Set(ids);
      const ts = pin ? new Date().toISOString() : null;
      const before = new Map(
        messagesRef.current.filter((m) => idSet.has(m.id)).map((m) => [m.id, m.pinnedAt ?? null]),
      );
      setMessages((prev) => prev.map((m) => (idSet.has(m.id) ? { ...m, pinnedAt: ts } : m)));
      try {
        const res = await fetch(
          `/api/workspaces/${workspaceId}/direct-chat/messages/pin`,
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ messageIds: ids, pin }),
          },
        );
        if (!res.ok) throw new Error("批量釘選失敗");
        const data = (await res.json().catch(() => ({}))) as { updated?: number };
        const done = typeof data.updated === "number" ? data.updated : ids.length;
        setSelectionMode(false);
        if (done < ids.length) {
          toast.success(
            pin
              ? `已釘選 ${done}/${ids.length} 則訊息(部分無權限)`
              : `已取消釘選 ${done}/${ids.length} 則訊息`,
          );
        } else {
          toast.success(
            pin ? `已釘選 ${ids.length} 則訊息` : `已取消釘選 ${ids.length} 則訊息`,
          );
        }
      } catch {
        setMessages((prev) =>
          prev.map((m) => (idSet.has(m.id) ? { ...m, pinnedAt: before.get(m.id) ?? null } : m)),
        );
        toast.error("批量釘選失敗");
      }
    },
    [selectedIds, workspaceId, toast],
  );

  // SSE for real-time incoming messages — also bumps sidebar preview so
  // the group list stays TG-style fresh (last message, time, re-sort).
  const onSSEMessage = useCallback(
    (event: { type: string; data?: Record<string, unknown> }) => {
      // 對話標籤更新：同步 sidebar list 的小標籤。
      if (event.type === "conversation:tags-updated" && event.data) {
        const eventGroupId = event.data.groupId as string | undefined;
        const tags = event.data.tags as string[] | undefined;
        const updatedAt = event.data.updatedAt as string | undefined;
        if (!eventGroupId || !Array.isArray(tags)) return;
        applyGroupTags(eventGroupId, tags, { updatedAt });
        return;
      }

      if (event.type === "group:discovered") {
        void refreshGroups();
        return;
      }

      if (event.type === "group:renamed" && event.data) {
        const eventGroupId = event.data.groupId as string | undefined;
        const newTitle = event.data.newTitle as string | undefined;
        if (!eventGroupId || !newTitle) return;
        const known = groupsRef.current.some((g) => g.id === eventGroupId);
        if (!known) {
          void refreshGroups();
          return;
        }
        setGroups((prev) => {
          const next = prev.map((g) =>
            g.id === eventGroupId ? { ...g, title: newTitle } : g,
          );
          groupsRef.current = next;
          groupsFingerprintRef.current = groupListFingerprint(next);
          return next;
        });
        return;
      }

      if (event.type === "call:incoming" && event.data) {
        const eventGroupId = event.data.groupId as string | undefined;
        const accountId = event.data.accountId as string | undefined;
        const gatewaySessionId = event.data.gatewaySessionId as string | undefined;
        const mode = event.data.mode === "video" ? "video" : "voice";
        if (!eventGroupId || !accountId || !gatewaySessionId) return;
        const g = groupsRef.current.find((item) => item.id === eventGroupId);
        if (!g || g.chatType !== "PRIVATE") return;
        setEmbeddedCall({
          groupId: g.id,
          title: g.customerName?.trim() || g.title,
          mode,
          direction: "incoming",
          accountId,
          gatewaySessionId,
        });
        return;
      }

      if (event.type === "call:updated" && event.data) {
        const eventGroupId = event.data.groupId as string | undefined;
        const state = event.data.state as string | undefined;
        if (!eventGroupId || !state) return;
        if (state === "ended") {
          setEmbeddedCall((current) =>
            current?.groupId === eventGroupId ? null : current,
          );
          return;
        }
        // 非終止狀態(dialing/ringing/accepted/connected)→ 餵給通話視窗顯示。
        setEmbeddedCall((current) =>
          current?.groupId === eventGroupId && current.remoteStateHint !== state
            ? { ...current, remoteStateHint: state }
            : current,
        );
        return;
      }

      // 處理 reaction 變更：找對應 platformMessageId 的訊息、把 reactions 蓋掉。
      if (event.type === "chat:reaction-changed" && event.data) {
        const eventGroupId = event.data.groupId as string | undefined;
        if (eventGroupId !== selectedGroupRef.current) return;
        const platformMessageId = event.data.platformMessageId as
          | string
          | undefined;
        const newReactions = event.data.reactions as
          | Array<{ emoji: string; count: number; chosen: boolean }>
          | undefined;
        if (!platformMessageId || !Array.isArray(newReactions)) return;
        setMessages((prev) =>
          prev.map((m) =>
            m.platformMessageId === platformMessageId
              ? { ...m, reactions: newReactions }
              : m,
          ),
        );
        return;
      }

      // 真實已讀回執 SSE 廣播 (2026-05-21 Backend-first):
      //   direction=outbox → 對方讀了我方訊息,把 OUTBOUND 訊息(id <= maxId)
      //   標 readAt + deliveredAt = at;UI bubble 變藍勾。
      //   direction=inbox  → 我方讀了對方訊息,把 INBOUND 訊息標 deliveredAt
      //   (這欄對 INBOUND 是「對方知道我已讀」的 timeline 標記;
      //   sidebar 未讀 badge 用 ConversationState 處理,不在此檔)。
      if (event.type === "message:read" && event.data) {
        const eventGroupId = event.data.groupId as string | undefined;
        if (eventGroupId !== selectedGroupRef.current) return;
        const direction = event.data.direction as "outbox" | "inbox" | undefined;
        const maxId = event.data.maxId as number | undefined;
        const at = (event.data.at as string | undefined) ?? new Date().toISOString();
        if (!direction || maxId == null) return;
        setMessages((prev) =>
          prev.map((m) => {
            // 沒 platformMessageId 的 optimistic / 未投遞訊息略過。
            const pidStr = m.platformMessageId;
            if (!pidStr) return m;
            const pid = Number(pidStr);
            if (!Number.isFinite(pid) || pid > maxId) return m;
            if (direction === "outbox" && m.direction === "outgoing") {
              return { ...m, deliveredAt: m.deliveredAt ?? at, readAt: at };
            }
            if (direction === "inbox" && m.direction === "incoming") {
              return { ...m, deliveredAt: m.deliveredAt ?? at };
            }
            return m;
          }),
        );
        return;
      }

      // 編輯廣播：同 group 內其他 viewer 即時看到內容變化 + 「已編輯」標記。
      if (event.type === "message:edited" && event.data) {
        const eventGroupId = event.data.groupId as string | undefined;
        if (eventGroupId !== selectedGroupRef.current) return;
        const messageId = event.data.messageId as string | undefined;
        const newContent = event.data.content as string | undefined;
        const editedAt = (event.data.editedAt as string | undefined) ?? new Date().toISOString();
        if (!messageId) return;
        // 2026-05-21 訊息按鈕:replyMarkup 在 event.data 裡時一併更新。
        //   undefined = 此次編輯沒帶按鈕資訊(保守不動);其他值(物件 / null)= 明確更新。
        const hasMarkup = "replyMarkup" in event.data;
        const newMarkup = event.data.replyMarkup as ChatMessage["replyMarkup"];
        setMessages((prev) =>
          prev.map((m) =>
            m.id === messageId
              ? {
                  ...m,
                  content: newContent ?? m.content,
                  editedAt,
                  ...(hasMarkup ? { replyMarkup: newMarkup ?? null } : {}),
                }
              : m,
          ),
        );
        return;
      }

      // 刪除廣播：soft=true 標 isDeleted（保留 row、淺色 + 刪除線渲染）；
      // soft=false 退回從列表移除（schema lag 期間 hard-delete 的 fallback）。
      if (event.type === "message:deleted" && event.data) {
        const eventGroupId = event.data.groupId as string | undefined;
        if (eventGroupId !== selectedGroupRef.current) return;
        const messageId = event.data.messageId as string | undefined;
        const soft = event.data.soft !== false; // 預設 soft（向前相容）
        const deletedAt = (event.data.deletedAt as string | undefined) ?? new Date().toISOString();
        if (!messageId) return;
        if (soft) {
          setMessages((prev) =>
            prev.map((m) => (m.id === messageId ? { ...m, isDeleted: true, deletedAt } : m)),
          );
        } else {
          setMessages((prev) => prev.filter((m) => m.id !== messageId));
        }
        return;
      }

      // 訊息釘選即時同步:其他同事在同一對話釘選/取消訊息時更新本機 pinnedAt。
      if (event.type === "message:pinned" && event.data) {
        const eventGroupId = event.data.groupId as string | undefined;
        if (eventGroupId !== selectedGroupRef.current) return;
        const ids = event.data.messageIds as string[] | undefined;
        const pinned = event.data.pinned as boolean | undefined;
        const pinnedAt = (event.data.pinnedAt as string | null | undefined) ?? null;
        if (!Array.isArray(ids)) return;
        const idSet = new Set(ids);
        setMessages((prev) =>
          prev.map((m) =>
            idSet.has(m.id)
              ? { ...m, pinnedAt: pinned ? pinnedAt ?? new Date().toISOString() : null }
              : m,
          ),
        );
        return;
      }

      if (event.type !== "chat:message" || !event.data) return;
      const data = event.data;
      const eventGroupId = data.groupId as string | undefined;
      if (!eventGroupId) return;
      const sseDirection = data.direction as string | undefined;
      const isOutgoing = sseDirection === "OUTBOUND";
      const knownGroup = groupsRef.current.some((g) => g.id === eventGroupId);
      const withMessagePreview = (items: Group[]) => {
        const idx = items.findIndex((g) => g.id === eventGroupId);
        if (idx < 0) return items;
        const g = items[idx];
        const updated: Group = {
          ...g,
          lastMessage: {
            content: (data.content as string) || "",
            timestamp: (data.receivedAt as string) || new Date().toISOString(),
            senderName: (data.senderName as string) || null,
            senderPlatformId: (data.senderPlatformId as string | undefined) ?? null,
            direction: isOutgoing ? "outgoing" : "incoming",
            messageType: (data.messageType as string) || "TEXT",
          },
        };
        const rest = items.filter((_, i) => i !== idx);
        return [updated, ...rest];
      };

      // Per-group unread 由 sidebar 統一管理寫到 sessionStorage —
      // 這裡不重複 +1（避免 double-count）。下方有 switchboard:unread-updated 監聽。

      // 1. Append to the open chat if this is that chat's group
      if (eventGroupId === selectedGroupRef.current) {
        const newMessage: ChatMessage = {
          id: (data.messageId as string) || `sse_${Date.now()}`,
          content: (data.content as string) || "",
          sender: (data.senderName as string) || "Unknown",
          senderPlatformId: (data.senderPlatformId as string | undefined) ?? null,
          timestamp: (data.receivedAt as string) || new Date().toISOString(),
          source: "bridge",
          direction: isOutgoing ? "outgoing" : "incoming",
          messageType: ((data.messageType as string) || "TEXT") as MessageType,
          status: isOutgoing ? "sent" : "received",
        };
        setMessages((prev) =>
          prev.some((m) => m.id === newMessage.id) ? prev : [...prev, newMessage],
        );
      }

      if (!knownGroup) {
        void refreshGroups().then((fetched) => {
          if (!fetched) return;
          const next = withMessagePreview(fetched);
          if (next !== fetched) replaceGroups(next);
        });
        return;
      }

      // 2. Always update the sidebar preview; bubble this group to top.
      setGroups((prev) => {
        const next = withMessagePreview(prev);
        if (next === prev) return prev;
        groupsRef.current = next;
        groupsFingerprintRef.current = groupListFingerprint(next);
        return next;
      });
    },
    [applyGroupTags, refreshGroups, replaceGroups],
  );

  const { connected } = useSSE({
    workspaceId,
    onMessage: onSSEMessage,
  });

  // Compute message stats from current session
  const messageStats = useMemo(() => {
    const sent = messages.filter((m) => m.direction === "outgoing").length;
    const received = messages.filter((m) => m.direction === "incoming").length;
    return { sent, failed: 0, pending: 0, received };
  }, [messages]);

  // Fetch groups
  useEffect(() => {
    async function fetchGroups() {
      try {
        const res = await fetch(
          `/api/workspaces/${workspaceId}/groups?includePreview=true`,
        );
        if (res.ok) {
          const data = await res.json();
          const fetched: Group[] = data.groups;
          replaceGroups(fetched);
          // 補抓 TG 預設自動觸發 — 頁面載入後對「DB 尚無訊息」的對話靜默補抓。
          // 最多 20 個、依序執行（不並發，避免 bridge rate limit）。
          // autoBackfillRunRef 確保每個 mount 只跑一次（refresh 不重跑）。
          if (!autoBackfillRunRef.current) {
            autoBackfillRunRef.current = true;
            const needBackfill = fetched
              .filter((g) => !g.lastMessage)
              .slice(0, 20);
            if (needBackfill.length > 0) {
              setAutoBackfillStatus(`正在補抓 ${needBackfill.length} 個對話...`);
              (async () => {
                let done = 0;
                let anyInserted = 0;
                for (const g of needBackfill) {
                  try {
                    const res = await fetch(
                      `/api/workspaces/${workspaceId}/groups/${g.id}/backfill`,
                      {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ limit: 50 }),
                      },
                    );
                    if (res.ok) {
                      const d = await res.json() as { inserted?: number };
                      anyInserted += d.inserted ?? 0;
                    }
                  } catch { /* bridge 離線 — 忽略，下次頁面載入自動重試 */ }
                  done++;
                  setAutoBackfillStatus(`補抓中 ${done}/${needBackfill.length}...`);
                }
                // 只有實際有插入才重新載群組清單，避免不必要的 refetch
                if (anyInserted > 0) {
                  try {
                    const r2 = await fetch(
                      `/api/workspaces/${workspaceId}/groups?includePreview=true`,
                    );
                    if (r2.ok) {
                      const d2 = await r2.json();
                      replaceGroups(Array.isArray(d2.groups) ? d2.groups : []);
                    }
                  } catch { /* ignore */ }
                }
                setAutoBackfillStatus(null);
              })();
            }
          }
        }
      } catch {
        // ignore
      } finally {
        setLoading(false);
      }
    }
    fetchGroups();
  }, [replaceGroups, workspaceId]);

  // SSE 是正常路徑；fingerprint polling 是補償路徑。若標籤事件跨 instance
  // 遺失、或其他地方改了 group metadata，左側列表最多 10 秒內會自我修正。
  useEffect(() => {
    let cancelled = false;
    const timer = setInterval(async () => {
      try {
        const res = await fetch(
          `/api/workspaces/${workspaceId}/groups?includePreview=true`,
        );
        if (!res.ok) return;
        const data = await res.json();
        const fetched: Group[] = Array.isArray(data.groups) ? data.groups : [];
        const nextFingerprint = groupListFingerprint(fetched);
        if (!cancelled && nextFingerprint !== groupsFingerprintRef.current) {
          replaceGroups(fetched);
        }
      } catch {
        // 補償輪詢失敗不打斷主要聊天流程；下一輪再修正。
      }
    }, 10_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [replaceGroups, workspaceId]);

  // Restore last-used account when group changes
  useEffect(() => {
    if (selectedGroup && workspaceId) {
      const lastAccount = getLastAccountForGroup(workspaceId, selectedGroup);
      if (lastAccount) {
        setSelectedAccount(lastAccount);
      }
    }
  }, [selectedGroup, workspaceId]);

  // Save account selection
  useEffect(() => {
    if (selectedGroup && selectedAccount && workspaceId) {
      saveLastAccountForGroup(workspaceId, selectedGroup, selectedAccount);
    }
  }, [selectedGroup, selectedAccount, workspaceId]);

  // 載入失敗時的錯誤訊息（用來顯示在 chat 區，避免默默空白）
  const [chatError, setChatError] = useState<string | null>(null);

  useEffect(() => {
    if (!selectedGroup) {
      setConversation(null);
      return;
    }
    let cancelled = false;
    fetch(`/api/workspaces/${workspaceId}/conversations/${selectedGroup}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!cancelled) setConversation(d?.conversation ?? null);
      })
      .catch(() => {
        if (!cancelled) setConversation(null);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedGroup, workspaceId]);

  // 這個 session 已自動 backfill 過的 group ids — 避免切回同一個空對話又

  // 不受此 ref 限制。
  const autoBackfilledGroupIds = useRef<Set<string>>(new Set());

  // Fetch chat history when group changes
  useEffect(() => {
    if (!selectedGroup) {
      setMessages([]);
      setChatError(null);
      return;
    }

    let cancelled = false;
    const groupAtStart = selectedGroup;

    // ① 先從快取還原（讓圖片立即重現，避免切回對話時閃白）
    const cached = msgCacheRef.current.get(groupAtStart);
    if (cached) {
      setMessages(cached.messages);
      setHasMore(cached.hasMore);
      setChatLoading(false);
      setChatError(null);
    }

    async function fetchChat() {
      // 有快取時靜默背景刷新；無快取才顯示 loading spinner
      if (!cached) {
        setChatLoading(true);
        setChatError(null);
      }
      try {
        const res = await fetch(
          `/api/workspaces/${workspaceId}/groups/${groupAtStart}/chat?limit=50`
        );
        if (cancelled) return;
        if (!res.ok) {
          const errBody = await res.json().catch(() => ({}));
          if (!cached) {
            setChatError(
              errBody.error
                ? `載入失敗：${errBody.error}（HTTP ${res.status}）`
                : `載入失敗（HTTP ${res.status}）`,
            );
          }
          return;
        }
        const data = await res.json();
        // API returns newest first, reverse for chronological display
        const fetched = (data.messages as ChatMessage[]).slice().reverse();
        setMessages(fetched);
        setHasMore(data.hasMore);
        // 更新快取（存 oldest-first，與 setMessages 一致）
        msgCacheRef.current.set(groupAtStart, { messages: fetched, hasMore: data.hasMore });

        // 自動補抓:第一次打開這個對話 + DB 完全沒紀錄 → 從 TG 拉最近 50 則進來
        // 沒鎖定到「TG 也是空的」case(那種 backfill 也不會插任何東西,no-op)。
        // 切到別的對話再切回來、或 reload page 後仍可能 trigger,但 dedup by
        // platformMessageId 保證不會重複插入。
        if (
          fetched.length === 0 &&
          !autoBackfilledGroupIds.current.has(groupAtStart)
        ) {
          autoBackfilledGroupIds.current.add(groupAtStart);
          await autoBackfillThenReload(groupAtStart);
        }
      } catch (err) {
        if (!cancelled) {
          setChatError(`網路錯誤：${err instanceof Error ? err.message : String(err)}`);
        }
      } finally {
        if (!cancelled) setChatLoading(false);
      }
    }

    async function autoBackfillThenReload(groupId: string) {
      try {
        const res = await fetch(
          `/api/workspaces/${workspaceId}/groups/${groupId}/backfill`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ limit: 50 }),
          },
        );
        // race guard:使用者可能在 backfill 進行中切到別的對話
        if (cancelled || groupId !== selectedGroup) return;
        if (!res.ok) return; // bridge 5xx/不可達 → silently ignore,使用者可手動補
        const data = await res.json();
        if (data.success === false) return; // 帳號未綁/TG 拒絕等可預期失敗 → 靜默
        if ((data.inserted ?? 0) === 0) return; // TG 端也是空的 → 沒新訊息

        const reload = await fetch(
          `/api/workspaces/${workspaceId}/groups/${groupId}/chat?limit=50`,
        );
        if (cancelled || groupId !== selectedGroup) return;
        if (!reload.ok) return;
        const reloaded = await reload.json();
        const fetched = reloaded.messages as ChatMessage[];
        setMessages(fetched.reverse());
        setHasMore(reloaded.hasMore);
      } catch {
        // ignore — 自動補抓不該打擾使用者,有需要再點手動補抓
      }
    }

    fetchChat();
    return () => {
      cancelled = true;
      // 切換對話時把當前 messages 存快取（SSE 後續插入的訊息也包含在內）
      if (messagesRef.current.length > 0) {
        msgCacheRef.current.set(groupAtStart, {
          messages: messagesRef.current,
          hasMore: hasMoreRef.current,
        });
      }
    };
  }, [workspaceId, selectedGroup]);

  // Auto-scroll handled by VirtualChatList.

  // P3 排程發送 — 非 null = 此次 send 是排程模式;送出後自動清回 null。
  const [scheduleAt, setScheduleAt] = useState<string | null>(null);

  // 2026-05-21 Round 4:Forum topic filter — null = 全部(預設);number = 只顯示該 topic 訊息。
  // 切換 group 自動 reset(下面 useEffect)。topic = TG forum supergroup 的子討論串,
  // 員工關心特定一個 topic 時開,避免被其他 topic 噪音淹沒。
  const [selectedTopicId, setSelectedTopicId] = useState<number | null>(null);
  useEffect(() => {
    setSelectedTopicId(null);
  }, [selectedGroup]);

  // 取出當前 messages 中出現過的 topic id 清單(asc 排序)— 給 UI 渲染 topic chip row。
  // 沒任何 topicId 的訊息 → chip row 不顯示。
  const availableTopicIds = useMemo(() => {
    const ids = new Set<number>();
    for (const m of messages) {
      if (typeof m.topicId === "number" && m.topicId > 0) ids.add(m.topicId);
    }
    return Array.from(ids).sort((a, b) => a - b);
  }, [messages]);

  // 套上 topic filter 後的 messages(餵給 DirectChatList)。
  // null = 不過濾,直接傳原陣列(memo 失效次數 cheap)。
  const visibleMessages = useMemo(() => {
    if (selectedTopicId == null) return messages;
    return messages.filter((m) => m.topicId === selectedTopicId);
  }, [messages, selectedTopicId]);

  const activeGroup = useMemo(
    () => groups.find((g) => g.id === selectedGroup) ?? null,
    [groups, selectedGroup],
  );

  const handleGroupTagsUpdated = useCallback(
    (groupId: string, tags: string[], meta?: { updatedAt?: string }) => {
      applyGroupTags(groupId, tags, meta);
    },
    [applyGroupTags],
  );

  async function handleTelegramAdminAction(
    action:
      | { kind: "dialog-pin"; chatId: string; pinned: boolean }
      | { kind: "channel-title"; chatId: string; title: string },
  ) {
    if (!selectedAccount) return;
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/telegram-admin-action`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId: selectedAccount, action }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error || "Telegram 管理操作失敗");
        return;
      }
      if (action.kind === "dialog-pin") {
        setGroups((prev) =>
          prev.map((g) =>
            g.platformGroupId === action.chatId
              ? { ...g, conversationPinnedAt: action.pinned ? new Date().toISOString() : null }
              : g,
          ),
        );
      } else if (action.kind === "channel-title") {
        setGroups((prev) =>
          prev.map((g) =>
            g.platformGroupId === action.chatId ? { ...g, title: action.title } : g,
          ),
        );
      }
      toast.success("Telegram 管理操作已送出");
    } catch {
      toast.error("Telegram 管理操作無法連線");
    }
  }

  // 2026-05-21 QuickReply `/` autocomplete:三件套
  //   - shortcutOpen:popover 是否顯示
  //   - shortcutFilter:目前 / 後面跟著的 prefix 字串
  //   - shortcutRange:[start, end) 在 input 中對應的整個 token(/xxx),供後續替換
  // textareaRef + autocompleteRef:keyboard 導覽(textarea onKeyDown 委派給 popover)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const autocompleteRef = useRef<QuickReplyAutocompleteHandle | null>(null);
  const [shortcutOpen, setShortcutOpen] = useState(false);
  const [shortcutFilter, setShortcutFilter] = useState("");
  const [shortcutRange, setShortcutRange] = useState<{ start: number; end: number } | null>(null);

  /**
   * 偵測「游標目前所在的 token 是否為 /xxx」。
   * 規則:從游標往前掃,遇到 / → token 起點;遇到空白 / 換行 → 不是 token;
   *      遇到 string 開頭 → / 起點需要是 position 0 才算。
   * token 終點 = 游標位置(也包含游標之後到下一個空白前的字 — TG 慣例只在游標處 trigger)。
   * 對應行為:輸入 `/he` 後游標在 e 後面 → open + filter="he"。
   */
  const detectShortcutToken = (
    text: string,
    cursor: number,
  ): { filter: string; start: number; end: number } | null => {
    if (cursor <= 0 || cursor > text.length) return null;
    let i = cursor - 1;
    while (i >= 0) {
      const ch = text[i];
      if (ch === "/") {
        // 起點規則:/ 必須在開頭、或前一個字元是空白/換行(避免抓到 URL 內的 /)
        const prevCh = i > 0 ? text[i - 1] : "";
        if (i === 0 || prevCh === " " || prevCh === "\n" || prevCh === "\t") {
          // 終點 = 游標處,但若游標後還有非空白字繼續到下一個空白為止
          let end = cursor;
          while (end < text.length && /[^\s]/.test(text[end])) end++;
          const token = text.slice(i + 1, end);
          // shortcut 不含空白,且不該太長(過長代表使用者只是寫 URL/path)
          if (/^[\w一-鿿㐀-䶿-]{0,32}$/.test(token)) {
            return { filter: token, start: i, end };
          }
          return null;
        }
        return null;
      }
      if (ch === " " || ch === "\n" || ch === "\t") return null;
      i--;
    }
    return null;
  };

  /** input 改動時呼叫 — 重新計算 / token,決定 popover 開關。 */
  const updateShortcutState = (newText: string, cursor: number) => {
    const detected = detectShortcutToken(newText, cursor);
    if (detected) {
      setShortcutFilter(detected.filter);
      setShortcutRange({ start: detected.start, end: detected.end });
      setShortcutOpen(true);
    } else if (shortcutOpen) {
      setShortcutOpen(false);
      setShortcutRange(null);
    }
  };

  const closeShortcutAutocomplete = useCallback(() => {
    setShortcutOpen(false);
    setShortcutRange(null);
    setShortcutFilter("");
  }, []);

  /** Insert text into the composer, replacing the current selection or a supplied range. */
  const insertComposerText = useCallback(
    (text: string, range?: { start: number; end: number }) => {
      const ta = textareaRef.current;
      if (!ta) {
        setInput((prev) => prev + text);
        return;
      }
      const start = range?.start ?? ta.selectionStart ?? input.length;
      const end = range?.end ?? ta.selectionEnd ?? input.length;
      const next = input.slice(0, start) + text + input.slice(end);
      setInput(next);
      requestAnimationFrame(() => {
        const ta2 = textareaRef.current;
        if (!ta2) return;
        const caret = start + text.length;
        ta2.focus();
        ta2.setSelectionRange(caret, caret);
        ta2.style.height = "auto";
        ta2.style.height = Math.min(ta2.scrollHeight, 120) + "px";
      });
    },
    [input],
  );

  /** 在 textarea 游標位置插入文字（emoji / quick reply picker 共用）。 */
  const insertAtCursor = useCallback(
    (text: string) => insertComposerText(text),
    [insertComposerText],
  );

  /** 傳送 TG 貼圖 */
  const handleSendSticker = async (sticker: StickerInfo) => {
    if (!selectedGroup || !selectedAccount) return;
    setStickerPickerOpen(false);
    try {
      await fetch(
        `/api/workspaces/${workspaceId}/groups/${selectedGroup}/send-sticker`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            accountId: selectedAccount,
            docId: sticker.id,
            accessHash: sticker.accessHash,
            fileReference: sticker.fileReference,
          }),
        },
      );
    } catch {
      // silent — SSE 會把送出的訊息推回來
    }
  };

  /**
   * 把 quick reply body 取代 `/xxx` token。
   * 使用 setRangeText 確保 React 控制的 textarea state 也同步;成功後 textarea 重新對焦,
   * 游標放在替換後內容尾端,popover 關閉。
   */
  const applyQuickReply = useCallback(
    (reply: QuickReply) => {
      if (!shortcutRange) return;
      insertComposerText(reply.body, shortcutRange);
      closeShortcutAutocomplete();
    },
    [closeShortcutAutocomplete, insertComposerText, shortcutRange],
  );

  const applyQuickReplyFromPicker = useCallback(
    (reply: QuickReply) => {
      insertComposerText(reply.body);
      setQuickReplyPickerOpen(false);
      closeShortcutAutocomplete();
    },
    [closeShortcutAutocomplete, insertComposerText],
  );

  const nativeMessageDraft = (payload: OutboundNativePayload): Pick<ChatMessage, "content" | "messageType" | "mediaMetadata"> => {
    switch (payload.kind) {
      case "story":
        return { content: "📖 Telegram Story", messageType: "STORY", mediaMetadata: { story: { peerId: payload.peerId, storyId: payload.storyId, expired: false } } };
    }
  };

  const buildOptimisticSender = () => {
    const tgName = groups
      .find((g) => g.id === selectedGroup)
      ?.accountMemberships.find((m) => m.account.id === selectedAccount)
      ?.account.displayName ?? null;
    const opName = currentUserName || null;
    return tgName && opName ? `${tgName}(${opName})` : tgName ?? opName ?? "(我)";
  };

  const handleSendNative = async (payload: OutboundNativePayload): Promise<boolean> => {
    if (!selectedGroup || !selectedAccount || sending) return false;
    setSending(true);
    const tempId = `native_${Date.now()}`;
    const draft = nativeMessageDraft(payload);
    const replyRef = replyingTo;
    const scheduleAtSnapshot = scheduleAt;
    setReplyingTo(null);
    setReplyingQuote(null);
    setMessages((prev) => [
      ...prev,
      {
        id: tempId,
        ...draft,
        sender: buildOptimisticSender(),
        timestamp: new Date().toISOString(),
        source: "direct",
        direction: "outgoing",
        status: "sending",
        topicId: selectedTopicId,
      },
    ]);
    try {
      const replyToPlatformId = replyRef?.platformMessageId ?? null;
      const res = await fetch(`/api/workspaces/${workspaceId}/direct-chat/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          groupId: selectedGroup,
          accountId: selectedAccount,
          native: payload,
          ...(replyToPlatformId ? { replyToMessageId: replyToPlatformId } : {}),
          ...(scheduleAtSnapshot ? { scheduleDate: scheduleAtSnapshot } : {}),
          ...(selectedTopicId != null ? { topicId: selectedTopicId } : {}),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMessages((prev) => prev.map((m) => (m.id === tempId ? { ...m, status: "error" } : m)));
        toast.error(data.error || "原生訊息送出失敗");
        return false;
      }
      if (scheduleAtSnapshot) {
        setMessages((prev) => prev.filter((m) => m.id !== tempId));
        setScheduleAt(null);
        toast.success("原生訊息已排程");
        return true;
      }
      setMessages((prev) => prev.map((m) => m.id === tempId ? {
        ...m,
        id: data.messageId || tempId,
        platformMessageId: data.platformMessageId ?? m.platformMessageId ?? null,
        status: data.sent ? "sent" : "pending",
        content: data.content ?? m.content,
        messageType: data.messageType ?? m.messageType,
        mediaMetadata: data.mediaMetadata ?? m.mediaMetadata ?? null,
        topicId: data.topicId ?? m.topicId ?? null,
      } : m));
      if (!data.sent) {
        toast.warning("訊息已儲存，但暫時無法同步至 Telegram — 請確認 Bridge 服務運作正常。", { duration: 6000 });
      }
      return true;
    } catch {
      setMessages((prev) => prev.map((m) => (m.id === tempId ? { ...m, status: "error" } : m)));
      toast.error("網路錯誤，原生訊息送出失敗");
      return false;
    } finally {
      setSending(false);
    }
  };

  const handleSend = async () => {
    if (!input.trim() || !selectedGroup || !selectedAccount || sending) return;

    setSending(true);
    const messageContent = input.trim();
    setInput("");
    // Capture + clear the reply reference before the request so the UI
    // feels snappy; we'll re-populate it only if the send path chooses to
    // retry (not today).
    const replyRef = replyingTo;
    const quoteRef = replyingQuote;
    setReplyingTo(null);
    setReplyingQuote(null);
    // 拷貝 scheduleAt 後立刻清 UI state — 即使 send 失敗,避免「上次排程時間
    // 黏在下一次 send 上」。
    const scheduleAtSnapshot = scheduleAt;
    setScheduleAt(null);

    // Optimistically add the message — sender 對齊 server outbound 格式「TG帳號名(操作者)」
    const tgName = groups
      .find((g) => g.id === selectedGroup)
      ?.accountMemberships.find((m) => m.account.id === selectedAccount)
      ?.account.displayName ?? null;
    const opName = currentUserName || null;
    const optimisticSender =
      tgName && opName ? `${tgName}(${opName})` : tgName ?? opName ?? "(我)";
    const tempId = `temp_${Date.now()}`;
    // 排程訊息不要樂觀加到當前對話 — 訊息不會立刻出現,加了反而混亂。
    // 走純 server 路徑;成功後 toast 提示「已排程」。
    if (!scheduleAtSnapshot) {
      const optimisticMessage: ChatMessage = {
        id: tempId,
        content: messageContent,
        sender: optimisticSender,
        timestamp: new Date().toISOString(),
        source: "direct",
        direction: "outgoing",
        messageType: "TEXT",
        status: "sending",
        topicId: selectedTopicId,
      };
      setMessages((prev) => [...prev, optimisticMessage]);
    }

    try {
      // We pass the Telegram platformMessageId of the bubble the operator
      // swiped-to-reply against. The bridge route accepts an optional
      // `replyToMessageId` field; messages from our own DB expose that id
      // via ChatMessage.id (which for bridge messages *is* the DB id, not
      // the Telegram id). For MVP we leave the server to resolve DB id ->
      // platformMessageId if it wants to; the field is transmitted as-is.
      // 2026-05-21 修正:replyToMessageId 應該帶 TG platformMessageId(數字字串),
      // 不是 DCM cuid。bridge /send 端解析失敗會默默 drop reply,造成「點了 reply 沒效」。
      // 沒 platformMessageId 的 optimistic 訊息(本地 temp_xxx)不能當 reply 對象 — 自然 fallback null。
      const replyToPlatformId = replyRef?.platformMessageId ?? null;
      const res = await fetch(`/api/workspaces/${workspaceId}/direct-chat/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          groupId: selectedGroup,
          accountId: selectedAccount,
          content: messageContent,
          ...(replyToPlatformId ? { replyToMessageId: replyToPlatformId } : {}),
          // 2026-05-21 Quote-reply on send:帶引用片段 + 在原文的 offset。
          // 純文字 quote 即可,quoteEntities 暫不送(MVP)。
          ...(replyToPlatformId && quoteRef
            ? { quoteText: quoteRef.text, quoteOffset: quoteRef.offset }
            : {}),
          ...(scheduleAtSnapshot ? { scheduleDate: scheduleAtSnapshot } : {}),
        }),
      });

      if (res.ok) {
        const data = await res.json();
        if (scheduleAtSnapshot) {
          // 排程模式 — server 確認後彈 toast 告知時間,訊息不會出現在當前
          // chat 視窗(TG 端會在指定時間送出,屆時 SSE 推到 Switchboard 才出現)。
          const t = new Date(scheduleAtSnapshot);
          toast.success(
            `已排程在 ${t.toLocaleString("zh-TW", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false })} 送出`,
          );
        } else {
          // Reconcile optimistic message with server truth — id, sent state, AND
          // platformMessageId. Without the last bit, hover toolbar wouldn't show
          // the emoji button (条件: m.platformMessageId truthy) and edit/delete
          // would 502 with 「此訊息尚未成功送出至 Telegram」 even though TG had it.
          setMessages((prev) =>
            prev.map((m) =>
              m.id === tempId
                ? {
                    ...m,
                    id: data.messageId || tempId,
                    platformMessageId: data.platformMessageId ?? m.platformMessageId ?? null,
                    status: data.sent ? "sent" : "pending",
                  }
                : m,
            ),
          );
          // data.sent === false 代表後端已存進 DB，但 bridge 無法把訊息送到 TG。
          // 顯示一次性警告，讓員工知道對方在 Telegram 上不會看到這則訊息。
          if (!data.sent) {
            toast.warning("訊息已儲存，但暫時無法同步至 Telegram — 請確認 Bridge 服務運作正常。", {
              duration: 6000,
            });
          }
        }
      } else {
        const errBody = await res.json().catch(() => ({}));
        if (scheduleAtSnapshot) {
          // 排程失敗就 toast.error,沒有 optimistic message 要 reconcile
          toast.error(errBody.error || "排程失敗");
          // 失敗時把 input 還原給使用者重試
          setInput(messageContent);
          setScheduleAt(scheduleAtSnapshot);
        } else {
          setMessages((prev) =>
            prev.map((m) => (m.id === tempId ? { ...m, status: "error" } : m)),
          );
        }
      }
    } catch {
      if (scheduleAtSnapshot) {
        toast.error("無法連線到後端,請稍後再排程");
        setInput(messageContent);
        setScheduleAt(scheduleAtSnapshot);
      } else {
        setMessages((prev) =>
          prev.map((m) => (m.id === tempId ? { ...m, status: "error" } : m)),
        );
      }
    } finally {
      setSending(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // QuickReply popover 開啟時:吃掉 ↑↓ Enter Tab Esc;其他按鍵照常傳到 textarea
    // (這樣使用者繼續打字會更新 filter)。
    if (shortcutOpen) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        autocompleteRef.current?.move(1);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        autocompleteRef.current?.move(-1);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        closeShortcutAutocomplete();
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        // 中文 IME 期間第一個 Enter 留給輸入法,不要當作 popover confirm
        if (e.nativeEvent.isComposing || e.keyCode === 229) return;
        const sel = autocompleteRef.current?.selected();
        if (sel) {
          e.preventDefault();
          applyQuickReply(sel);
          return;
        }
        // 沒選到任何 item 仍照常 fallthrough(空 popover Enter = 送訊息)
      }
    }
    if (e.key !== "Enter" || e.shiftKey) return;
    // 中文 IME 期間第一次 Enter = 確認選字,不送訊息;選字結束後再 Enter
    // 才送出。瀏覽器在輸入法 composing 中會把 keydown 的 keyCode 設成
    // 229(legacy)或在 nativeEvent 標 isComposing=true。兩個都檢查避免
    // Chrome 某個 frame 漏判。
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    e.preventDefault();
    handleSend();
  };

  // FileUpload.onUploadComplete already uploaded the file via /api/upload
  // and returns metadata including `id` (MediaFile row id). We pass that
  // into /direct-chat/send which hands off to bridge /send-file — the
  // recipient sees a native Telegram attachment (with preview, download
  // button, etc.) rather than a text message with a URL in it.
  const handleFileUpload = async (file: {
    id: string;
    url: string;
    thumbnailUrl?: string;
    name: string;
    size: number;
    type: string;
  }) => {
    if (!selectedGroup || !selectedAccount) return;
    try {
      setSending(true);
      const caption = input.trim();

      const res = await fetch(`/api/workspaces/${workspaceId}/direct-chat/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          groupId: selectedGroup,
          accountId: selectedAccount,
          mediaFileId: file.id,
          ...(caption ? { content: caption } : {}),
          ...(selectedTopicId != null ? { topicId: selectedTopicId } : {}),
          ...(mediaMode !== "file" ? { mediaMode } : {}),
        }),
      });

      if (res.ok) {
        const data = await res.json();
        // sender 對齊 server outbound 格式「TG帳號名(操作者)」
        const tgName = groups
          .find((g) => g.id === selectedGroup)
          ?.accountMemberships.find((m) => m.account.id === selectedAccount)
          ?.account.displayName ?? null;
        const opName = currentUserName || null;
        const optimisticSender =
          tgName && opName ? `${tgName}(${opName})` : tgName ?? opName ?? "(我)";
        setMessages((prev) => [
          ...prev,
          {
            id: data.messageId || `file_${Date.now()}`,
            platformMessageId: data.platformMessageId ?? null,
            // Local optimistic content = caption text (if any)
            content: caption,
            sender: optimisticSender,
            timestamp: new Date().toISOString(),
            source: "direct",
            direction: "outgoing",
            messageType: data.messageType ?? (mediaMode === "voiceNote" ? "VOICE" : mediaMode === "videoNote" ? "VIDEO_NOTE" : inferMessageType(file.type)),
            status: data.sent ? "sent" : "pending",
            topicId: selectedTopicId,
            mediaUrl: file.url,
            mediaType: file.type,
            mediaFileName: file.name,
          },
        ]);
        if (caption) setInput("");
      }
      setShowFileUpload(false);
      setMediaMode("file");
    } catch {
      // ignore
    } finally {
      setSending(false);
    }
  };

  function inferMessageType(mime: string): MessageType {
    if (mime.startsWith("image/")) return "IMAGE";
    if (mime.startsWith("video/")) return "VIDEO";
    if (mime.startsWith("audio/")) return "AUDIO";
    return "DOCUMENT";
  }

  // Load more (older) messages
  const loadMore = async () => {
    if (!selectedGroup || !hasMore || chatLoading) return;
    const oldest = messages[0];
    if (!oldest) return;

    setChatLoading(true);
    try {
      const res = await fetch(
        `/api/workspaces/${workspaceId}/groups/${selectedGroup}/chat?limit=50&before=${oldest.id}`
      );
      if (res.ok) {
        const data = await res.json();
        const older = (data.messages as ChatMessage[]).reverse();
        setMessages((prev) => [...older, ...prev]);
        setHasMore(data.hasMore);
      }
    } catch {
      // ignore
    } finally {
      setChatLoading(false);
    }
  };

  // P1 搜尋:把更早歷史的 match 載到目前 messages 陣列中。loop loadMore 直到
  // targetDcmId 出現在 messages,有 cap 避免一路撈到 DB 開頭。loaded 後上層
  // 的 search effect 會自動 scrollToKey。
  // Wave 1 — 聯絡人操作(封鎖 / 解除封鎖 / 加為聯絡人)
  async function handleContactAction(action: "block" | "unblock" | "add") {
    if (!selectedGroup) return;
    const g = groups.find((x) => x.id === selectedGroup);
    if (!g) return;
    if (!selectedAccount) {
      toast.error("請先選擇一個發送帳號");
      return;
    }
    if (action === "block") {
      const ok = await confirm({
        message: `確定封鎖「${g.customerName || g.title}」?封鎖後將不再收到對方的訊息。`,
        confirmText: "封鎖",
        danger: true,
      });
      if (!ok) return;
    }
    try {
      const res = await fetch(
        `/api/workspaces/${workspaceId}/groups/${selectedGroup}/contact-action`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action, accountId: selectedAccount }),
        },
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error || "操作失敗");
        return;
      }
      toast.success(
        action === "block"
          ? "已封鎖此聯絡人"
          : action === "unblock"
            ? "已解除封鎖"
            : "已加為聯絡人",
      );
    } catch {
      toast.error("網路錯誤,操作失敗");
    }
  }

  async function handleCallIntent(mode: "voice" | "video") {
    if (!selectedGroup) return;
    const g = groups.find((x) => x.id === selectedGroup);
    if (!g) return;
    if (g.chatType !== "PRIVATE") {
      toast.info("通話目前只支援 1:1 私訊");
      return;
    }
    if (!selectedAccount) {
      toast.error("請先選擇一個 TG 發送身分");
      return;
    }
    setEmbeddedCall({
      groupId: g.id,
      title: g.customerName?.trim() || g.title,
      mode,
      direction: "outgoing",
      accountId: selectedAccount,
    });
  }

  // 補抓 TG 歷史 — 從 ⋮ 選單觸發;用 toast 通知結果,重刷訊息列表。
  const handleBackfill = useCallback(
    async (limit: number) => {
      if (!selectedGroup || backfillBusy) return;
      if (limit >= 200) {
        const ok = await confirm({
          message: "補抓最近 200 則可能需要較久，且可能觸發 Telegram 限流。確定要開始嗎？",
          confirmText: "開始補抓",
          danger: false,
        });
        if (!ok) return;
      }
      setBackfillBusy(true);
      try {
        const res = await fetch(
          `/api/workspaces/${workspaceId}/groups/${selectedGroup}/backfill`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ limit }),
          },
        );
        const data = await res.json().catch(() => ({}));
        // backfill 的「可預期失敗」(帳號未綁、TG 拒絕…)現在回 200 + success:false,
        // 只有真正的 bridge 5xx/不可達才是 !res.ok。兩者都要顯示失敗 toast。
        if (!res.ok || data.success === false) {
          toast.error(`補抓失敗：${data.error || res.status}`);
          return;
        }
        const mediaPart =
          (data.mediaStored ?? 0) > 0
            ? `，含媒體 ${data.mediaStored} 個`
            : "";
        const failedPart =
          (data.failed ?? 0) > 0 ? `；${data.failed} 則失敗` : "";
        toast.success(
          `已補抓 ${data.inserted ?? 0} 則新訊息${mediaPart}（跳過 ${data.skipped ?? 0} 重複）${failedPart}`,
        );
        // 補抓完重刷訊息列表
        const chatRes = await fetch(
          `/api/workspaces/${workspaceId}/groups/${selectedGroup}/chat?limit=50`,
        );
        if (chatRes.ok) {
          const d = await chatRes.json().catch(() => ({}));
          if (d?.messages) {
            setMessages((d.messages as ChatMessage[]).reverse());
            setHasMore(d.hasMore);
          }
        }
      } catch (err) {
        toast.error(
          `網路錯誤：${err instanceof Error ? err.message : String(err)}`,
        );
      } finally {
        setBackfillBusy(false);
      }
    },
    [workspaceId, selectedGroup, backfillBusy, toast, confirm],
  );

  // 清空對話紀錄 — 只清除目前畫面的訊息列表(不刪 DB)。
  const handleClearHistory = useCallback(async () => {
    const ok = await confirm({
      message: "只清空目前畫面上的對話紀錄；伺服器資料不會刪除，重新開啟此對話會再次載入。",
      confirmText: "清空",
      danger: false,
    });
    if (!ok) return;
    setMessages([]);
    setHasMore(false);
    setMoreMenuOpen(false);
    toast.success("已清空本地對話紀錄");
  }, [confirm, toast]);

  // 刪除對話 — soft/hard delete group，刪後返回對話清單
  const handleDeleteConversation = useCallback(async () => {
    if (!selectedGroup) return;
    const g = groups.find((x) => x.id === selectedGroup);
    const name = g?.customerName?.trim() || g?.title || "此對話";
    const ok = await confirm({
      message: `確定刪除「${name}」？此對話會從直面對話列表移除；既有訊息紀錄仍會保留在系統歷史與稽核中，之後可由管理員重新同步或還原。`,
      confirmText: "刪除",
      danger: true,
    });
    if (!ok) return;
    try {
      const res = await fetch(
        `/api/workspaces/${workspaceId}/groups/${selectedGroup}`,
        { method: "DELETE" },
      );
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        toast.error(d.error || "刪除失敗");
        return;
      }
      setGroups((prev) => prev.filter((x) => x.id !== selectedGroup));
      setSelectedGroup("");
      setMessages([]);
      setMoreMenuOpen(false);
      toast.success("對話已刪除");
    } catch {
      toast.error("網路錯誤，刪除失敗");
    }
  }, [selectedGroup, groups, workspaceId, confirm, toast]);

  // Wave 1 — 跳到指定日期:解析日期 → DCM id → loadUntilMatch 捲過去
  async function handleGoToDate(dateStr: string) {
    if (!dateStr || !selectedGroup) return;
    try {
      const res = await fetch(
        `/api/workspaces/${workspaceId}/groups/${selectedGroup}/chat/at-date?date=${encodeURIComponent(dateStr)}`,
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error || "無法跳到該日期");
        return;
      }
      if (!data.messageId) {
        toast.info("該日期之後沒有對話訊息");
        return;
      }
      await loadUntilMatch(data.messageId);
    } catch {
      toast.error("網路錯誤,無法跳到該日期");
    }
  }

  async function loadUntilMatch(targetDcmId: string) {
    if (!selectedGroup) return;
    if (messages.find((m) => m.id === targetDcmId)) {
      // 已經在 view 裡,直接 scrollToKey
      virtuosoRef.current?.scrollToKey(targetDcmId, { align: "center" });
      return;
    }
    setLoadingUntilMatch(true);
    try {
      // 拉 cap = 10 batches × 50 = 500 則。對絕大多數實務情境足夠;極端歷史
      // 太長時告知使用者再手動「載入更多」。
      const MAX_BATCHES = 10;
      let oldestNow = messages[0]?.id;
      let stillMore = hasMore;
      for (let i = 0; i < MAX_BATCHES; i++) {
        if (!stillMore || !oldestNow) break;
        const res = await fetch(
          `/api/workspaces/${workspaceId}/groups/${selectedGroup}/chat?limit=50&before=${oldestNow}`,
        );
        if (!res.ok) break;
        const data = await res.json();
        const older = (data.messages as ChatMessage[]).reverse();
        if (older.length === 0) break;
        setMessages((prev) => [...older, ...prev]);
        stillMore = data.hasMore;
        oldestNow = older[0]?.id ?? oldestNow;
        if (older.find((m) => m.id === targetDcmId)) {
          // 找到了,結束
          break;
        }
      }
      setHasMore(stillMore);
      // 等下一個 render 把 DOM 跟 virtuoso item array 同步後再 scroll
      setTimeout(() => {
        virtuosoRef.current?.scrollToKey(targetDcmId, { align: "center" });
        setHighlightedMessageId(targetDcmId);
      }, 50);
    } finally {
      setLoadingUntilMatch(false);
    }
  }

  // Telegram 系統訊息(login code 通知等)的對話 title 永遠是「Telegram」、
  // 其它常見系統 bot 也走同個 senderPlatformId。預設藏掉,有需要可切回顯示。
  const SYSTEM_TITLES = new Set(["Telegram"]);
  const isSystemConvo = (title: string) => SYSTEM_TITLES.has(title.trim());

  // Filter groups by chatFilter + search + system-hide + TG folder
  const filteredGroups = groups
    .filter((g) => {
      if (chatFilter === "private" && g.chatType !== "PRIVATE") return false;
      if (chatFilter === "group" && g.chatType !== "GROUP" && g.chatType !== "CHANNEL")
        return false;
      if (hideSystemConvos && isSystemConvo(g.title)) return false;
      // P2: TG 原生資料夾 filter
      if (tgFolderGroupIdSet && !tgFolderGroupIdSet.has(g.id)) return false;
      if (
        groupSearch &&
        !g.title.toLowerCase().includes(groupSearch.toLowerCase()) &&
        !(g.customerName && g.customerName.toLowerCase().includes(groupSearch.toLowerCase()))
      ) {
        return false;
      }
      return true;
    })
    // 按最近活動倒序 — 沒 lastMessage 的對話 (從未交談過) 沉到最後
    .sort((a, b) => {
      const ta = a.lastMessage ? new Date(a.lastMessage.timestamp).getTime() : 0;
      const tb = b.lastMessage ? new Date(b.lastMessage.timestamp).getTime() : 0;
      return tb - ta;
    });

  // 搜尋模式：當 groupSearch 非空時，忽略 chatFilter，跨所有類型返回分類結果。
  // 讓用戶不必切換 tab 也能同時看到「私聊 N筆」和「群組 N筆」。
  const isSearchMode = groupSearch.trim().length >= 1;
  const searchBase = isSearchMode
    ? groups.filter((g) => {
        if (hideSystemConvos && isSystemConvo(g.title)) return false;
        if (tgFolderGroupIdSet && !tgFolderGroupIdSet.has(g.id)) return false;
        const q = groupSearch.toLowerCase();
        return (
          g.title.toLowerCase().includes(q) ||
          (g.customerName?.toLowerCase().includes(q) ?? false)
        );
      })
    : [];
  const searchPrivate = searchBase.filter((g) => g.chatType === "PRIVATE");
  const searchGroups = searchBase.filter(
    (g) => g.chatType === "GROUP" || g.chatType === "CHANNEL",
  );

  // 各類別計數(給 tab badge)
  const counts = {
    private: groups.filter((g) => g.chatType === "PRIVATE").length,
    group: groups.filter((g) => g.chatType === "GROUP" || g.chatType === "CHANNEL")
      .length,
    all: groups.length,
  };
  const systemHidden = groups.filter((g) => isSystemConvo(g.title)).length;

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-2 border-[var(--accent)] border-t-transparent"></div>
        <span className="ml-3 text-[var(--muted-foreground)]">載入中...</span>
      </div>
    );
  }

  return (
    <div className="h-[calc(100dvh-8rem)] flex flex-col bg-[var(--surface-canvas)] md:h-[calc(100dvh-4rem)]">
      {/* Telegram-style three-column layout:
          - Left (320px)  : account switcher + search + scrollable group list
          - Middle (flex) : chat tabs + messages + input
          - Right (256px) : real-time status panel (hidden below lg)

          Mobile (<lg): stack mode — 對話列表跟 chat 主體互斥顯示。沒選對話
          時顯示列表;選了對話顯示 chat + 上方「← 返回」鈕回到列表。避免
          兩欄並排在 <500px 擠到內容看不清楚。 */}
      <div className="flex-1 flex flex-col lg:flex-row gap-3 min-h-0">
        {/* ─── Left sidebar: group list ────────────────────────────── */}
        <aside
          className={cn(
            "lg:flex lg:w-80 flex-col rounded-lg border border-[var(--border-strong)]/70 bg-[var(--surface-panel)] min-h-0",
            selectedGroup ? "hidden" : "flex",
          )}
        >
          <div className="shrink-0 space-y-2 border-b border-[var(--border)] bg-[var(--surface-elevated)]/55 p-3">
            <AccountSwitcher
              workspaceId={workspaceId}
              selectedAccountId={selectedAccount}
              onAccountChange={setSelectedAccount}
              compact
            />
            {/* 篩選 tab：私聊 / 群組 / 全部,預設「私聊」+ P3「全部已讀」一鍵 */}
            <div className="flex items-center gap-1.5">
              <div className="flex flex-1 gap-1 rounded-md border border-[var(--border)] bg-[var(--surface-sidebar)] p-0.5">
                {(
                  [
                    { key: "private" as const, label: "私聊" },
                    { key: "group" as const, label: "群組" },
                    { key: "all" as const, label: "全部" },
                  ] satisfies { key: ChatFilter; label: string }[]
                ).map((t) => (
                  <button
                    key={t.key}
                    onClick={() => setChatFilter(t.key)}
                    className={`flex-1 rounded px-2 py-1 text-xs font-medium transition-colors ${
                      chatFilter === t.key
                        ? "bg-[var(--surface-elevated)] text-[var(--foreground)]"
                        : "text-[var(--muted-foreground)] hover:bg-[var(--surface-hover)] hover:text-[var(--foreground)]"
                    }`}
                  >
                    {t.label}
                    <span className="ml-1 text-[10px] text-[var(--muted-foreground)]">
                      {counts[t.key]}
                    </span>
                  </button>
                ))}
              </div>
              {/* P3 全部已讀 — 只在有未讀時出現,避免噪音 */}
              {Object.values(unreadByGroup).some((n) => n > 0) && (
                <button
                  type="button"
                  onClick={handleMarkAllRead}
                  className="shrink-0 rounded px-2 py-1 text-[11px] text-[var(--text-muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--foreground)]"
                  title="把所有直面對話標記為已讀"
                >
                  全部已讀
                </button>
              )}
              {/* 批量釘選 — 進入對話選取模式 */}
              <button
                type="button"
                onClick={() => setPinSelectMode((v) => !v)}
                className={cn(
                  "shrink-0 rounded p-1 transition-colors",
                  pinSelectMode
                    ? "bg-[var(--accent-bg)] text-[var(--accent)]"
                    : "text-[var(--text-muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--accent)]",
                )}
                title="批量釘選對話"
                aria-label="批量釘選對話"
              >
                <Pin className="size-3.5" />
              </button>
              {/* 群發按鈕 */}
              <button
                type="button"
                onClick={() => setBroadcastOpen(true)}
                className="shrink-0 rounded p-1 text-[var(--text-muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--accent)]"
                title="群發訊息"
              >
                <Radio className="size-3.5" />
              </button>
            </div>

            {/* 批量釘選選取列 — 選取模式時出現,顯示已選數量 + 釘選/取消/完成 */}
            {pinSelectMode && (
              <div className="flex items-center gap-1.5 rounded-md border border-[var(--accent)]/30 bg-[var(--accent-bg)] px-2 py-1.5">
                <span className="text-[11px] font-medium text-[var(--accent)]">
                  已選 {selectedConvIds.size}
                </span>
                <div className="ml-auto flex items-center gap-1">
                  <button
                    type="button"
                    disabled={selectedConvIds.size === 0}
                    onClick={() => void batchPin(true)}
                    className="rounded px-2 py-1 text-[11px] font-medium text-[var(--accent)] hover:bg-[var(--surface-hover)] disabled:opacity-40"
                  >
                    釘選
                  </button>
                  <button
                    type="button"
                    disabled={selectedConvIds.size === 0}
                    onClick={() => void batchPin(false)}
                    className="rounded px-2 py-1 text-[11px] font-medium text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] disabled:opacity-40"
                  >
                    取消釘選
                  </button>
                  <button
                    type="button"
                    onClick={() => setPinSelectMode(false)}
                    className="rounded px-2 py-1 text-[11px] text-[var(--text-muted)] hover:bg-[var(--surface-hover)]"
                  >
                    完成
                  </button>
                </div>
              </div>
            )}
            {/* 補抓進度提示 */}
            {autoBackfillStatus && (
              <div className="flex items-center gap-1.5 rounded-md border border-[var(--border)] bg-[var(--surface-sidebar)] px-2 py-1">
                <span className="size-2.5 animate-spin rounded-full border border-[var(--accent)] border-t-transparent" />
                <span className="text-[11px] text-[var(--text-muted)]">{autoBackfillStatus}</span>
              </div>
            )}

            {/* P2 TG 原生資料夾 quick chips — 員工已在 TG 客戶端建立的資料夾,
                同步過來作為 chat list 的快速 filter。一鍵切換。 */}
            {tgFolders.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => setSelectedTgFolderId(null)}
                  className={cn(
                    "rounded-full px-2 py-0.5 text-xs transition-colors",
                    selectedTgFolderId === null
                      ? "bg-[var(--accent)] text-[var(--primary-foreground)]"
                      : "bg-[var(--surface-input)] text-[var(--text-secondary)] hover:bg-[var(--surface-hover)]",
                  )}
                  title="不套用資料夾 filter"
                >
                  全部
                </button>
                {tgFolders.map((f) => (
                  <button
                    key={f.id}
                    type="button"
                    onClick={() =>
                      setSelectedTgFolderId(
                        selectedTgFolderId === f.id ? null : f.id,
                      )
                    }
                    className={cn(
                      "rounded-full px-2 py-0.5 text-xs transition-colors",
                      selectedTgFolderId === f.id
                        ? "bg-[var(--accent)] text-[var(--primary-foreground)]"
                        : "bg-[var(--surface-input)] text-[var(--text-secondary)] hover:bg-[var(--surface-hover)]",
                    )}
                    title={`${f.accountName} 的「${f.title}」資料夾 — ${f.groupIds.length} 個對話`}
                  >
                    {f.emoticon && <span className="mr-0.5">{f.emoticon}</span>}
                    {f.title}
                    <span className="ml-0.5 opacity-60">{f.groupIds.length}</span>
                  </button>
                ))}
                {/* 2026-05-21:資料夾每 5 分鐘由 bridge 自動同步。這個按鈕
                    降級成「緊急 / 即時」用 — 員工剛在 TG 改了不想等下一輪。 */}
                <button
                  type="button"
                  onClick={() => void handleTgFolderSync()}
                  disabled={tgFoldersSyncing}
                  className="rounded-full px-2 py-0.5 text-[10px] text-[var(--text-muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--foreground)] disabled:opacity-50"
                  title="資料夾每 5 分鐘自動同步;在 TG 端剛改完想立即更新可按此強制同步"
                >
                  {tgFoldersSyncing ? "同步中…" : "⟳ 立即同步"}
                </button>
              </div>
            )}

            <div className="flex items-center gap-2">
              <div className="relative flex-1">
                <input
                  type="text"
                  value={groupSearch}
                  onChange={(e) => setGroupSearch(e.target.value)}
                  placeholder="搜尋對話或訊息…"
                  className="w-full rounded-md border border-[var(--border-strong)]/70 bg-[var(--surface-input)] px-3 py-1.5 pr-8 text-sm outline-none focus:border-[var(--accent)] focus:ring-2 focus:ring-[var(--focus-ring)]"
                />
                {groupSearch && (
                  <button
                    onClick={() => setGroupSearch("")}
                    className="absolute right-1 top-1/2 -translate-y-1/2 p-1 text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
                    aria-label="清除搜尋"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
              {systemHidden > 0 && (
                <label
                  className="flex shrink-0 cursor-pointer items-center gap-1 whitespace-nowrap text-[11px] text-[var(--muted-foreground)] select-none"
                  title={`隱藏系統訊息對話（${systemHidden} 則）`}
                >
                  <input
                    type="checkbox"
                    checked={hideSystemConvos}
                    onChange={(e) => setHideSystemConvos(e.target.checked)}
                    className="size-3 cursor-pointer"
                  />
                  隱藏系統
                </label>
              )}
            </div>
          </div>
          <div className="flex-1 overflow-y-auto">
            {isSearchMode ? (
              /* ── 搜尋模式：TG-style 分類 tab strip + 對應內容 ────────── */
              <>
                {/* Tab strip */}
                <div className="flex shrink-0 overflow-x-auto border-b border-[var(--border)] scrollbar-none">
                  {(
                    [
                      { id: "chats",    label: "聊天室" },
                      { id: "messages", label: "訊息"   },
                      { id: "photo",    label: "照片"   },
                      { id: "video",    label: "影片"   },
                      { id: "file",     label: "檔案"   },
                    ] as { id: SearchTab; label: string }[]
                  ).map((tab) => (
                    <button
                      key={tab.id}
                      type="button"
                      onClick={() => setSearchTab(tab.id)}
                      className={cn(
                        "shrink-0 whitespace-nowrap px-3.5 py-2 text-[12px] font-medium border-b-2 -mb-px transition-colors",
                        searchTab === tab.id
                          ? "border-[var(--accent)] text-[var(--accent)]"
                          : "border-transparent text-[var(--text-muted)] hover:text-[var(--text-primary)]",
                      )}
                    >
                      {tab.label}
                    </button>
                  ))}
                </div>

                {/* ── 聊天室 tab ── */}
                {searchTab === "chats" && (
                  <>
                    <div className="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--text-muted)] bg-[var(--surface-sidebar)]/60 sticky top-0 z-10">
                      私聊{searchPrivate.length > 0 && <span className="ml-1 font-normal normal-case">({searchPrivate.length})</span>}
                    </div>
                    {searchPrivate.length === 0 ? (
                      <div className="px-4 py-3 text-[11px] text-[var(--text-muted)]">無符合的私訊對話</div>
                    ) : (
                      searchPrivate.map((g) => {
                        const fallback = (g.title?.trim()?.[0] ?? "?").toUpperCase();
                        return (
                          <ChatListItem
                            key={g.id}
                            workspaceId={workspaceId}
                            groupId={g.id}
                            platformGroupId={g.platformGroupId}
                            title={g.title}
                            initialsFallback={fallback}
                            subtitle={g.customerName || undefined}
                            lastMessage={g.lastMessage ?? null}
                            unreadCount={unreadByGroup[g.id] ?? 0}
                            isActive={selectedGroup === g.id}
                            onClick={() => setSelectedGroup(g.id)}
                            pinnedAt={g.conversationPinnedAt ?? null}
                            onTogglePin={() => handleTogglePin(g)}
                            mutedUntil={g.notificationsMutedUntil ?? null}
                            onToggleMute={menuConfig.showMute ? () => handleToggleMute(g) : undefined}
                            tags={g.tags}
                          />
                        );
                      })
                    )}
                    <div className="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--text-muted)] bg-[var(--surface-sidebar)]/60 sticky top-0 z-10 border-t border-[var(--border)] mt-0.5">
                      群組{searchGroups.length > 0 && <span className="ml-1 font-normal normal-case">({searchGroups.length})</span>}
                    </div>
                    {searchGroups.length === 0 ? (
                      <div className="px-4 py-3 text-[11px] text-[var(--text-muted)]">無符合的群組對話</div>
                    ) : (
                      searchGroups.map((g) => {
                        const fallback = (g.title?.trim()?.[0] ?? "?").toUpperCase();
                        return (
                          <ChatListItem
                            key={g.id}
                            workspaceId={workspaceId}
                            groupId={g.id}
                            platformGroupId={g.platformGroupId}
                            title={g.title}
                            initialsFallback={fallback}
                            subtitle={g.customerName || undefined}
                            lastMessage={g.lastMessage ?? null}
                            unreadCount={unreadByGroup[g.id] ?? 0}
                            isActive={selectedGroup === g.id}
                            onClick={() => setSelectedGroup(g.id)}
                            pinnedAt={g.conversationPinnedAt ?? null}
                            onTogglePin={() => handleTogglePin(g)}
                            mutedUntil={g.notificationsMutedUntil ?? null}
                            onToggleMute={menuConfig.showMute ? () => handleToggleMute(g) : undefined}
                            tags={g.tags}
                          />
                        );
                      })
                    )}
                  </>
                )}

                {/* ── 訊息 tab ── */}
                {searchTab === "messages" && (
                  <>
                    {groupSearch.trim().length < 2 ? (
                      <div className="px-4 py-6 text-center text-[11px] text-[var(--text-muted)]">
                        請輸入至少 2 個字元以搜尋訊息內容
                      </div>
                    ) : globalSearchLoading ? (
                      <div className="flex items-center justify-center gap-2 py-10 text-[11px] text-[var(--text-muted)]">
                        <span className="size-3.5 animate-spin rounded-full border border-current border-t-transparent" />
                        搜尋中…
                      </div>
                    ) : globalSearchResults.length === 0 ? (
                      <div className="px-4 py-6 text-center text-[11px] text-[var(--text-muted)]">
                        沒有訊息內容包含「{groupSearch.trim()}」
                      </div>
                    ) : (
                      globalSearchResults.map((m) => {
                        const ts = new Date(m.timestamp);
                        const isOutgoing = m.direction === "outgoing";
                        return (
                          <button
                            key={m.dcmId}
                            type="button"
                            onClick={() => {
                              setSelectedGroup(m.groupId);
                              setPendingScrollDcmId(m.dcmId);
                            }}
                            className="flex w-full flex-col items-start gap-0.5 border-b border-[var(--border)] px-3 py-2.5 text-left transition-colors last:border-0 hover:bg-[var(--surface-hover)]"
                          >
                            <div className="flex w-full items-baseline justify-between gap-2">
                              <span className="truncate text-[12px] font-medium text-[var(--text-primary)]">
                                {m.groupTitle}
                              </span>
                              <span className="shrink-0 text-[10px] text-[var(--text-muted)]">
                                {ts.toLocaleDateString("zh-TW", { month: "numeric", day: "numeric" })}
                              </span>
                            </div>
                            <div className="line-clamp-2 text-[11px] text-[var(--text-secondary)]">
                              <span className="font-medium">
                                {isOutgoing ? "你" : m.senderDisplayName ?? "對方"}:
                              </span>{" "}
                              {m.messageType === "TEXT" ? m.content : `[${m.messageType}] ${m.content || ""}`}
                            </div>
                          </button>
                        );
                      })
                    )}
                  </>
                )}

                {/* ── 照片 tab ── */}
                {searchTab === "photo" && (
                  mediaSearchLoading ? (
                    <div className="flex items-center justify-center gap-2 py-10 text-[11px] text-[var(--text-muted)]">
                      <span className="size-3.5 animate-spin rounded-full border border-current border-t-transparent" />
                      搜尋中…
                    </div>
                  ) : mediaSearchResults.length === 0 ? (
                    <div className="px-4 py-6 text-center text-[11px] text-[var(--text-muted)]">沒有照片</div>
                  ) : (
                    <div className="grid grid-cols-3 gap-0.5 p-0.5">
                      {mediaSearchResults.map((m) => (
                        <button
                          key={m.dcmId}
                          type="button"
                          onClick={() => { setSelectedGroup(m.groupId); setPendingScrollDcmId(m.dcmId); }}
                          className="group relative aspect-square overflow-hidden rounded bg-[var(--surface-sidebar)]"
                        >
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img
                            src={m.mediaUrl ?? ""}
                            alt={m.content || "照片"}
                            className="h-full w-full object-cover"
                            loading="lazy"
                          />
                          <div className="absolute inset-0 flex items-end bg-gradient-to-t from-black/60 to-transparent p-1 opacity-0 transition group-hover:opacity-100">
                            <span className="truncate text-[9px] text-white">{m.groupTitle}</span>
                          </div>
                        </button>
                      ))}
                    </div>
                  )
                )}

                {/* ── 影片 tab ── */}
                {searchTab === "video" && (
                  mediaSearchLoading ? (
                    <div className="flex items-center justify-center gap-2 py-10 text-[11px] text-[var(--text-muted)]">
                      <span className="size-3.5 animate-spin rounded-full border border-current border-t-transparent" />
                      搜尋中…
                    </div>
                  ) : mediaSearchResults.length === 0 ? (
                    <div className="px-4 py-6 text-center text-[11px] text-[var(--text-muted)]">沒有影片</div>
                  ) : (
                    <div className="grid grid-cols-3 gap-0.5 p-0.5">
                      {mediaSearchResults.map((m) => (
                        <button
                          key={m.dcmId}
                          type="button"
                          onClick={() => { setSelectedGroup(m.groupId); setPendingScrollDcmId(m.dcmId); }}
                          className="group relative aspect-square overflow-hidden rounded bg-[var(--surface-sidebar)] flex items-center justify-center"
                        >
                          <PlayCircle className="size-8 text-[var(--text-muted)] group-hover:text-[var(--accent)] transition-colors" />
                          <div className="absolute bottom-0 left-0 right-0 bg-[var(--inverse-chip-bg)] px-1 py-0.5">
                            <span className="truncate text-[9px] text-white block">
                              {m.mediaFileName || m.groupTitle}
                            </span>
                          </div>
                        </button>
                      ))}
                    </div>
                  )
                )}

                {/* ── 檔案 tab ── */}
                {searchTab === "file" && (
                  mediaSearchLoading ? (
                    <div className="flex items-center justify-center gap-2 py-10 text-[11px] text-[var(--text-muted)]">
                      <span className="size-3.5 animate-spin rounded-full border border-current border-t-transparent" />
                      搜尋中…
                    </div>
                  ) : mediaSearchResults.length === 0 ? (
                    <div className="px-4 py-6 text-center text-[11px] text-[var(--text-muted)]">沒有檔案</div>
                  ) : (
                    <div className="divide-y divide-[var(--border)]">
                      {mediaSearchResults.map((m) => {
                        const ts = new Date(m.timestamp);
                        return (
                          <button
                            key={m.dcmId}
                            type="button"
                            onClick={() => { setSelectedGroup(m.groupId); setPendingScrollDcmId(m.dcmId); }}
                            className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left transition-colors hover:bg-[var(--surface-hover)]"
                          >
                            <File className="size-7 shrink-0 text-[var(--accent)]" />
                            <div className="min-w-0 flex-1">
                              <div className="truncate text-[12px] font-medium text-[var(--text-primary)]">
                                {m.mediaFileName || "[檔案]"}
                              </div>
                              <div className="text-[10px] text-[var(--text-muted)]">
                                {m.groupTitle} · {ts.toLocaleDateString("zh-TW", { month: "numeric", day: "numeric" })}
                              </div>
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  )
                )}
              </>
            ) : filteredGroups.length === 0 ? (
              <div className="p-4 text-xs text-[var(--muted-foreground)]">
                {groupSearch ? (
                  "無匹配對話，請調整搜尋字詞或切換上方篩選。"
                ) : (
                  <div className="space-y-1.5 leading-relaxed">
                    <div className="font-medium text-[var(--foreground)]">目前沒有可處理的直面對話</div>
                    <div>可能原因：尚未收到客戶私訊、目前篩選只看私聊、或該對話仍在 Telegram 端等待首次同步。</div>
                    <div>若你剛確認客戶已來訊，可先到「群組管理」確認該私人對話是否已被自動登錄，再回來查看。</div>
                  </div>
                )}
              </div>
            ) : (
              <>
                {filteredGroups.map((g) => {
                  const fallback = (g.title?.trim()?.[0] ?? "?").toUpperCase();
                  return (
                    <ChatListItem
                      key={g.id}
                      workspaceId={workspaceId}
                      groupId={g.id}
                      platformGroupId={g.platformGroupId}
                      title={g.title}
                      initialsFallback={fallback}
                      // 2026-05-21:移除 broker 時代的「供應方/需求方/未分類」side 標籤 —
                      // 直面對話下每個對話就是對話,沒有供需分類。subtitle 只在有
                      // customerName(操作員手動備註的客戶名)時顯示。
                      subtitle={g.customerName || undefined}
                      lastMessage={g.lastMessage ?? null}
                      unreadCount={unreadByGroup[g.id] ?? 0}
                      isActive={selectedGroup === g.id}
                      onClick={() => setSelectedGroup(g.id)}
                      pinnedAt={g.conversationPinnedAt ?? null}
                      onTogglePin={() => handleTogglePin(g)}
                      mutedUntil={g.notificationsMutedUntil ?? null}
                      onToggleMute={menuConfig.showMute ? () => handleToggleMute(g) : undefined}
                      tags={g.tags}
                      selectionMode={pinSelectMode}
                      selected={selectedConvIds.has(g.id)}
                      onSelectToggle={() => toggleConvSelect(g.id)}
                    />
                  );
                })}

                {/* P2 全域搜尋結果 — 當 groupSearch ≥ 2 字時,顯示「訊息中也找到 N 筆」section。
                    結果排在群組清單下方,跟 TG sidebar 搜尋一致。 */}
                {groupSearch.trim().length >= 2 && (
                  <div className="border-t-2 border-[var(--border)]">
                    <div className="px-3 py-2 text-[10px] font-medium uppercase tracking-wide text-[var(--text-muted)] bg-[var(--surface-sidebar)]/60">
                      {globalSearchLoading
                        ? "搜尋訊息中…"
                        : `訊息中找到 ${globalSearchResults.length} 筆`}
                    </div>
                    {globalSearchResults.length === 0 && !globalSearchLoading && (
                      <div className="px-4 py-4 text-[11px] text-[var(--text-muted)]">
                        沒有訊息內容包含「{groupSearch.trim()}」
                      </div>
                    )}
                    {globalSearchResults.map((m) => {
                      const ts = new Date(m.timestamp);
                      const isOutgoing = m.direction === "outgoing";
                      return (
                        <button
                          key={m.dcmId}
                          type="button"
                          onClick={() => {
                            // 切到該 chat → useEffect 抓 history → pending scroll 跳轉
                            setSelectedGroup(m.groupId);
                            setPendingScrollDcmId(m.dcmId);
                          }}
                          className="flex w-full flex-col items-start gap-0.5 border-b border-[var(--border)] px-3 py-2.5 text-left transition-colors last:border-0 hover:bg-[var(--surface-hover)]"
                        >
                          <div className="flex w-full items-baseline justify-between gap-2">
                            <span className="truncate text-[12px] font-medium text-[var(--text-primary)]">
                              {m.groupTitle}
                            </span>
                            <span className="shrink-0 text-[10px] text-[var(--text-muted)]">
                              {ts.toLocaleDateString("zh-TW", {
                                month: "numeric",
                                day: "numeric",
                              })}
                            </span>
                          </div>
                          <div className="line-clamp-2 text-[11px] text-[var(--text-secondary)]">
                            <span className="font-medium">
                              {isOutgoing ? "你" : m.senderDisplayName ?? "對方"}:
                            </span>{" "}
                            {m.messageType === "TEXT"
                              ? m.content
                              : `[${m.messageType}] ${m.content || ""}`}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                )}
              </>
            )}
          </div>
        </aside>

        {/* ─── Middle column: chat ─────────────────────────────────── */}
        <div
          className={cn(
            "lg:flex flex-1 flex-col min-w-0 min-h-0 rounded-lg border border-[var(--border)] bg-[var(--surface-panel)] p-3",
            selectedGroup ? "flex" : "hidden lg:flex",
          )}
        >
          {/* 一欄式：合併「即時對話」+「歷史記錄」(原本兩個 tab 是重複的，
              即時對話 tab 已支援往上 scroll 載舊訊息 + chat bubble UI 完整、
              還支援編輯 / 刪除；歷史記錄反而漏撈 Message 表的訊息)。
              連線狀態 pill 上移到一個薄薄的標題列。 */}
          <div className="flex items-center justify-between border-b border-[var(--border)] pb-2 mb-3">
            {/* 2026-05-21 仿 TG:聊天 header 改成「對方頭像 + 名稱 + 副標」身分區,
                取代原本的靜態「對話」字樣。 */}
            <div className="flex min-w-0 items-center gap-2.5">
              {/* Mobile-only 返回鈕 — 點了清空 selectedGroup,回到對話列表頁 */}
              <button
                type="button"
                onClick={() => setSelectedGroup("")}
                className="lg:hidden -ml-1 rounded p-1 text-[var(--muted-foreground)] hover:bg-[var(--surface-hover)] hover:text-[var(--foreground)]"
                aria-label="返回對話列表"
              >
                <ChevronLeft className="w-4 h-4" />
              </button>
              {(() => {
                const g = groups.find((x) => x.id === selectedGroup);
                if (!selectedGroup || !g) {
                  return (
                    <span className="text-sm font-medium text-[var(--foreground)]">
                      直面對話
                    </span>
                  );
                }
                const hdrName = g.customerName?.trim() || g.title;
                const typeLabel =
                  g.chatType === "PRIVATE"
                    ? "私訊"
                    : g.chatType === "CHANNEL"
                      ? "頻道"
                      : "群組";
                return (
                  <button
                    type="button"
                    onClick={() => setInfoPanelOpen((v) => !v)}
                    title="查看對話資訊"
                    className="flex min-w-0 items-center gap-2.5 rounded-md px-1 py-0.5 text-left transition-colors hover:bg-[var(--surface-hover)]"
                  >
                    <ChatAvatar
                      name={hdrName}
                      seed={g.id || g.platformGroupId || hdrName}
                      src={
                        g.platformGroupId
                          ? `/api/workspaces/${workspaceId}/group-avatars/${encodeURIComponent(g.platformGroupId)}`
                          : null
                      }
                      size="md"
                    />
                    <div className="min-w-0">
                      <div
                        className="truncate text-sm font-medium text-[var(--foreground)]"
                        title={hdrName}
                      >
                        <bdi>{hdrName}</bdi>
                      </div>
                      <div className="flex items-center gap-1 text-xs text-[var(--muted-foreground)]">
                        <span
                          className={cn(
                            "size-1.5 rounded-full",
                            connected
                              ? "animate-pulse bg-green-500"
                              : "bg-[var(--muted-foreground)]/50",
                          )}
                        />
                        <span>{typeLabel}</span>
                        <span aria-hidden>·</span>
                        <span>{connected ? "即時連線" : "未連線"}</span>
                      </div>
                    </div>
                  </button>
                );
              })()}
            </div>
            {/* TG 風格 chat header 右側:搜尋 icon + ⋮ 三點選單(整合所有操作) */}
            {selectedGroup && (() => {
              const g = groups.find((x) => x.id === selectedGroup);
              const isMuted = !!(
                g?.notificationsMutedUntil &&
                new Date(g.notificationsMutedUntil) > new Date()
              );
              return (
                <div className="flex items-center gap-0.5">
                  {g?.chatType === "PRIVATE" && (
                    <>
                      <button
                        type="button"
                        onClick={() => void handleCallIntent("voice")}
                        className="rounded-full p-2 text-[var(--muted-foreground)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--foreground)]"
                        title="內嵌 Telegram 通話"
                        aria-label="內嵌 Telegram 通話"
                      >
                        <PhoneCall className="size-[18px]" />
                      </button>
                    </>
                  )}
                  {/* 搜尋 icon — 對應 TG 右上角放大鏡 */}
                  <button
                    type="button"
                    onClick={() => {
                      if (searchOpen) {
                        setSearchOpen(false);
                        setSearchQuery("");
                        setSearchMatchIdx(0);
                        setServerSearchMatches([]);
                      } else {
                        setSearchOpen(true);
                      }
                    }}
                    className={cn(
                      "rounded-full p-2 transition-colors",
                      searchOpen
                        ? "text-[var(--accent)] bg-[var(--accent-bg)]"
                        : "text-[var(--muted-foreground)] hover:text-[var(--foreground)] hover:bg-[var(--surface-hover)]",
                    )}
                    title={searchOpen ? "關閉搜尋" : "搜尋對話"}
                    aria-label="搜尋對話"
                  >
                    <Search className="size-[18px]" />
                  </button>

                  {/* ⋮ 三點選單 — 對應 TG 右上角 ··· */}
                  <div className="relative">
                    <button
                      type="button"
                      onClick={() => setMoreMenuOpen((v) => !v)}
                      className={cn(
                        "rounded-full p-2 transition-colors",
                        moreMenuOpen
                          ? "text-[var(--accent)] bg-[var(--accent-bg)]"
                          : "text-[var(--muted-foreground)] hover:text-[var(--foreground)] hover:bg-[var(--surface-hover)]",
                      )}
                      title="更多選項"
                      aria-label="更多選項"
                    >
                      <MoreVertical className="size-[18px]" />
                    </button>

                    {moreMenuOpen && (
                      <>
                        {/* 遮罩 */}
                        <div
                          className="fixed inset-0 z-10"
                          onClick={() => setMoreMenuOpen(false)}
                        />
                        {/* 下拉面板 — 結構對齊 Telegram Desktop 三點選單 */}
                        <div className="absolute right-0 top-full z-20 mt-1 w-52 overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--popover)] py-1 shadow-lg">

                          {/* ── 第一組:編輯 / 資訊 ── */}
                          <button
                            type="button"
                            onClick={() => { setInfoPanelOpen(true); setMoreMenuOpen(false); }}
                            className="flex w-full items-center gap-3 px-3 py-2.5 text-left text-sm transition-colors hover:bg-[var(--surface-hover)]"
                          >
                            <Pencil className="size-4 shrink-0 text-[var(--muted-foreground)]" />
                            查看 / 編輯資訊
                          </button>
                          <button
                            type="button"
                            onClick={() => { setInfoPanelOpen((v) => !v); setMoreMenuOpen(false); }}
                            className="flex w-full items-center gap-3 px-3 py-2.5 text-left text-sm transition-colors hover:bg-[var(--surface-hover)]"
                          >
                            <Info className="size-4 shrink-0 text-[var(--muted-foreground)]" />
                            資訊
                          </button>

                          <div className="my-1 border-t border-[var(--border)]" />

                          {/* ── 第二組:通知 / 選取 / 群組 ── */}
                          {menuConfig.showMute && (
                            <button
                              type="button"
                              onClick={() => { if (g) void handleToggleMute(g); setMoreMenuOpen(false); }}
                              className="flex w-full items-center gap-3 px-3 py-2.5 text-left text-sm transition-colors hover:bg-[var(--surface-hover)]"
                            >
                              {isMuted
                                ? <Bell className="size-4 shrink-0 text-[var(--muted-foreground)]" />
                                : <BellOff className="size-4 shrink-0 text-[var(--muted-foreground)]" />
                              }
                              {isMuted ? "開啟通知" : "關閉通知"}
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => { setSelectionMode((v) => !v); setMoreMenuOpen(false); }}
                            className={cn(
                              "flex w-full items-center gap-3 px-3 py-2.5 text-left text-sm transition-colors hover:bg-[var(--surface-hover)]",
                              selectionMode && "text-[var(--accent)]",
                            )}
                          >
                            <CheckSquare className={cn("size-4 shrink-0", selectionMode ? "text-[var(--accent)]" : "text-[var(--muted-foreground)]")} />
                            {selectionMode ? "退出選取" : "選取訊息"}
                          </button>
                          {/* 建立群組 — 即將推出 */}
                          <button
                            type="button"
                            disabled
                            title="即將推出"
                            className="flex w-full items-center gap-3 px-3 py-2.5 text-left text-sm opacity-40 cursor-not-allowed"
                          >
                            <Users className="size-4 shrink-0 text-[var(--muted-foreground)]" />
                            建立群組
                          </button>

                          {/* 成員清單 — GROUP / CHANNEL only */}
                          {g && g.chatType !== "PRIVATE" && (
                            <button
                              type="button"
                              onClick={() => { setShowMembersPanel(true); setMoreMenuOpen(false); }}
                              className="flex w-full items-center gap-3 px-3 py-2.5 text-left text-sm transition-colors hover:bg-[var(--surface-hover)]"
                            >
                              <Users className="size-4 shrink-0 text-[var(--muted-foreground)]" />
                              成員清單
                            </button>
                          )}

                          {/* PRIVATE 聯絡人操作 */}
                          {g && g.chatType === "PRIVATE" && (
                            <button
                              type="button"
                              onClick={() => { void handleContactAction("add"); setMoreMenuOpen(false); }}
                              className="flex w-full items-center gap-3 px-3 py-2.5 text-left text-sm transition-colors hover:bg-[var(--surface-hover)]"
                            >
                              <UserPlus className="size-4 shrink-0 text-[var(--muted-foreground)]" />
                              加為聯絡人
                            </button>
                          )}

                          {/* 補抓 TG 歷史 */}
                          <div className="my-1 border-t border-[var(--border)]" />
                          {backfillBusy ? (
                            <div className="flex items-center gap-3 px-3 py-2.5 text-sm text-[var(--muted-foreground)]">
                              <Loader2 className="size-4 animate-spin shrink-0" />
                              補抓中…
                            </div>
                          ) : (
                            <>
                              <div className="px-3 pb-0.5 pt-2 text-[10px] font-semibold uppercase tracking-widest text-[var(--muted-foreground)]">
                                補抓 TG 歷史
                              </div>
                              {([50, 100, 200] as const).map((n) => (
                                <button
                                  key={n}
                                  type="button"
                                onClick={() => { void handleBackfill(n); setMoreMenuOpen(false); }}
                                className="flex w-full items-center gap-3 px-3 py-2.5 text-left text-sm transition-colors hover:bg-[var(--surface-hover)]"
                                title={n >= 200 ? "可能需要較久，系統會先確認再開始" : "從 Telegram 補抓歷史訊息"}
                              >
                                  <History className="size-4 shrink-0 text-[var(--muted-foreground)]" />
                                  最近 {n} 則
                                </button>
                              ))}
                            </>
                          )}

                          <div className="my-1 border-t border-[var(--border)]" />

                          {/* ── 第三組:變更背景 / 封鎖 / 清空 / 刪除 ── */}
                          {/* 變更背景 — 即將推出 */}
                          <button
                            type="button"
                            disabled
                            title="即將推出"
                            className="flex w-full items-center gap-3 px-3 py-2.5 text-left text-sm opacity-40 cursor-not-allowed"
                          >
                            <Palette className="size-4 shrink-0 text-[var(--muted-foreground)]" />
                            變更背景
                          </button>
                          {/* 封鎖 / 解除封鎖 — PRIVATE only；兩項相鄰，封鎖在上 */}
                          {g && g.chatType === "PRIVATE" && (
                            <>
                              <button
                                type="button"
                                onClick={() => { void handleContactAction("block"); setMoreMenuOpen(false); }}
                                className="flex w-full items-center gap-3 px-3 py-2.5 text-left text-sm text-[var(--destructive)] transition-colors hover:bg-[var(--destructive)]/10"
                              >
                                <Ban className="size-4 shrink-0" />
                                封鎖
                              </button>
                              <button
                                type="button"
                                onClick={() => { void handleContactAction("unblock"); setMoreMenuOpen(false); }}
                                className="flex w-full items-center gap-3 px-3 py-2.5 text-left text-sm transition-colors hover:bg-[var(--surface-hover)]"
                              >
                                <UserCheck className="size-4 shrink-0 text-[var(--muted-foreground)]" />
                                解除封鎖
                              </button>
                            </>
                          )}
                          {/* 清空對話紀錄 — 由 ⚙ 選單設定決定是否顯示 */}
                          {menuConfig.showClear && (
                            <button
                              type="button"
                              onClick={() => void handleClearHistory()}
                              className="flex w-full items-center gap-3 px-3 py-2.5 text-left text-sm transition-colors hover:bg-[var(--surface-hover)]"
                            >
                              <Eraser className="size-4 shrink-0 text-[var(--muted-foreground)]" />
                              清空對話紀錄
                            </button>
                          )}
                          {/* 刪除對話 — 由 ⚙ 選單設定決定是否顯示 */}
                          {menuConfig.showDelete && (
                            <button
                              type="button"
                              onClick={() => void handleDeleteConversation()}
                              className="flex w-full items-center gap-3 px-3 py-2.5 text-left text-sm text-[var(--destructive)] transition-colors hover:bg-[var(--destructive)]/10"
                            >
                              <Trash2 className="size-4 shrink-0" />
                              刪除對話
                            </button>
                          )}

                          {/* ── ⚙ 選單設定（僅工作空間管理員可見）── */}
                          {canManage && (
                            <>
                              <div className="my-1 border-t border-[var(--border)]" />
                              <button
                                type="button"
                                onClick={() => setMenuSettingsOpen((v) => !v)}
                                className={cn(
                                  "flex w-full items-center gap-3 px-3 py-2.5 text-left text-xs transition-colors hover:bg-[var(--surface-hover)]",
                                  menuSettingsOpen
                                    ? "text-[var(--accent)]"
                                    : "text-[var(--muted-foreground)]",
                                )}
                              >
                                <svg viewBox="0 0 24 24" className="size-3.5 shrink-0" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
                                  <circle cx="12" cy="12" r="3" />
                                  <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
                                </svg>
                                選單設定
                                <svg viewBox="0 0 24 24" className={cn("ml-auto size-3 shrink-0 transition-transform", menuSettingsOpen && "rotate-180")} fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
                                  <polyline points="6 9 12 15 18 9" />
                                </svg>
                              </button>
                              {menuSettingsOpen && (
                                <div className="bg-[var(--surface-sidebar)] px-4 pb-3 pt-1 space-y-2">
                                  <p className="text-[10px] text-[var(--muted-foreground)] pb-1">
                                    預設關閉。開啟後該項目才會出現在選單中。
                                  </p>
                                  {(
                                    [
                                      { key: "showMute", label: "關閉通知" },
                                      { key: "showClear", label: "清空對話紀錄" },
                                      { key: "showDelete", label: "刪除對話" },
                                    ] as const
                                  ).map(({ key, label }) => (
                                    <label
                                      key={key}
                                      className="flex cursor-pointer items-center justify-between text-xs text-[var(--foreground)]"
                                    >
                                      {label}
                                      <button
                                        type="button"
                                        role="switch"
                                        aria-checked={menuConfig[key]}
                                        onClick={() => updateMenuConfig({ [key]: !menuConfig[key] })}
                                        className={cn(
                                          "relative inline-flex h-5 w-9 shrink-0 rounded-full border-2 border-transparent transition-colors",
                                          menuConfig[key]
                                            ? "bg-[var(--accent)]"
                                            : "bg-[var(--border)]",
                                        )}
                                      >
                                        <span
                                          className={cn(
                                            "pointer-events-none inline-block size-4 rounded-full bg-white shadow-sm transition-transform",
                                            menuConfig[key] ? "translate-x-4" : "translate-x-0",
                                          )}
                                        />
                                      </button>
                                    </label>
                                  ))}
                                </div>
                              )}
                            </>
                          )}
                        </div>
                      </>
                    )}
                  </div>
                </div>
              );
            })()}
          </div>

          {/* P1 對話搜尋列 — chat header 右上角放大鏡開啟,固定在 header 下方
              不隨訊息捲動。client-side filter + 上一筆/下一筆 + 命中數。 */}
          {searchOpen && selectedGroup && (
            <div className="mb-3 flex items-center gap-1.5">
              <div className="flex flex-1 items-center gap-1.5 rounded-md border border-[var(--border)] bg-[var(--surface-input)] px-2 py-1 max-w-md">
                <svg
                  viewBox="0 0 24 24"
                  className="size-3.5 shrink-0 text-[var(--muted-foreground)]"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden
                >
                  <circle cx="11" cy="11" r="8" />
                  <path d="m21 21-4.3-4.3" />
                </svg>
                <input
                  type="search"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") {
                      setSearchQuery("");
                      setSearchOpen(false);
                    }
                  }}
                  placeholder="在對話中搜尋…"
                  className="flex-1 min-w-0 bg-transparent text-xs outline-none placeholder:text-[var(--muted-foreground)]"
                  aria-label="在對話中搜尋"
                  autoFocus
                />
                {searchQuery && (
                  <button
                    type="button"
                    onClick={() => setSearchQuery("")}
                    className="text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
                    title="清除搜尋"
                    aria-label="清除搜尋"
                  >
                    <X className="size-3.5" />
                  </button>
                )}
              </div>
              <input
                type="date"
                onChange={(e) => {
                  if (e.target.value) void handleGoToDate(e.target.value);
                }}
                title="跳到指定日期的對話"
                aria-label="跳到指定日期"
                className="shrink-0 rounded-md border border-[var(--border)] bg-[var(--surface-input)] px-1.5 py-1 text-xs text-[var(--foreground)] outline-none"
              />
              {searchQuery && (
                <>
                  <span className="text-[11px] text-[var(--muted-foreground)] tabular-nums">
                    {searchMatches.length > 0
                      ? `${searchMatchIdx + 1} / ${searchMatches.length}`
                      : "0 筆"}
                  </span>
                  <button
                    type="button"
                    onClick={() =>
                      setSearchMatchIdx((idx) =>
                        searchMatches.length > 0
                          ? (idx - 1 + searchMatches.length) % searchMatches.length
                          : 0,
                      )
                    }
                    disabled={searchMatches.length === 0}
                    className="rounded p-1 text-[var(--muted-foreground)] hover:bg-[var(--surface-hover)] hover:text-[var(--foreground)] disabled:opacity-40"
                    title="上一個"
                    aria-label="上一個搜尋結果"
                  >
                    <ChevronLeft className="size-3.5 rotate-90" />
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      setSearchMatchIdx((idx) =>
                        searchMatches.length > 0
                          ? (idx + 1) % searchMatches.length
                          : 0,
                      )
                    }
                    disabled={searchMatches.length === 0}
                    className="rounded p-1 text-[var(--muted-foreground)] hover:bg-[var(--surface-hover)] hover:text-[var(--foreground)] disabled:opacity-40"
                    title="下一個"
                    aria-label="下一個搜尋結果"
                  >
                    <ChevronLeft className="size-3.5 -rotate-90" />
                  </button>
                </>
              )}
            </div>
          )}

          {/* 2026-05-21:精簡資訊條 — 直面對話為核心,移除「狀態 / 結案 / 持有人 /
              接手 / 釋出」整套案件管理。只保留對 CS 有用的「最近客戶來訊」。
              對話標題已顯示在左側清單,這裡不再重複。 */}
          {selectedGroup && conversation?.lastInboundAt && (
            <div className="mb-3 rounded-lg border border-[var(--border)] bg-[var(--card)] px-3 py-1.5 text-xs text-[var(--muted-foreground)]">
              最近客戶來訊：
              {new Date(conversation.lastInboundAt).toLocaleString("zh-TW", {
                month: "2-digit",
                day: "2-digit",
                hour: "2-digit",
                minute: "2-digit",
                hour12: false,
              })}
            </div>
          )}
          {activeGroup && selectedAccount && canManage && (
            <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--card)] px-3 py-2 text-xs text-[var(--muted-foreground)]">
              <span className="font-medium text-[var(--foreground)]">TG 管理</span>
              <button
                type="button"
                disabled={sending}
                onClick={() =>
                  void handleTelegramAdminAction({
                    kind: "dialog-pin",
                    chatId: activeGroup.platformGroupId,
                    pinned: !activeGroup.conversationPinnedAt,
                  })
                }
                className="rounded-md border border-[var(--border)] px-2 py-1 hover:bg-[var(--surface-hover)] disabled:cursor-not-allowed disabled:opacity-50"
                title="同步切換 Telegram 對話釘選狀態"
              >
                {activeGroup.conversationPinnedAt ? "取消 TG 釘選" : "TG 釘選對話"}
              </button>
              {activeGroup.chatType === "CHANNEL" && (
                <button
                  type="button"
                  disabled={sending}
                  onClick={() => {
                    const title = window.prompt("新的 Telegram 頻道標題", activeGroup.title);
                    if (!title || title.trim() === activeGroup.title) return;
                    void handleTelegramAdminAction({
                      kind: "channel-title",
                      chatId: activeGroup.platformGroupId,
                      title: title.trim(),
                    });
                  }}
                  className="rounded-md border border-[var(--border)] px-2 py-1 hover:bg-[var(--surface-hover)] disabled:cursor-not-allowed disabled:opacity-50"
                  title="透過 bridge 呼叫 channels.EditTitle（僅 Telegram channel）"
                >
                  改 TG 標題
                </button>
              )}
              <span className="text-[11px] text-[var(--text-muted)]">
                僅管理員可見；資料夾/釘選可反向同步，頻道標題僅支援 Telegram channel。
              </span>
            </div>
          )}
          <div className="flex-1 flex flex-col min-h-0">
            <div className="flex-1 flex flex-col min-h-0">
              {/* Chat messages — 顯示歷史只需要選 group；發訊息才需要選 account。
                  之前 condition 寫成 `selectedGroup && selectedAccount` 結果使用者
                  選了群組但還沒選帳號時整個歷史都被擋掉看不到。 */}
              <div className="flex-1 flex flex-col overflow-hidden border border-[var(--border-strong)]/60 rounded-lg bg-[var(--surface-elevated)] p-4 min-h-0">
                {selectedGroup ? (
                  <>

                    {/* P1 多選模式 bulk action toolbar — selection mode on 才顯示。
                        計數 + 批次轉發 / 刪除 / 退出。0 個選取時 actions disable。*/}
                    {selectionMode && (
                      <div className="mb-3 flex flex-wrap items-center gap-2 rounded-md border border-[var(--accent)]/30 bg-[var(--accent-bg)] px-3 py-2 text-xs">
                        <span className="text-[var(--text-secondary)]">
                          已選 <strong className="text-[var(--accent)]">{selectedIds.size}</strong> 則訊息
                        </span>
                        <div className="ml-auto flex flex-wrap gap-1.5">
                          <button
                            type="button"
                            disabled={selectedIds.size === 0 || forwardBusy}
                            onClick={() => setForwardingBatch(selectedMessages)}
                            className="rounded-md border border-[var(--border)] bg-[var(--surface-input)] px-2.5 py-1 hover:bg-[var(--surface-hover)] disabled:opacity-40"
                          >
                            轉發選取
                          </button>
                          <button
                            type="button"
                            disabled={selectedIds.size === 0}
                            onClick={() => void handleBatchPinMessages(true)}
                            className="rounded-md border border-[var(--border)] bg-[var(--surface-input)] px-2.5 py-1 hover:bg-[var(--surface-hover)] disabled:opacity-40"
                          >
                            釘選選取
                          </button>
                          <button
                            type="button"
                            disabled={selectedIds.size === 0}
                            onClick={() => void handleBatchPinMessages(false)}
                            className="rounded-md border border-[var(--border)] bg-[var(--surface-input)] px-2.5 py-1 text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] disabled:opacity-40"
                          >
                            取消釘選
                          </button>
                          <button
                            type="button"
                            disabled={
                              selectedIds.size === 0 ||
                              // 只有自己發的(outgoing + direct source)能刪 — 不然 API 也會 403
                              !selectedMessages.every(
                                (m) =>
                                  m.direction === "outgoing" &&
                                  m.source === "direct" &&
                                  !m.isDeleted &&
                                  !!m.platformMessageId,
                              )
                            }
                            onClick={() => void handleBulkDelete()}
                            className="rounded-md border border-[var(--destructive)]/30 bg-[var(--destructive)]/5 px-2.5 py-1 text-[var(--destructive)] hover:bg-[var(--destructive)]/10 disabled:opacity-40"
                            title={
                              selectedMessages.some((m) => m.direction !== "outgoing")
                                ? "只能刪除自己發出的訊息"
                                : "刪除所選"
                            }
                          >
                            刪除選取
                          </button>
                          <button
                            type="button"
                            onClick={() => setSelectionMode(false)}
                            className="rounded-md border border-[var(--border)] px-2.5 py-1 hover:bg-[var(--surface-hover)]"
                          >
                            取消
                          </button>
                        </div>
                      </div>
                    )}

                    {/* 頂端釘選面板(LINE 風格,單一層)— 合併「Telegram 端釘選」+
                        「我方釘選」,常駐顯示最新一則,多則可展開看全部、逐則跳轉/取消。 */}
                    {allPinned.length > 0 && (() => {
                      const head = allPinned[0];
                      const SourceTag = ({ s }: { s: "tg" | "cs" }) => (
                        <span
                          className={cn(
                            "shrink-0 rounded px-1 py-0.5 text-[9px] font-medium leading-none",
                            s === "tg"
                              ? "bg-[var(--surface-input)] text-[var(--text-muted)]"
                              : "bg-[var(--accent)]/15 text-[var(--accent)]",
                          )}
                        >
                          {s === "tg" ? "Telegram" : "我方"}
                        </span>
                      );
                      return (
                        <div className="mb-2 overflow-hidden rounded-md border-l-2 border-[var(--accent)] bg-[var(--accent-bg)] text-xs">
                          {/* header — 常駐顯示最新釘選 */}
                          <div className="flex items-center gap-2 px-3 py-2">
                            <Pin className="size-3.5 shrink-0 rotate-45 text-[var(--accent)]" aria-hidden />
                            <button
                              type="button"
                              onClick={() => head.msgId && jumpToMessage(head.msgId)}
                              disabled={!head.msgId}
                              className="min-w-0 flex-1 text-left disabled:cursor-default"
                              title={head.msgId ? "跳到這則釘選訊息" : "該訊息不在已載入歷史"}
                            >
                              <div className="font-medium text-[var(--accent)]">
                                釘選訊息{allPinned.length > 1 ? ` · 共 ${allPinned.length} 則` : ""}
                              </div>
                              <div className="flex min-w-0 items-center gap-1.5 overflow-hidden text-[var(--text-secondary)]">
                                <SourceTag s={head.source} />
                                <span className="min-w-0 truncate">
                                  {head.sender && (
                                    <span className="text-[var(--text-primary)]">{head.sender}: </span>
                                  )}
                                  {head.preview}
                                </span>
                              </div>
                            </button>
                            {allPinned.length > 1 && (
                              <button
                                type="button"
                                onClick={() => setPinPanelOpen((v) => !v)}
                                className="shrink-0 rounded p-1 text-[var(--accent)] hover:bg-[var(--surface-hover)]"
                                title={pinPanelOpen ? "收合釘選列表" : "展開所有釘選"}
                                aria-label={pinPanelOpen ? "收合釘選列表" : "展開所有釘選"}
                              >
                                {pinPanelOpen ? (
                                  <ChevronUp className="size-4" />
                                ) : (
                                  <ChevronDown className="size-4" />
                                )}
                              </button>
                            )}
                            {head.canUnpin && head.msgId && (
                              <button
                                type="button"
                                onClick={() => void handlePinMessage(head.msgId!)}
                                className="shrink-0 rounded p-1 text-[var(--text-muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--accent)]"
                                title="取消釘選這則"
                                aria-label="取消釘選這則"
                              >
                                <X className="size-3.5" />
                              </button>
                            )}
                          </div>
                          {/* 展開列表 — 所有釘選訊息,逐則跳轉/取消 */}
                          {pinPanelOpen && allPinned.length > 1 && (
                            <div className="max-h-52 overflow-y-auto border-t border-[var(--accent)]/20">
                              {allPinned.map((p) => (
                                <div
                                  key={p.key}
                                  className="flex items-center gap-2 border-b border-[var(--border)]/40 px-3 py-1.5 last:border-0 hover:bg-[var(--surface-hover)]"
                                >
                                  <button
                                    type="button"
                                    disabled={!p.msgId}
                                    onClick={() => {
                                      if (!p.msgId) return;
                                      jumpToMessage(p.msgId);
                                      setPinPanelOpen(false);
                                    }}
                                    className="flex min-w-0 flex-1 items-center gap-1.5 text-left text-[var(--text-secondary)] disabled:cursor-default"
                                    title={p.msgId ? "跳到這則" : "該訊息不在已載入歷史"}
                                  >
                                    <SourceTag s={p.source} />
                                    <span className="min-w-0 truncate">
                                      {p.sender && (
                                        <span className="text-[var(--text-primary)]">{p.sender}: </span>
                                      )}
                                      {p.preview}
                                    </span>
                                  </button>
                                  {p.canUnpin && p.msgId && (
                                    <button
                                      type="button"
                                      onClick={() => void handlePinMessage(p.msgId!)}
                                      className="shrink-0 rounded p-1 text-[var(--text-muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--accent)]"
                                      title="取消釘選"
                                      aria-label="取消釘選"
                                    >
                                      <PinOff className="size-3" />
                                    </button>
                                  )}
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      );
                    })()}

                    {/* P1 server-side 跨歷史搜尋的提示:目前未載入歷史中還有 N 筆。
                        按「載入往前找」會 loadMore loop 直到最舊的 match 進入視野。*/}
                    {(() => {
                      const localIds = new Set(messages.map((m) => m.id));
                      const extras = serverSearchMatches.filter(
                        (m) => !localIds.has(m.id),
                      );
                      if (extras.length === 0) return null;
                      // 排序由舊到新 — 最舊的 match 決定要 loadMore 到哪
                      const oldest = [...extras].sort((a, b) =>
                        a.timestamp.localeCompare(b.timestamp),
                      )[0];
                      return (
                        <div className="mb-3 flex items-center justify-between rounded-md border border-[var(--border)] bg-[var(--accent-bg)]/40 px-3 py-1.5 text-xs">
                          <span className="text-[var(--text-secondary)]">
                            更早歷史中還有 <strong>{extras.length}</strong> 筆命中
                            {hasMore ? "" : "（已到底)"}
                          </span>
                          <button
                            type="button"
                            disabled={loadingUntilMatch || !hasMore}
                            onClick={() => void loadUntilMatch(oldest.id)}
                            className="rounded px-2 py-0.5 text-[var(--accent)] hover:bg-[var(--accent-bg)] disabled:opacity-50"
                          >
                            {loadingUntilMatch ? "載入中…" : "載入往前找"}
                          </button>
                        </div>
                      );
                    })()}

                    {/* Load more button */}
                    {hasMore && (
                      <div className="text-center mb-4">
                        <button
                          onClick={loadMore}
                          disabled={chatLoading}
                          className="text-sm text-[var(--accent)] hover:text-[var(--accent-hover)] disabled:text-[var(--muted-foreground)]"
                        >
                          {chatLoading ? (
                            <span className="flex items-center justify-center gap-1">
                              <Loader2 className="w-3 h-3 animate-spin" />
                              載入中...
                            </span>
                          ) : (
                            "載入更多訊息"
                          )}
                        </button>
                      </div>
                    )}

                    {/* 訊息列表區 — 唯一的滾動容器(釘選面板/Load more 固定在其上方,
                        不隨訊息捲動消失;只有這裡有一條捲軸)。 */}
                    <div className="flex min-h-0 flex-1 flex-col">
                    {chatLoading && messages.length === 0 ? (
                      <div className="text-center text-[var(--muted-foreground)] mt-8">
                        <Loader2 className="w-8 h-8 mx-auto mb-4 animate-spin opacity-50" />
                        <p>載入對話記錄...</p>
                      </div>
                    ) : chatError ? (
                      <div className="mt-8 mx-auto max-w-md rounded-lg border border-[var(--destructive)]/30 bg-[var(--destructive)]/5 px-4 py-3 text-sm text-[var(--destructive)]">
                        <div className="font-medium mb-1">無法載入對話歷史</div>
                        <div className="text-xs leading-relaxed">{chatError}</div>
                        <div className="mt-2 text-xs text-[var(--muted-foreground)]">
                          常見原因：(1) 服務正在重新部署，請稍後再刷新；(2) 後端
                          schema 跟程式版本不同步 — 部署同事跑一下{" "}
                          <code className="px-1 rounded bg-[var(--muted)]">
                            railway run --service app npx prisma migrate deploy
                          </code>
                        </div>
                      </div>
                    ) : messages.length === 0 ? (
                      <div className="mt-8 text-center text-[var(--muted-foreground)]">
                        <Send className="mx-auto mb-4 h-12 w-12 opacity-30" />
                        <div className="space-y-1.5">
                          <p className="text-sm font-medium text-[var(--foreground)]">這個對話目前尚無已載入訊息</p>
                          <p className="text-xs leading-relaxed">
                            系統會先顯示資料庫裡已封存的訊息；若這是第一次打開，背景也會自動嘗試補抓 Telegram 最近歷史。
                          </p>
                          <p className="text-xs leading-relaxed">
                            如果你知道對方先前有傳訊，可以按右上角「⋮ → 補抓 TG 歷史」再檢查一次。
                          </p>
                        </div>
                      </div>
                    ) : (
                      // Use VirtualChatList for large histories; it also
                      // provides the scroll-to-latest FAB + unread counter.
                      <>
                        {/* 2026-05-21 Round 4:Forum topic filter chips。
                            僅當當前 group 的訊息包含 topic 才渲染(forum supergroups);
                            點 chip 過濾,點「全部」清除過濾。 */}
                        {availableTopicIds.length > 0 && (
                          <div className="flex flex-wrap gap-1 px-3 py-1.5 border-b border-[var(--border)] bg-[var(--surface-sidebar)]/55">
                            <span className="text-[10px] text-[var(--text-muted)] mr-1 self-center">
                              🧵 主題:
                            </span>
                            <button
                              type="button"
                              onClick={() => setSelectedTopicId(null)}
                              className={cn(
                                "rounded px-1.5 py-0.5 text-[11px]",
                                selectedTopicId == null
                                  ? "bg-[var(--primary)] text-[var(--primary-foreground)]"
                                  : "text-[var(--text-muted)] hover:bg-[var(--surface-hover)]",
                              )}
                            >
                              全部
                            </button>
                            {availableTopicIds.map((tid) => (
                              <button
                                key={tid}
                                type="button"
                                onClick={() => setSelectedTopicId(tid)}
                                className={cn(
                                  "rounded px-1.5 py-0.5 text-[11px]",
                                  selectedTopicId === tid
                                    ? "bg-[var(--primary)] text-[var(--primary-foreground)]"
                                    : "text-[var(--text-muted)] hover:bg-[var(--surface-hover)]",
                                )}
                                title={`只看 topic #${tid}`}
                              >
                                #{tid}
                              </button>
                            ))}
                          </div>
                        )}
                      <div className="min-h-0 flex-1">
                      <DirectChatList
                        messages={visibleMessages}
                        workspaceId={workspaceId}
                        groupId={selectedGroup}
                        virtuosoRef={virtuosoRef}
                        onReplyJump={handleReplyJump}
                        // 翻譯改 message-bound:讓 DirectChatList 自己用 messageId
                        // 創建 closure 給每個 bubble — Native TG cached translation 才能精確 lookup。
                        onTranslate={handleTranslateMessage}
                        onShowReactors={handleShowReactors}
                        onShowReaders={handleShowReaders}
                        onClickButton={handleClickButton}
                        peerAvatarSrc={peerAvatarSrc}
                        onForward={(m) => setForwardingMessage(m)}
                        highlightedMessageId={highlightedMessageId}
                        searchMatchIds={new Set(searchMatches.map((m) => m.id))}
                        selectionMode={selectionMode}
                        selectedIds={selectedIds}
                        onToggleSelect={toggleSelect}
                        onReplyTo={(m) => {
                          // 2026-05-21 Quote-reply 偵測:點 reply 當下若使用者剛好
                          // 有選取此訊息的某段文字,把該段帶進 composer 當引用。
                          // 沒選取 / 選取在其他訊息 → 一般 reply(replyingQuote=null)。
                          try {
                            const sel = window.getSelection();
                            const selText = sel ? sel.toString().trim() : "";
                            // 至少 2 字、且包含於原 content,才當有效 quote
                            if (selText && selText.length >= 2 && m.content) {
                              const offset = m.content.indexOf(selText);
                              if (offset >= 0) {
                                setReplyingQuote({ text: selText, offset });
                              } else {
                                setReplyingQuote(null);
                              }
                            } else {
                              setReplyingQuote(null);
                            }
                          } catch {
                            setReplyingQuote(null);
                          }
                          setReplyingTo(m);
                        }}
                        onShowHistory={(messageId) => setHistoryMessageId(messageId)}
                        onMessageMutated={(action, messageId, newContent) => {
                          // 樂觀更新本機 messages 狀態：刪除標 isDeleted（保留 row
                          // 給 UI 渲染淺色 + 刪除線），編輯就把 content 改掉並記
                          // editedAt，reaction 就更新 reactions 陣列。
                          // 後續 SSE 事件會再次更新（同訊息 ID 為冪等）。
                          if (action === "delete") {
                            setMessages((prev) =>
                              prev.map((x) =>
                                x.id === messageId
                                  ? { ...x, isDeleted: true, deletedAt: new Date().toISOString() }
                                  : x,
                              ),
                            );
                          } else if (action === "edit" && newContent != null) {
                            setMessages((prev) =>
                              prev.map((x) =>
                                x.id === messageId
                                  ? { ...x, content: newContent, editedAt: new Date().toISOString() }
                                  : x,
                              ),
                            );
                          } else if (action === "reaction" && newContent != null) {
                            try {
                              const reactions = JSON.parse(newContent) as Array<{
                                emoji: string;
                                count: number;
                                chosen: boolean;
                              }>;
                              setMessages((prev) =>
                                prev.map((x) =>
                                  x.id === messageId ? { ...x, reactions } : x,
                                ),
                              );
                            } catch {
                              // JSON 解析失敗 → 忽略，SSE 會修正
                            }
                          } else if (action === "pin") {
                            void handlePinMessage(messageId);
                          }
                        }}
                      />
                      </div>
                      </>
                    )}
                    </div>
                  </>
                ) : (
                  <div className="mx-auto mt-8 max-w-md rounded-xl border border-[var(--border)] bg-[var(--surface-panel)] px-6 py-7 text-center text-[var(--text-secondary)]">
                    <MessageCircle className="mx-auto mb-4 h-12 w-12 text-[var(--text-muted)] opacity-80" />
                    <div className="space-y-1.5">
                      <p className="text-sm font-medium text-[var(--foreground)]">請先從左側選擇一個對話</p>
                      <p className="text-xs leading-relaxed">
                        建議先看未讀 badge 與最後訊息時間。若要主動回覆，記得同時從左上方選擇要代表發送的 TG 身分。
                      </p>
                    </div>
                  </div>
                )}
              </div>

              {/* 已選 group 但還沒選 account：提示「想發訊息要先選帳號」，
                  歷史已經顯示在上方。 */}
              {selectedGroup && !selectedAccount && (
                <div className="mt-3 rounded-md border border-dashed border-[var(--border)] bg-[var(--muted)]/40 px-3 py-2 text-xs text-[var(--muted-foreground)]">
                  歷史對話已載入。要在此對話發訊息，請先返回對話列表上方選擇要代表發送的 TG 身分。
                </div>
              )}

              {/* Input area — 發訊息才需要 account；只看歷史不需要 */}
              {selectedGroup && selectedAccount && (
                <div className="mt-3 space-y-2">
                  {/* Reply-to snippet — when the operator swipes a bubble, the
                      message ref is parked here; a click on × clears it. The
                      actual send payload below includes replyToMessageId when set.
                      2026-05-21:若 replyingQuote 非 null,額外 render 引用 chip,
                      使用者可以單獨「✕ 取消引用」保留 reply,或整個取消。 */}
                  {replyingTo && (
                    <div className="rounded-md border-l-[3px] border-[var(--primary)] bg-[var(--muted)]/60 px-2 py-1.5">
                      <div className="flex items-start gap-2">
                        <div className="min-w-0 flex-1">
                          <div className="text-[10px] font-semibold text-[var(--primary)]">
                            回覆 {replyingTo.sender}
                          </div>
                          <div className="truncate text-[11px] text-[var(--muted-foreground)]">
                            {replyingTo.content}
                          </div>
                        </div>
                        <button
                          onClick={() => {
                            setReplyingTo(null);
                            setReplyingQuote(null);
                          }}
                          className="rounded p-0.5 text-[var(--muted-foreground)] hover:bg-[var(--surface-hover)]"
                          aria-label="取消回覆"
                        >
                          <X className="size-3.5" />
                        </button>
                      </div>
                      {replyingQuote && (
                        <div className="mt-1 flex items-start gap-1.5 rounded bg-[var(--accent-bg)]/60 px-1.5 py-1 text-[11px]">
                          <span
                            className="shrink-0 mt-0.5 text-[10px] font-semibold text-[var(--accent)]"
                            aria-hidden
                          >
                            「
                          </span>
                          <span className="min-w-0 flex-1 italic text-[var(--foreground)] line-clamp-2">
                            {replyingQuote.text}
                          </span>
                          <button
                            type="button"
                            onClick={() => setReplyingQuote(null)}
                            className="shrink-0 rounded p-0.5 text-[var(--muted-foreground)] hover:bg-[var(--surface-hover)]"
                            aria-label="取消引用此段(保留回覆)"
                            title="僅取消引用片段,保留回覆對象"
                          >
                            <X className="size-3" />
                          </button>
                        </div>
                      )}
                    </div>
                  )}
                  {/* P3 排程預覽 — scheduleAt 非 null 時顯示「將於 X 送出」+
                      datetime-local 編輯 + 取消按鈕。發送按鈕會自動切「排程」label。*/}
                  {scheduleAt && (
                    <div className="flex items-center gap-2 rounded-md border border-[var(--accent)]/30 bg-[var(--accent-bg)] px-2 py-1.5 text-[11px]">
                      <span className="shrink-0 text-[var(--accent)]" aria-hidden>🕓</span>
                      <span className="shrink-0 text-[var(--text-secondary)]">
                        將於
                      </span>
                      <input
                        type="datetime-local"
                        value={scheduleAt}
                        onChange={(e) => setScheduleAt(e.target.value)}
                        className="flex-1 rounded border border-[var(--border)] bg-[var(--surface-input)] px-1.5 py-0.5 text-[11px] outline-none focus:ring-1 focus:ring-[var(--accent)]"
                      />
                      <span className="shrink-0 text-[var(--text-secondary)]">送出</span>
                      <button
                        type="button"
                        onClick={() => setScheduleAt(null)}
                        className="rounded p-0.5 text-[var(--text-muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--foreground)]"
                        aria-label="取消排程"
                        title="改為立刻送出"
                      >
                        <X className="size-3" />
                      </button>
                    </div>
                  )}
                  {/* 點 picker 以外的地方關閉 */}
                  {(emojiPickerOpen || stickerPickerOpen || quickReplyPickerOpen) && (
                    <div
                      className="fixed inset-0 z-40"
                      onClick={() => {
                        setEmojiPickerOpen(false);
                        setStickerPickerOpen(false);
                        setQuickReplyPickerOpen(false);
                      }}
                    />
                  )}
                  <OutboundComposerShortcutBar
                    active={composerPanel}
                    disabled={!selectedGroup || !selectedAccount || sending}
                    onOpen={(panel) => {
                      setComposerPanel(panel);
                      setEmojiPickerOpen(false);
                      setStickerPickerOpen(false);
                      setQuickReplyPickerOpen(false);
                    }}
                  />
                  {selectedTopicId != null && (
                    <div className="border-b border-[var(--border)]/60 px-2 py-1 text-[11px] text-[var(--text-muted)]">
                      將送到 Forum topic #{selectedTopicId}
                    </div>
                  )}
                  <OutboundComposerPanels
                    openPanel={composerPanel}
                    disabled={sending || !selectedGroup || !selectedAccount}
                    onClose={() => setComposerPanel(null)}
                    onSubmit={handleSendNative}
                  />
                  <div className="flex items-end gap-1">
                    {/* ── Emoji / Sticker 選擇器按鈕（左側）── */}
                    <div className="relative flex shrink-0 items-end gap-0.5 pb-1">
                      {/* Quick reply picker */}
                      <button
                        type="button"
                        disabled={sending}
                        onClick={() => {
                          if (sending) return;
                          setQuickReplyPickerOpen((v) => !v);
                          setEmojiPickerOpen(false);
                          setStickerPickerOpen(false);
                          setComposerPanel(null);
                          closeShortcutAutocomplete();
                        }}
                        className={cn(
                          "relative z-50 rounded p-1.5 transition-colors disabled:cursor-not-allowed disabled:opacity-50",
                          quickReplyPickerOpen
                            ? "text-[var(--accent)] bg-[var(--accent-bg)]"
                            : "text-[var(--muted-foreground)] hover:text-[var(--foreground)]",
                        )}
                        title="快選回覆"
                        aria-label="快選回覆"
                        aria-expanded={quickReplyPickerOpen}
                      >
                        <MessageSquareQuote className="size-4" />
                      </button>
                      <QuickReplyPicker
                        workspaceId={workspaceId}
                        open={quickReplyPickerOpen}
                        onClose={() => setQuickReplyPickerOpen(false)}
                        onSelect={applyQuickReplyFromPicker}
                      />
                      {/* Emoji */}
                      <button
                        type="button"
                        disabled={sending}
                        onClick={() => {
                          if (sending) return;
                          setEmojiPickerOpen((v) => !v);
                          setStickerPickerOpen(false);
                          setQuickReplyPickerOpen(false);
                        }}
                        className={cn(
                          "rounded p-1.5 transition-colors disabled:cursor-not-allowed disabled:opacity-50",
                          emojiPickerOpen
                            ? "text-[var(--accent)] bg-[var(--accent-bg)]"
                            : "text-[var(--muted-foreground)] hover:text-[var(--foreground)]",
                        )}
                        title="插入 Emoji"
                        aria-label="插入 Emoji"
                      >
                        <Smile className="size-4" />
                      </button>
                      {/* Sticker */}
                      {selectedAccount && (
                        <button
                          type="button"
                          disabled={sending}
                          onClick={() => {
                            if (sending) return;
                            setStickerPickerOpen((v) => !v);
                            setEmojiPickerOpen(false);
                            setQuickReplyPickerOpen(false);
                          }}
                          className={cn(
                            "rounded p-1.5 transition-colors disabled:cursor-not-allowed disabled:opacity-50",
                            stickerPickerOpen
                              ? "text-[var(--accent)] bg-[var(--accent-bg)]"
                              : "text-[var(--muted-foreground)] hover:text-[var(--foreground)]",
                          )}
                          title="傳送貼圖"
                          aria-label="傳送貼圖"
                        >
                          <Layers className="size-4" />
                        </button>
                      )}
                      {/* Emoji picker popover */}
                      {emojiPickerOpen && (
                        <div className="absolute bottom-full left-0 mb-2 z-50">
                          <EmojiPicker
                            onSelect={(emoji) => {
                              setEmojiPickerOpen(false);
                              insertAtCursor(emoji);
                            }}
                          />
                        </div>
                      )}
                      {/* Sticker picker popover */}
                      {stickerPickerOpen && selectedAccount && (
                        <div className="absolute bottom-full left-0 mb-2 z-50">
                          <StickerPicker
                            workspaceId={workspaceId}
                            accountId={selectedAccount}
                            onSelect={handleSendSticker}
                          />
                        </div>
                      )}
                    </div>

                    <div className="flex-1 relative">
                      {/* QuickReply / shortcut popover — 浮在 textarea 上方,
                          只在偵測到 /xxx token 時打開 */}
                      <QuickReplyAutocomplete
                        ref={autocompleteRef}
                        workspaceId={workspaceId}
                        filter={shortcutFilter}
                        open={shortcutOpen}
                        onSelect={applyQuickReply}
                        onClose={closeShortcutAutocomplete}
                      />
                      <textarea
                        ref={textareaRef}
                        value={input}
                        onChange={(e) => {
                          const v = e.target.value;
                          setInput(v);
                          updateShortcutState(v, e.target.selectionStart ?? v.length);
                        }}
                        onKeyUp={(e) => {
                          // 也在 keyup 跑(箭頭鍵移動游標也要重算 token,但 onChange 不會 fire)
                          const ta = e.currentTarget;
                          updateShortcutState(ta.value, ta.selectionStart ?? ta.value.length);
                        }}
                        onClick={(e) => {
                          // 點 textarea 改變游標位置時也重算
                          const ta = e.currentTarget;
                          updateShortcutState(ta.value, ta.selectionStart ?? ta.value.length);
                        }}
                        onBlur={() => {
                          // 失焦延遲關閉 popover — 否則點 popover item 會被 blur 搶先觸發 close。
                          // QuickReplyAutocomplete 用 onMouseDown 已 e.preventDefault 阻止 focus 切換,
                          // 但保險起見再延遲 150ms。
                          setTimeout(() => closeShortcutAutocomplete(), 150);
                        }}
                        onKeyDown={handleKeyDown}
                        placeholder="輸入訊息... (Enter 發送, Shift+Enter 換行, /shortcut 快選回覆)"
                        className="w-full resize-none rounded-lg border border-[var(--border-strong)]/70 bg-[var(--surface-input)] px-3 py-2 pr-20 text-sm outline-none placeholder:text-[var(--text-muted)] focus:border-[var(--accent)] focus:ring-2 focus:ring-[var(--focus-ring)] disabled:opacity-70"
                        disabled={sending}
                        rows={1}
                        style={{ minHeight: "40px", maxHeight: "120px" }}
                        onInput={(e) => {
                          const target = e.target as HTMLTextAreaElement;
                          target.style.height = "auto";
                          target.style.height = Math.min(target.scrollHeight, 120) + "px";
                        }}
                      />
                      <div className="absolute right-2 bottom-2 flex items-center gap-1">
                        <button
                          type="button"
                          disabled={sending}
                          onClick={() => setShowFileUpload(!showFileUpload)}
                          className="p-1.5 text-[var(--muted-foreground)] hover:bg-[var(--surface-hover)] hover:text-[var(--foreground)] rounded disabled:cursor-not-allowed disabled:opacity-50"
                          title="附加檔案"
                          aria-label="附加檔案"
                        >
                          <Paperclip className="w-4 h-4" />
                        </button>
                        {/* P3 排程發送 icon — 點開預設「明天 9:00」,使用者可改;
                            scheduleAt 非 null 時 send 按鈕變「排程」label。 */}
                        <button
                          type="button"
                          disabled={sending}
                          onClick={() => {
                            if (sending) return;
                            if (scheduleAt) {
                              setScheduleAt(null);
                            } else {
                              // 預設明天早上 9:00,使用者再改
                              const d = new Date();
                              d.setDate(d.getDate() + 1);
                              d.setHours(9, 0, 0, 0);
                              // datetime-local 需要 local timezone ISO without seconds/Z
                              const pad = (n: number) => String(n).padStart(2, "0");
                              const localIso =
                                `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
                              setScheduleAt(localIso);
                            }
                          }}
                          className={cn(
                            "p-1.5 rounded disabled:cursor-not-allowed disabled:opacity-50",
                            scheduleAt
                              ? "text-[var(--accent)] bg-[var(--accent-bg)]"
                              : "text-[var(--muted-foreground)] hover:text-[var(--foreground)]",
                          )}
                          title={scheduleAt ? "取消排程" : "排程發送"}
                          aria-label={scheduleAt ? "取消排程" : "排程發送"}
                        >
                          <svg
                            viewBox="0 0 24 24"
                            className="w-4 h-4"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            aria-hidden
                          >
                            <circle cx="12" cy="12" r="10" />
                            <polyline points="12 6 12 12 16 14" />
                          </svg>
                        </button>
                        <button
                          onClick={handleSend}
                          disabled={!input.trim() || sending}
                          className={cn(
                            "p-1.5 rounded disabled:opacity-50 disabled:cursor-not-allowed",
                            scheduleAt
                              ? "bg-[var(--accent)] text-[var(--primary-foreground)] hover:bg-[var(--accent-hover)] px-2.5 text-xs"
                              : "bg-[var(--accent)] text-[var(--primary-foreground)] hover:bg-[var(--accent-hover)]",
                          )}
                          aria-label={sending ? "送出中" : scheduleAt ? "建立排程" : "傳送"}
                          title={sending ? "送出中…" : scheduleAt ? "建立排程" : "立刻送出"}
                        >
                          {sending ? "送出中…" : scheduleAt ? "建立排程" : <Send className="w-4 h-4" />}
                        </button>
                      </div>
                    </div>
                  </div>

                  {/* File upload */}
                  {showFileUpload && (
                    <div className="space-y-3 rounded-lg border border-[var(--border)] bg-[var(--surface-elevated)] p-4">
                      <div className="flex flex-wrap gap-2 text-xs">
                        {([
                          ["file", "一般檔案"],
                          ["voiceNote", "語音訊息"],
                          ["videoNote", "圓形影片"],
                        ] as const).map(([mode, label]) => (
                          <button
                            key={mode}
                            type="button"
                            onClick={() => setMediaMode(mode)}
                            className={cn(
                              "rounded-md px-2 py-1",
                              mediaMode === mode
                                ? "bg-[var(--primary)] text-[var(--primary-foreground)]"
                                : "bg-[var(--surface-sidebar)] text-[var(--text-muted)] hover:text-[var(--text-primary)]",
                            )}
                          >
                            {label}
                          </button>
                        ))}
                      </div>
                      <FileUpload
                        workspaceId={workspaceId}
                        onUploadComplete={handleFileUpload}
                        accept="image/*,video/*,audio/*,application/pdf,.doc,.docx,.txt"
                        maxSize={10 * 1024 * 1024}
                      />
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Right: TG 風格對話資訊面板 — 由 chat header 頭像 / 名字點擊開啟。
            桌面是 reflow 內欄、窄螢幕是 overlay。 */}
        {infoPanelOpen && selectedGroup && (() => {
          const g = groups.find((x) => x.id === selectedGroup);
          if (!g) return null;
          return (
            <>
              {/* 窄螢幕遮罩 — 點擊關閉 */}
              <div
                className="fixed inset-0 z-40 bg-[var(--overlay-scrim)] lg:hidden"
                onClick={() => setInfoPanelOpen(false)}
                aria-hidden
              />
              <div className="fixed right-0 top-0 bottom-0 z-50 w-80 max-w-[85vw] overflow-y-auto border-l border-[var(--border-strong)]/70 bg-[var(--surface-panel)] p-3 lg:static lg:z-auto lg:max-w-none lg:rounded-lg lg:border lg:bg-[var(--surface-panel)] lg:min-h-0">
                <ConversationPanel
                  key={selectedGroup}
                  workspaceId={workspaceId}
                  groupId={selectedGroup}
                  group={g}
                  conversation={conversation}
                  messageStats={messages.length > 0 ? messageStats : undefined}
                  onClose={() => setInfoPanelOpen(false)}
                  onToggleMute={menuConfig.showMute ? () => void handleToggleMute(g) : undefined}
                  onStartCall={handleCallIntent}
                  onTagsUpdated={(tags, meta) => handleGroupTagsUpdated(g.id, tags, meta)}
                  onConversationUpdated={setConversation}
                />
              </div>
            </>
          );
        })()}
      </div>
      {/* 訊息歷程 dialog — 點氣泡 footer 上的「已編輯」/「已刪除」會開這個。
          messageId 同時 fallback 到 Message + DCM 兩張表（GET 端會自己 dispatch）。*/}
      <MessageHistoryDialog
        workspaceId={workspaceId}
        messageId={historyMessageId ?? ""}
        open={historyMessageId != null}
        onClose={() => setHistoryMessageId(null)}
      />

      {/* P2 群組成員列表 modal — 只在使用者點 chat header「成員」按鈕時開啟 */}
      {showMembersPanel && selectedGroup && (
        <GroupMembersPanel
          workspaceId={workspaceId}
          groupId={selectedGroup}
          groupTitle={groups.find((g) => g.id === selectedGroup)?.title ?? "目前對話"}
          onClose={() => setShowMembersPanel(false)}
          onSelectMember={(platformUserId) => {
            // 開 user-profile-modal — 既有 switchboard:open-user-profile event 已存在,
            // UserProfileModalHost 監聽會渲染 modal,跟點訊息 sender 名一致。
            window.dispatchEvent(
              new CustomEvent("switchboard:open-user-profile", {
                detail: { platformUserId },
              }),
            );
            setShowMembersPanel(false);
          }}
        />
      )}

      {/* P1 轉發訊息 modal — 單條(forwardingMessage)或多選(forwardingBatch)都用。 */}
      {(forwardingMessage || forwardingBatch) && selectedGroup && (
        <ForwardChatPicker
          workspaceId={workspaceId}
          groups={groups}
          sourceGroupId={selectedGroup}
          busy={forwardBusy}
          onPick={(targetGroupId) => void handleForwardPick(targetGroupId)}
          onClose={() => {
            setForwardingMessage(null);
            setForwardingBatch(null);
          }}
        />
      )}

      {/* 2026-05-21 Round 4:AI 副駕浮動 panel。Floating button + side panel,
          會在任何時候都浮在右下角。AI provider 由 server-side LLM_PROVIDER
          決定，未設定時 server 回 422 + UI 顯示錯誤訊息。 */}
      <AICopilotPanel
        workspaceId={workspaceId}
        groupId={selectedGroup}
        onPaste={(text) => {
          // 把 AI 建議貼進 composer + 自動聚焦 textarea
          setInput(text);
          requestAnimationFrame(() => {
            const ta = textareaRef.current;
            if (ta) {
              ta.focus();
              // resize 以容納長 paste
              ta.style.height = "auto";
              ta.style.height = Math.min(ta.scrollHeight, 120) + "px";
            }
          });
        }}
      />

      {/* 群發面板 — 點左欄 Radio 按鈕開啟,slide-in from right */}
      {broadcastOpen && (
        <BroadcastPanel
          workspaceId={workspaceId}
          groups={groups as BroadcastGroup[]}
          accounts={Array.from(
            new Map(
              groups.flatMap((g) =>
                g.accountMemberships.map((m) => [m.account.id, m.account]),
              ),
            ).values(),
          )}
          defaultAccountId={selectedAccount}
          onClose={() => setBroadcastOpen(false)}
          onSuccess={(successCount, total) => {
            setBroadcastOpen(false);
            toast.success(`已群發至 ${successCount}/${total} 個對話`);
          }}
        />
      )}

      {embeddedCall && (
        <EmbeddedTelegramCallModal
          key={[
            embeddedCall.direction,
            embeddedCall.groupId,
            embeddedCall.gatewaySessionId || "new",
            embeddedCall.mode,
          ].join(":")}
          workspaceId={workspaceId}
          groupId={embeddedCall.groupId}
          accountId={embeddedCall.accountId}
          title={embeddedCall.title}
          mode={embeddedCall.mode}
          direction={embeddedCall.direction}
          gatewaySessionId={embeddedCall.gatewaySessionId}
          remoteStateHint={embeddedCall.remoteStateHint}
          onClose={() => setEmbeddedCall(null)}
        />
      )}
    </div>
  );
}

function directChatStatus(m: ChatMessage): ChatBubbleStatus | undefined {
  if (m.direction !== "outgoing") return undefined;
  if (m.status === "sending") return "pending";
  if (m.status === "error") return "failed";
  if (m.status === "pending") return "pending";
  // 2026-05-21 Backend-first 真實已讀回執:
  //   readAt 有值      → 對方已讀 (2 藍勾)
  //   deliveredAt 有值 → 已送達對方裝置 (2 灰勾)
  //   送出但 deliveredAt 為 null (offline send / 還未 ack) → 1 灰勾
  if (m.status === "sent") {
    if (m.readAt) return "read";
    if (m.deliveredAt) return "delivered";
    return "sent";
  }
  return "sent";
}

/**
 * Virtualized chat area used when a group is selected. Handles sender-run
 * grouping + date separators, feeds items into VirtualChatList so large
 * conversation histories stay fast and we get a scroll-to-bottom FAB +
 * unread counter for free.
 */
type DirectRenderItem =
  | { kind: "date"; id: string; date: string }
  | {
      kind: "message";
      id: string;
      message: ChatMessage;
      showName: boolean;
      showAvatar: boolean;
      /**
       * 2026-05-21 TG parity:Album sibling count。
       * 客戶在 TG 端「一次送 N 張」時 N 筆 message 共享同個 groupedId;
       * 我們只渲染第一筆(album lead)— UI 顯示一個 +N 標記表示「這是 N+1 個附件的群組」。
       */
      albumSiblingCount?: number;
      /**
       * 2026-05-21 TG parity:Album sibling media — 後續同 group 的訊息(已被 skipSet 跳過獨立渲染),
       * 但它們的 media 要被 lead bubble 拿來組成「N 格 grid」。
       * 每個 entry:{ id, mediaUrl, mediaType, messageType } — 給 ChatBubble.albumExtras 用。
       * 全部 IMAGE/VIDEO 時可組真正的 thumbnail grid;混合類型仍 fallback 到 +N chip。
       */
      albumExtras?: Array<{
        id: string;
        mediaUrl: string | null;
        mediaType: string | null;
        messageType: string;
      }>;
    };

function DirectChatList({
  messages,
  workspaceId,
  groupId,
  onReplyTo,
  onMessageMutated,
  onShowHistory,
  virtuosoRef,
  onReplyJump,
  onTranslate,
  onShowReactors,
  onShowReaders,
  onClickButton,
  onForward,
  highlightedMessageId,
  searchMatchIds,
  selectionMode,
  selectedIds,
  onToggleSelect,
  peerAvatarSrc,
}: {
  messages: ChatMessage[];
  workspaceId: string;
  groupId: string;
  /** 1:1 私訊對方頭像(= 對話頭像);傳入則 incoming 訊息頭像沿用它。 */
  peerAvatarSrc?: string | null;
  onReplyTo?: (m: ChatMessage) => void;
  onMessageMutated?: (action: "edit" | "delete" | "reaction" | "pin", messageId: string, newContent?: string) => void;
  onShowHistory?: (messageId: string) => void;
  /** P1: 暴露 scrollToKey 給上層做 jump-to-reply / 搜尋切換 */
  virtuosoRef?: React.RefObject<VirtualChatListHandle | null>;
  /** P1: 點 reply preview → 跳到該 platformMessageId 的訊息 */
  onReplyJump?: (replyToPlatformId: string) => void;
  /**
   * 翻譯 callback。簽名:(messageId, fallbackText) → Promise<translated string>。
   * messageId 用來打 native TG endpoint(cached + 高品質);非同步訊息退回 Google
   * /api/translate 用 fallbackText。renderDirectChatItem 內 wrap 成 () => Promise<string>
   * 餵 chat-bubble。
   */
  onTranslate?: (messageId: string, fallbackText: string) => Promise<string>;
  /** P2: 看誰按了反應 callback。傳 dcm message id,回 reactor list。 */
  onShowReactors?: (messageId: string) => Promise<Array<{
    platformUserId: string;
    displayName: string;
    username: string | null;
    emoji: string;
    date: string | null;
  }>>;
  /**
   * 2026-05-21 二線(round 4):「看誰已讀我方訊息」popover callback。
   * 重用 reactors 一樣的回傳 shape,bubble 內以 emoji=✓✓ 視為一種 reactor。
   * 只對 OUTBOUND 群組訊息有效;1:1 / INBOUND parent 不該提供。
   */
  onShowReaders?: (messageId: string) => Promise<Array<{
    platformUserId: string;
    displayName: string;
    username: string | null;
    emoji: string;
    date: string | null;
  }>>;
  /** 2026-05-21 訊息按鈕:點 callback 按鈕 callback。傳 (messageId, base64 data)。 */
  onClickButton?: (
    messageId: string,
    data: string,
  ) => Promise<{ message?: string | null; alert?: boolean; url?: string | null }>;
  /** P1: 轉發 — 點 bubble 上的 forward icon 時觸發,parent 開 modal 選目標。 */
  onForward?: (m: ChatMessage) => void;
  /** P1: 短暫 highlight 的 message id(jump-to-reply 後 ~1.5s) */
  highlightedMessageId?: string | null;
  /** P1: search 命中的 message id 集合(O(1) lookup) */
  searchMatchIds?: Set<string>;
  /** P1 多選模式相關 — 三個 prop 通常一起傳。 */
  selectionMode?: boolean;
  selectedIds?: Set<string>;
  onToggleSelect?: (m: ChatMessage) => void;
}) {
  const typers = useTypingIndicator(workspaceId, groupId);
  const items = useMemo<DirectRenderItem[]>(() => {
    const out: DirectRenderItem[] = [];
    let prevDate: string | null = null;
    let prevSender: string | null = null;
    // 2026-05-21 TG parity:Album merging — pre-compute sibling count + extras by groupedId
    // 以 (sender, groupedId) 為合併單位(同 groupedId 但不同寄件人的 TG 不會送,
    // 仍以 sender 對齊保安全)。
    type AlbumExtra = {
      id: string;
      mediaUrl: string | null;
      mediaType: string | null;
      messageType: string;
    };
    const albumLeadByKey = new Map<
      string,
      { leadIndex: number; count: number; extras: AlbumExtra[] }
    >();
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];
      if (!m.groupedId) continue;
      const key = `${m.sender}::${m.groupedId}`;
      const lead = albumLeadByKey.get(key);
      if (!lead) {
        albumLeadByKey.set(key, { leadIndex: i, count: 1, extras: [] });
      } else {
        lead.count += 1;
        lead.extras.push({
          id: m.id,
          mediaUrl: m.mediaUrl ?? null,
          mediaType: m.mediaType ?? null,
          messageType: m.messageType ?? "TEXT",
        });
      }
    }
    // skipSet:後續同 album 的訊息 index,渲染時跳過(其 media 已收進 lead.extras)
    const skipIndices = new Set<number>();
    for (const { leadIndex, count } of albumLeadByKey.values()) {
      if (count <= 1) continue; // 只有一筆 = 不算 album
      let seen = 0;
      const lead = messages[leadIndex];
      const albumKey = `${lead.sender}::${lead.groupedId}`;
      for (let i = leadIndex; i < messages.length && seen < count; i++) {
        const x = messages[i];
        if (!x.groupedId) continue;
        if (`${x.sender}::${x.groupedId}` !== albumKey) continue;
        if (i !== leadIndex) skipIndices.add(i);
        seen++;
      }
    }

    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];
      if (skipIndices.has(i)) continue; // album sibling — 不渲染獨立泡泡
      const day = new Date(m.timestamp).toDateString();
      if (day !== prevDate) {
        out.push({ kind: "date", id: `date-${day}-${m.id}`, date: m.timestamp });
        prevDate = day;
        prevSender = null;
      }
      const isIncoming = m.direction === "incoming";
      const isNewSender = m.sender !== prevSender;
      let albumSiblingCount: number | undefined;
      let albumExtras: AlbumExtra[] | undefined;
      if (m.groupedId) {
        const lead = albumLeadByKey.get(`${m.sender}::${m.groupedId}`);
        if (lead && lead.count > 1 && lead.leadIndex === i) {
          albumSiblingCount = lead.count - 1;
          albumExtras = lead.extras;
        }
      }
      out.push({
        kind: "message",
        id: m.id,
        message: m,
        // 2026-05-21 仿 TG:同一發送者連續訊息只在第一則顯示名稱,跟 showAvatar
        // 同步壓縮,避免每則重複名字。
        showName: isIncoming && isNewSender,
        showAvatar: isIncoming && isNewSender,
        albumSiblingCount,
        albumExtras,
      });
      prevSender = m.sender;
    }
    return out;
  }, [messages]);

  // P3:預先把訊息依 platformMessageId 索引,給 reply 預覽 lookup 用。
  // 之前 jump-to-reply 雖然有 callback,但 reply 預覽從未被構造 → UI 上沒
  // 顯示 reply quote 框 → 使用者也無從點擊跳轉。這次補上 reply prop 建構。
  const messagesByPlatformId = useMemo(() => {
    const m = new Map<string, ChatMessage>();
    for (const x of messages) {
      if (x.platformMessageId) m.set(x.platformMessageId, x);
    }
    return m;
  }, [messages]);

  return (
    <div className="flex h-full w-full flex-col">
      <div className="flex-1 min-h-0">
        <VirtualChatList<DirectRenderItem>
          ref={virtuosoRef}
          items={items}
          getItemKey={(it) => it.id}
          renderItem={(it) =>
            renderDirectChatItem(
              it,
              workspaceId,
              onReplyTo,
              onMessageMutated,
              (id) => messages.find((m) => m.id === id),
              onShowHistory,
              onReplyJump,
              onTranslate,
              onForward,
              highlightedMessageId,
              searchMatchIds,
              selectionMode,
              selectedIds,
              onToggleSelect,
              onShowReactors,
              messagesByPlatformId,
              onShowReaders,
              onClickButton,
              peerAvatarSrc,
            )
          }
        />
      </div>
      {typers.length > 0 && (
        <div className="shrink-0 px-4 py-1.5">
          <TypingIndicator typers={typers} />
        </div>
      )}
    </div>
  );
}

function renderDirectChatItem(
  it: DirectRenderItem,
  workspaceId: string,
  onReplyTo?: (m: ChatMessage) => void,
  onMessageMutated?: (action: "edit" | "delete" | "reaction" | "pin", messageId: string, newContent?: string) => void,
  getLatestMessage?: (messageId: string) => ChatMessage | undefined,
  onShowHistory?: (messageId: string) => void,
  onReplyJump?: (replyToPlatformId: string) => void,
  // 簽名同上層(messageId, fallbackText) — 內部我們會 wrap 成 0-arg 給 chat-bubble。
  onTranslate?: (messageId: string, fallbackText: string) => Promise<string>,
  onForward?: (m: ChatMessage) => void,
  highlightedMessageId?: string | null,
  searchMatchIds?: Set<string>,
  selectionMode?: boolean,
  selectedIds?: Set<string>,
  onToggleSelect?: (m: ChatMessage) => void,
  onShowReactors?: (messageId: string) => Promise<Array<{
    platformUserId: string;
    displayName: string;
    username: string | null;
    emoji: string;
    date: string | null;
  }>>,
  /** P3: 用來構造 reply preview — 把 m.replyToPlatformId 反查成原訊息資料。 */
  messagesByPlatformId?: Map<string, ChatMessage>,
  /** 2026-05-21 二線(round 4):「看誰已讀」popover callback。 */
  onShowReaders?: (messageId: string) => Promise<Array<{
    platformUserId: string;
    displayName: string;
    username: string | null;
    emoji: string;
    date: string | null;
  }>>,
  /** 2026-05-21 訊息按鈕:點 callback 按鈕 callback。 */
  onClickButton?: (
    messageId: string,
    data: string,
  ) => Promise<{ message?: string | null; alert?: boolean; url?: string | null }>,
  /** 1:1 私訊對方的頭像 URL(= 對話 group 頭像)。incoming 訊息頭像優先用它,
   *  避免「列表有頭像、對話內只有首字」的不一致(私訊對方 = 對話本身)。 */
  peerAvatarSrc?: string | null,
): React.ReactNode {
  if (it.kind === "date") return <DateSeparator date={it.date} />;
  const m = it.message;
  const side = m.direction === "outgoing" ? "right" : "left";
  const statusTooltip = m.status === "error" ? "發送失敗，請稍後再試" : "";

  // 私訊:incoming 訊息頭像沿用「對話頭像」(peerAvatarSrc),跟列表/header 一致;
  // 群組:每位 sender 用各自的 user 頭像。
  const avatarSrc =
    peerAvatarSrc ??
    (m.senderPlatformId
      ? `/api/workspaces/${workspaceId}/avatars/${m.senderPlatformId}`
      : null);

  // 我方訊息 (outgoing) + 是 DirectChatMessage 來源 (source="direct") + 文字訊息
  // → 提供編輯 / 刪除 callback。bridge 端訊息 (source="bridge")是走轉發 pipeline，
  // 有自己的審核流程，不在此編輯路徑。
  // 必須等 send response 帶回 platformMessageId 才能編輯/刪除 — 沒有它
  // server PATCH/DELETE 會被 guard 擋(此訊息尚未成功送出至 Telegram,無法編輯)。
  // 沒這條件的話剛送出 1 秒內 hover toolbar 看到按鈕但點下去就失敗,UX 很惑。
  const canModify =
    m.direction === "outgoing" &&
    m.source === "direct" &&
    m.messageType === "TEXT" &&
    !m.isDeleted &&
    !!m.platformMessageId;

  const onEdit = canModify
    ? async (newContent: string) => {
        const res = await fetch(
          `/api/workspaces/${workspaceId}/direct-chat/messages/${m.id}`,
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ content: newContent }),
          },
        );
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error || "編輯失敗");
        }
        onMessageMutated?.("edit", m.id, newContent);
      }
    : undefined;

  const onDelete = canModify
    ? async () => {
        const res = await fetch(
          `/api/workspaces/${workspaceId}/direct-chat/messages/${m.id}`,
          { method: "DELETE" },
        );
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error || "刪除失敗");
        }
        onMessageMutated?.("delete", m.id);
      }
    : undefined;

  // Reaction 對所有「DirectChatMessage」皆可用（含他人的訊息），但訊息得有
  // platformMessageId 才能透過 bridge 送到 TG。已刪訊息不能 react。
  const onReact =
    m.source === "direct" && m.platformMessageId && !m.isDeleted
      ? async (emoji: string | null) => {
          // 樂觀更新：先更新本地 UI，再發送 API
          // 使用 getLatestMessage 獲取最新的 reactions（不是渲染時的快照）
          const latestMessage = getLatestMessage?.(m.id);
          const currentReactions = latestMessage?.reactions || m.reactions || [];
          let newReactions: Array<{ emoji: string; count: number; chosen: boolean }>;

          if (emoji === null) {
            // 清除 reaction → 移除自己 chosen 的 emoji
            newReactions = currentReactions
              .filter(r => !r.chosen)
              .map(r => ({
                ...r,
                count: r.chosen ? Math.max(0, r.count - 1) : r.count,
              }))
              .filter(r => r.count > 0);
          } else {
            // 設定/切換 emoji
            const existing = currentReactions.find(r => r.emoji === emoji);
            const currentlyChosen = currentReactions.find(r => r.chosen);

            if (existing) {
              if (existing.chosen) {
                // 已選過此 emoji → 取消
                newReactions = existing.count > 1
                  ? currentReactions.map(r =>
                      r.emoji === emoji
                        ? { ...r, count: r.count - 1, chosen: false }
                        : r
                    )
                  : currentReactions.filter(r => r.emoji !== emoji);
              } else {
                // 切換到此 emoji → 新的 count+1，舊的 chosen emoji count-1
                newReactions = currentReactions.map(r => {
                  if (r.emoji === emoji) {
                    // 新選的 emoji：count+1，chosen=true
                    return { ...r, count: r.count + 1, chosen: true };
                  }
                  if (r.chosen) {
                    // 之前 chosen 的 emoji：count-1，chosen=false
                    return r.count > 1
                      ? { ...r, count: r.count - 1, chosen: false }
                      : null;
                  }
                  return r;
                }).filter((r): r is { emoji: string; count: number; chosen: boolean } => r !== null);
              }
            } else {
              // 新 emoji → 清除其他 chosen，加新的
              newReactions = [
                ...currentReactions.map(r => {
                  if (r.chosen) {
                    // 之前 chosen 的 emoji：count-1，chosen=false
                    return r.count > 1
                      ? { ...r, chosen: false, count: r.count - 1 }
                      : null;
                  }
                  return r;
                }).filter((r): r is { emoji: string; count: number; chosen: boolean } => r !== null),
                { emoji, count: 1, chosen: true },
              ];
            }
          }

          // 樂觀更新本地 state
          onMessageMutated?.("reaction", m.id, JSON.stringify(newReactions));

          // 發送到 API
          const res = await fetch(
            `/api/workspaces/${workspaceId}/messages/${m.id}/reaction`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ emoji }),
            },
          );
          if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            // 失敗時回滾：重新載入或回滾到原狀態
            // 為簡化，這裡只拋錯誤，讓 UI 保持樂觀狀態（SSE 會修正）
            throw new Error(data.error || "Reaction 失敗");
          }

          // 檢查是否是 localOnly（舊訊息無法同步到 Telegram）
          const result = await res.json();
          if (result.localOnly) {
            // 本地 only reaction - 保持樂觀更新狀態，可選地顯示提示
            console.log("Reaction 僅本地顯示（無法同步到 Telegram）");
          }
        }
      : undefined;

  // P3: 構造 reply preview — 找 replyToPlatformId 對應的原訊息,quote 片段
  // 若有就用,否則退化到完整 content。lookup miss(原訊息在更早歷史中、
  // 尚未載入)時顯示 placeholder + 用 quoteText 作 backup。
  const replyContext = m.replyToPlatformId
    ? (() => {
        const target = messagesByPlatformId?.get(m.replyToPlatformId!) ?? null;
        return {
          senderName: target?.sender ?? null,
          content: target?.content ?? "(該訊息不在已載入歷史中)",
          mediaFileName: target?.mediaFileName ?? null,
          quoteText: m.quoteText ?? null,
        };
      })()
    : null;

  const bubble = (
    <ChatBubble
      side={side}
      content={m.content}
      senderName={it.showName ? m.sender : null}
      reply={replyContext}
      timestamp={m.timestamp}
      status={directChatStatus(m)}
      statusTooltip={statusTooltip}
      editedAt={m.editedAt}
      isDeleted={m.isDeleted}
      deletedAt={m.deletedAt}
      // 已編輯/已刪除 footer 變成可點 → 開 history dialog（DCM source 才有）
      onShowHistory={
        m.source === "direct" && (m.editedAt || m.isDeleted) && onShowHistory
          ? () => onShowHistory(m.id)
          : undefined
      }
      media={{
        messageType: m.messageType,
        mediaUrl: m.mediaUrl ?? null,
        mediaType: m.mediaType ?? null,
        mediaFileName: m.mediaFileName ?? null,
        mediaMetadata: m.mediaMetadata ?? null,
      }}
      avatar={
        m.direction === "incoming" ? (
          it.showAvatar ? (
            <ChatAvatar
              name={m.sender}
              seed={m.senderPlatformId ?? m.sender}
              src={avatarSrc}
              size="sm"
            />
          ) : (
            <div aria-hidden="true" className="size-8 shrink-0" />
          )
        ) : undefined
      }
      onEdit={onEdit}
      onDelete={onDelete}
      onReact={onReact}
      reactions={m.reactions}
      // P1: jump-to-reply + 翻譯 + 轉發 + highlight ring + search highlight
      platformMessageId={m.platformMessageId ?? null}
      onReplyClick={
        m.replyToPlatformId && onReplyJump
          ? () => onReplyJump(m.replyToPlatformId!)
          : undefined
      }
      // 2026-05-21:wrap 成 0-arg closure 給 bubble。parent 端的
      // handleTranslateMessage(messageId, fallbackText) 知道 messageId 才能精確
      // 命中 native TG cache。
      onTranslate={
        onTranslate
          ? () => onTranslate(m.id, m.content ?? "")
          : undefined
      }
      onForward={onForward ? () => onForward(m) : undefined}
      onPin={onMessageMutated ? () => onMessageMutated("pin", m.id) : undefined}
      isPinned={!!m.pinnedAt}
      highlighted={highlightedMessageId === m.id}
      searchMatch={searchMatchIds?.has(m.id) ?? false}
      forwardedFrom={m.forwardedFrom ?? null}
      topicId={m.topicId ?? null}
      viewCount={m.viewCount ?? null}
      entities={m.entities ?? null}
      albumSiblingCount={it.albumSiblingCount ?? null}
      albumExtras={it.albumExtras ?? null}
      replyMarkup={m.replyMarkup ?? null}
      onClickButton={
        onClickButton ? (data) => onClickButton(m.id, data) : undefined
      }
      onShowReactors={
        onShowReactors && m.reactions && m.reactions.length > 0
          ? () => onShowReactors(m.id)
          : undefined
      }
      // 2026-05-21 二線:只對 OUTBOUND 訊息 + 有 platformMessageId 顯示「已讀名單」按鈕。
      // 1:1 私訊有 readAt 藍勾,不需要這個;backend 會回空 + note。
      onShowReaders={
        onShowReaders && m.direction === "outgoing" && m.platformMessageId
          ? () => onShowReaders(m.id)
          : undefined
      }
      // P1 multi-select
      selectionMode={selectionMode}
      selected={selectedIds?.has(m.id) ?? false}
      onToggleSelect={onToggleSelect ? () => onToggleSelect(m) : undefined}
    />
  );

  // Only wrap with swipe when a reply handler is available (i.e. the
  // enclosing page supports threading). Avoids dangling gestures for
  // staff-side own bubbles the operator can't "reply to".
  if (onReplyTo) {
    return (
      <SwipeToReply side={side} onReply={() => onReplyTo(m)}>
        {bubble}
      </SwipeToReply>
    );
  }
  return bubble;
}
