/**
 * Telegram Client Manager
 *
 * Manages multiple GramJS TelegramClient instances for different accounts.
 * Used by the bridge worker process.
 */

import { logger } from "@/lib/logger";
import { TelegramClient } from "telegram";

const log = logger("ClientManager");
import { StringSession } from "telegram/sessions";
import { NewMessage, type NewMessageEvent } from "telegram/events";
import { EditedMessage, type EditedMessageEvent } from "telegram/events/EditedMessage";
import { DeletedMessage, type DeletedMessageEvent } from "telegram/events/DeletedMessage";
import { Raw } from "telegram/events/Raw";
import { Api } from "telegram";
import bigInt from "big-integer";
import { decrypt } from "@/lib/crypto/encryption";
import { PrismaClient } from "@prisma/client";

// Narrow shapes for GramJS objects we read by key. Lets us drop `any` without
// pulling in the full GramJS type surface (which is large and changes often).
type TgMediaLike = {
  className?: string;
  document?: {
    mimeType?: string;
    size?: number;
    attributes?: Array<{ fileName?: string }>;
  };
  photo?: { sizes?: Array<{ size?: number }> };
};
type TgPeerLike = {
  channelId?: { toString(): string } | null;
  chatId?: { toString(): string } | null;
};
type TgSendError = {
  errorMessage?: string;
  message?: string;
  seconds?: number;
  newChannelId?: unknown;
  result?: { newChannelId?: unknown };
};
function asTgSendError(err: unknown): TgSendError {
  return (err && typeof err === "object" ? (err as TgSendError) : {});
}

type MediaInfo = {
  mimeType: string;
  fileName?: string;
  fileSize?: number;
  buffer?: Buffer;
};

/**
 * 從 TG MessageFwdHeader 結構抽出我們關心的轉發來源欄位。
 *
 * fwdFrom 可能型別:
 *   - PeerUser   {userId}              — 個人轉發
 *   - PeerChannel{channelId}           — 頻道 post 轉發(可能再帶 channelPost = 原 msg id)
 *   - PeerChat   {chatId}              — 普通群組轉發(罕見)
 *   - 沒 fromId  fwdFrom.fromName 才有 — 對方開「隱藏轉發來源」的設定
 *
 * fromName / postAuthor 是 TG 給「顯示文字」用的 fallback,有就用。
 */
/**
 * Normalize TG `message.entities[]` (TL constructors) into plain JSON for DB.
 *
 * GramJS 把每個 entity 包成 Api.MessageEntityBold / Italic / Spoiler / TextUrl…
 * 等 class 實例;我們轉成 { type, offset, length, ...payload } 的扁平 plain object,
 * type 命名與 TG Bot API (snake_case) 對齊,跨客戶端更通用。
 *
 * 不認識的 entity class 跳過(不丟錯 — TG 偶爾加新類型,我們應該 forward-compat)。
 * 回傳 undefined 而非空陣列以節省 DB row(prisma 上下游都看 null/undefined 等價)。
 */
function normalizeEntities(
  entities: unknown,
): NormalizedMessageEntity[] | undefined {
  if (!Array.isArray(entities) || entities.length === 0) return undefined;
  const out: NormalizedMessageEntity[] = [];
  for (const e of entities) {
    if (!e || typeof e !== "object") continue;
    const ent = e as {
      className?: string;
      offset?: number;
      length?: number;
      url?: string;
      userId?: bigint | number;
      documentId?: bigint | number;
      language?: string;
    };
    const offset = typeof ent.offset === "number" ? ent.offset : 0;
    const length = typeof ent.length === "number" ? ent.length : 0;
    if (length <= 0) continue; // safety:零長度 entity 沒意義

    // className 在 GramJS 是 "MessageEntityBold" / "MessageEntityCustomEmoji" 等
    const cn = ent.className ?? "";
    if (!cn.startsWith("MessageEntity")) continue;
    const kind = cn.slice("MessageEntity".length);

    const mapping: Partial<
      Record<string, NormalizedMessageEntity["type"]>
    > = {
      Bold: "bold",
      Italic: "italic",
      Underline: "underline",
      Strike: "strikethrough",
      Spoiler: "spoiler",
      Code: "code",
      Pre: "pre",
      Blockquote: "blockquote",
      Mention: "mention",
      MentionName: "mention_name",
      InputMessageEntityMentionName: "mention_name",
      TextUrl: "text_url",
      Url: "url",
      Email: "email",
      Phone: "phone",
      Hashtag: "hashtag",
      Cashtag: "cashtag",
      BotCommand: "bot_command",
      CustomEmoji: "custom_emoji",
      BankCard: "bank_card",
    };
    const type = mapping[kind];
    if (!type) continue; // 不認識的就跳過

    const norm: NormalizedMessageEntity = { type, offset, length };
    if (type === "text_url" && typeof ent.url === "string") norm.url = ent.url;
    if (type === "mention_name" && ent.userId != null)
      norm.userId = ent.userId.toString();
    if (type === "custom_emoji" && ent.documentId != null)
      norm.documentId = ent.documentId.toString();
    if (type === "pre" && typeof ent.language === "string" && ent.language)
      norm.language = ent.language;

    out.push(norm);
  }
  if (out.length === 0) return undefined;
  // 保留 TG 原始順序(已是 offset asc);UI 渲染時需要這個保證。
  return out;
}

/**
 * 從 `client.invoke(Api.messages.SendMessage(...))` 的回傳挖出 sentMessageId。
 *
 * TG 對 sendMessage 可能回:
 *   - UpdateShortSentMessage   { id, ... }         — 私聊文字訊息常見的精簡 update
 *   - Updates / UpdatesCombined { updates: [...] } — 群組 / channel,常含 UpdateMessageID
 *
 * 我們抽 id 的順序:
 *   1. 頂層 .id (UpdateShortSentMessage 直接帶)
 *   2. updates[] 中的 UpdateMessageID.id
 *   3. updates[] 中的 UpdateNewMessage.message.id
 * 都找不到回 undefined(caller 仍視為 success,只是後續沒辦法 echo platform id)。
 */
function extractSentMessageId(result: unknown): string | undefined {
  if (!result || typeof result !== "object") return undefined;
  const r = result as {
    id?: number | bigint;
    className?: string;
    updates?: Array<{
      className?: string;
      id?: number | bigint;
      message?: { id?: number | bigint };
    }>;
  };
  if (r.id != null) return String(r.id);
  if (Array.isArray(r.updates)) {
    for (const u of r.updates) {
      if (u?.className === "UpdateMessageID" && u.id != null) return String(u.id);
      if (u?.className === "UpdateNewMessage" && u.message?.id != null)
        return String(u.message.id);
      if (
        u?.className === "UpdateNewChannelMessage" &&
        u.message?.id != null
      )
        return String(u.message.id);
    }
  }
  return undefined;
}

function extractForwardedFrom(fwd: unknown): ForwardedFromMeta | undefined {
  if (!fwd || typeof fwd !== "object") return undefined;
  const h = fwd as {
    fromId?: {
      className?: string;
      userId?: bigint | number;
      channelId?: bigint | number;
      chatId?: bigint | number;
    };
    fromName?: string;
    date?: number;
    channelPost?: number;
    postAuthor?: string;
  };
  const meta: ForwardedFromMeta = {};
  // date: TG 是秒級 unix timestamp
  if (typeof h.date === "number" && h.date > 0) {
    meta.date = new Date(h.date * 1000).toISOString();
  }
  // fromId 路徑
  if (h.fromId) {
    const cn = h.fromId.className ?? "";
    if (cn.includes("PeerUser") && h.fromId.userId != null) {
      meta.senderPlatformUserId = String(h.fromId.userId);
    } else if (cn.includes("PeerChannel") && h.fromId.channelId != null) {
      meta.channelPlatformId = String(h.fromId.channelId);
    } else if (cn.includes("PeerChat") && h.fromId.chatId != null) {
      // 普通 chat 轉發 — 沿用 channelPlatformId 欄位(reader 通常會去解析)
      meta.channelPlatformId = String(h.fromId.chatId);
    }
  }
  if (typeof h.channelPost === "number" && h.channelPost > 0) {
    meta.originalMessageId = String(h.channelPost);
  }
  // fromName 是 TG 對「隱藏轉發來源」的 fallback;若我們沒解析到 fromId 就用它
  if (typeof h.fromName === "string" && h.fromName.length > 0) {
    if (!meta.senderName) meta.senderName = h.fromName;
  }
  if (typeof h.postAuthor === "string" && h.postAuthor.length > 0) {
    // 頻道 post 的「作者」(channel post 通常匿名 = channel title,但若 admin
    // signs 訊息會有 postAuthor 顯示名)。把它當 senderName 用。
    if (!meta.senderName) meta.senderName = h.postAuthor;
  }
  // 完全沒任何 useful 欄位 → return undefined,避免存空 object
  if (
    !meta.senderName &&
    !meta.senderPlatformUserId &&
    !meta.channelTitle &&
    !meta.channelPlatformId &&
    !meta.originalMessageId &&
    !meta.date
  ) {
    return undefined;
  }
  return meta;
}

/**
 * 2026-05-21 訊息按鈕 (inline keyboard):正規化後的單一按鈕。
 *   kind = "callback" → data 是 base64(callback bytes);點擊走 GetBotCallbackAnswer
 *   kind = "url"      → url 是要開的連結
 *   kind = "other"    → 不支援的類型(buy / game / switch_inline / url_auth…),UI disabled
 */
export type NormalizedButton = {
  text: string;
  kind: "callback" | "url" | "other";
  data?: string;
  url?: string;
};

/** 正規化後的訊息按鈕排版。 */
export type NormalizedReplyMarkup = {
  /** inline = 訊息下方按鈕;reply = 取代鍵盤的自訂鍵盤(MVP 只顯示不可點)。 */
  type: "inline" | "reply";
  rows: NormalizedButton[][];
};

/**
 * 把 TG `message.replyMarkup`(TL constructor)正規化成 plain JSON。
 *
 * 支援:
 *   - ReplyInlineMarkup → type "inline",rows 內 callback / url 按鈕可互動
 *   - ReplyKeyboardMarkup → type "reply",MVP 全部標 "other"(顯示但不可點 — 自訂鍵盤
 *     的互動方式是「送出按鈕文字」,操作員可以直接打字,不另接)
 * 其餘(ReplyKeyboardHide / ForceReply)→ undefined(沒按鈕可顯示)。
 */
function normalizeReplyMarkup(
  replyMarkup: unknown,
): NormalizedReplyMarkup | undefined {
  if (!replyMarkup || typeof replyMarkup !== "object") return undefined;
  const rm = replyMarkup as {
    className?: string;
    rows?: Array<{ buttons?: unknown[] }>;
  };
  const cn = rm.className ?? "";
  const isInline = cn === "ReplyInlineMarkup";
  const isReplyKb = cn === "ReplyKeyboardMarkup";
  if (!isInline && !isReplyKb) return undefined;
  if (!Array.isArray(rm.rows)) return undefined;

  const rows: NormalizedButton[][] = [];
  for (const row of rm.rows) {
    if (!row || !Array.isArray(row.buttons)) continue;
    const normRow: NormalizedButton[] = [];
    for (const btn of row.buttons) {
      if (!btn || typeof btn !== "object") continue;
      const b = btn as {
        className?: string;
        text?: string;
        url?: string;
        data?: Buffer | Uint8Array | string;
      };
      const text = typeof b.text === "string" ? b.text : "";
      if (!text) continue;
      const bcn = b.className ?? "";
      if (!isInline) {
        // ReplyKeyboardMarkup 的 plain button — 顯示但不可點。
        normRow.push({ text, kind: "other" });
        continue;
      }
      if (bcn === "KeyboardButtonCallback") {
        // data 是 bytes — base64 編碼以便 JSON / HTTP round-trip。
        let dataB64 = "";
        if (b.data != null) {
          if (typeof b.data === "string") {
            dataB64 = Buffer.from(b.data, "binary").toString("base64");
          } else {
            dataB64 = Buffer.from(b.data).toString("base64");
          }
        }
        normRow.push({ text, kind: "callback", data: dataB64 });
      } else if (bcn === "KeyboardButtonUrl") {
        normRow.push({
          text,
          kind: "url",
          url: typeof b.url === "string" ? b.url : "",
        });
      } else {
        // KeyboardButtonBuy / Game / SwitchInline / UrlAuth / RequestPhone… — MVP 不支援
        normRow.push({ text, kind: "other" });
      }
    }
    if (normRow.length > 0) rows.push(normRow);
  }
  if (rows.length === 0) return undefined;
  return { type: isInline ? "inline" : "reply", rows };
}

/**
 * P2: TG 轉發來源 metadata。從 message.fwdFrom (MessageFwdHeader) 抽出。
 *
 * 持久化到 DCM.forwardedFrom 的 JSON 欄位;UI 顯示「Forwarded from X」header。
 */
export type ForwardedFromMeta = {
  /** 顯示名稱(個人轉發 = first+last;頻道轉發 = channel title;隱藏轉發 = fwdFrom.fromName) */
  senderName?: string;
  /** 原始發送者 TG user id(個人轉發才有) */
  senderPlatformUserId?: string;
  /** 頻道標題(channel post 轉發才有) */
  channelTitle?: string;
  /** 頻道 TG id(channel post 轉發才有) */
  channelPlatformId?: string;
  /** 原始訊息 id(channel post 轉發才有 fwdFrom.channelPost) */
  originalMessageId?: string;
  /** 原始發送時間 ISO string */
  date?: string;
};

/**
 * Bytes-less media payload (LOCATION / CONTACT / POLL).
 *
 * 持久化到 DCM.mediaMetadata 的 JSON 欄位; byte 類型(IMAGE/VIDEO/...) 仍走
 * mediaUrl,不會塞這欄。
 */
export type MediaMetadata = {
  geo?: {
    lat: number;
    lng: number;
    /** 若是 GeoLive,分享期間(秒)。 */
    livePeriod?: number;
  };
  contact?: {
    firstName?: string;
    lastName?: string;
    phone?: string;
    /** 對方在 TG 的 userId(若有),供 user-profile-modal 相連。 */
    userId?: string;
  };
  poll?: {
    question: string;
    options: Array<{ text: string; voters?: number }>;
    totalVoters?: number;
    closed?: boolean;
  };
  /** P3:TG 動畫表情(🎲🎯🏀⚽🎰)的「擲出值」。value 範圍依 emoticon 不同
   *  (🎲=1~6,🎰=1~64,🎯/🏀/⚽=1~5)。我們只展示結果,不重跑 TG 動畫。 */
  dice?: { emoticon: string; value: number };
  /** P3:TG MessageMediaStory — 對方轉發了 24h 故事。原內容可能已過期,我們
   *  只保 reference,UI 顯示 placeholder 而非試圖渲染。 */
  story?: { storyId: number; peerId?: string; expired?: boolean };
};

export type MessageCallback = (params: {
  accountId: string;
  chatId: string;
  chatTitle: string;
  senderId: string;
  senderName: string;
  text: string;
  messageId: number;
  /** Platform message ID of the message being replied to, if this is a reply. */
  replyToMessageId: number | null;
  date: Date;
  isOutgoing: boolean;
  messageType: 'TEXT' | 'IMAGE' | 'DOCUMENT' | 'AUDIO' | 'VIDEO' | 'STICKER' | 'VOICE' | 'VIDEO_NOTE' | 'LOCATION' | 'CONTACT' | 'POLL' | 'DICE' | 'STORY';
  mediaInfo?: {
    mimeType: string;
    fileName?: string;
    fileSize?: number;
    buffer?: Buffer;
  };
  /** Bytes-less payload — LOCATION / CONTACT / POLL 走這欄。 */
  metadata?: MediaMetadata;
  /** P2: 若這則是 TG 轉發訊息,帶來源 metadata。原生訊息為 undefined。 */
  forwardedFrom?: ForwardedFromMeta;
  /** P2: TG forum topic id (supergroup with forum 才有);非 forum 群組為 undefined。 */
  topicId?: number;
  /** P3: Channel post 觀看數(只 broadcast channel 才會有)。 */
  viewCount?: number;
  /** P3: TG quote reply 引用片段。一般回覆為 undefined。 */
  quoteText?: string;
  /**
   * 2026-05-21 TG parity:Message entities (Bold / Italic / Spoiler / Blockquote
   * / Mention / CustomEmoji / TextUrl / Code / Pre 等)。
   * 已 normalize 過,直接是 plain JSON;UI 拿來 entity-walking render。
   * undefined = 純文字無格式。
   */
  entities?: NormalizedMessageEntity[];
  /**
   * 2026-05-21 TG parity:Album / media group id。TG client 端「一次送 N 張」
   * 時 N 筆 message 共享同一個 grouped_id。
   * 我們存字串避免 JS Number 精度損失;undefined = 不屬於 album。
   */
  groupedId?: string;
  /**
   * 2026-05-21 訊息按鈕:正規化後的 inline keyboard。
   * bot / 服務帳號訊息常帶;undefined = 沒按鈕。
   */
  replyMarkup?: NormalizedReplyMarkup;
}) => Promise<void>;

/**
 * Normalized message entity shape — bridge 從 TL constructor 轉成這個格式儲存。
 * type 命名跟 TG Bot API 對齊(snake_case 去掉 MessageEntity 前綴),方便日後接其他客戶端。
 */
export type NormalizedMessageEntity = {
  type:
    | "bold" | "italic" | "underline" | "strikethrough" | "spoiler"
    | "code" | "pre" | "blockquote"
    | "mention" | "mention_name"
    | "text_url" | "url" | "email" | "phone" | "hashtag" | "cashtag"
    | "bot_command" | "custom_emoji" | "bank_card";
  offset: number;
  length: number;
  /** text_url → 連結 URL */
  url?: string;
  /** mention_name → 被 mention 用戶的 TG user id */
  userId?: string;
  /** custom_emoji → 自訂 emoji 的 document id(TG Premium 才有) */
  documentId?: string;
  /** pre → 程式語言(可選) */
  language?: string;
};

type ManagedClient = {
  accountId: string;
  workspaceId: string;
  status: "connecting" | "connected" | "error" | "disconnected";
  client: TelegramClient;
  error?: string;
  lastUsed: number;
};

export type SendResult = {
  success: boolean;
  error?: string;
  /** Platform message ID on the target side after successful send. */
  sentMessageId?: string;
  /** If the chat was migrated to a supergroup, this holds the new chat ID */
  migratedToChatId?: string;
  /** If Telegram returned FLOOD_WAIT, the number of seconds to wait */
  floodWaitSeconds?: number;
};

export type NativeOutboundPayload =
  | { kind: "location"; lat: number; lng: number; livePeriod?: number }
  | { kind: "contact"; firstName: string; lastName?: string; phone: string; userId?: string }
  | {
      kind: "poll";
      question: string;
      options: string[];
      multipleChoice?: boolean;
      quiz?: boolean;
      correctOptionIndex?: number;
      anonymous?: boolean;
      closed?: boolean;
    }
  | { kind: "dice"; emoticon: "🎲" | "🎯" | "🏀" | "⚽" | "🎰" | "🎳" }
  | { kind: "story"; peerId: string; storyId: number };

export type NativeOutboundMetadata = {
  messageType: "LOCATION" | "CONTACT" | "POLL" | "DICE" | "STORY";
  content: string;
  mediaMetadata: Record<string, unknown>;
};

export type NativeSendResult = SendResult & NativeOutboundMetadata;

export type TelegramAdminAction =
  | { kind: "pin-message"; chatId: string; messageId: number; silent?: boolean; unpin?: boolean }
  | { kind: "dialog-pin"; chatId: string; pinned: boolean; folderId?: number }
  | { kind: "folder-update"; filterId: number; title: string; includeChatIds: string[]; pinnedChatIds?: string[]; excludeChatIds?: string[]; emoticon?: string }
  | { kind: "folder-delete"; filterId: number }
  | { kind: "channel-title"; chatId: string; title: string }
  | { kind: "channel-admin"; chatId: string; userId: string; rank?: string; rights: Record<string, boolean | undefined> };

function buildNativeOutboundMetadata(payload: NativeOutboundPayload): NativeOutboundMetadata {
  switch (payload.kind) {
    case "location":
      return {
        messageType: "LOCATION",
        content: "📍 位置",
        mediaMetadata: { geo: { lat: payload.lat, lng: payload.lng, ...(payload.livePeriod ? { livePeriod: payload.livePeriod } : {}) } },
      };
    case "contact":
      return {
        messageType: "CONTACT",
        content: `👤 ${payload.firstName}${payload.lastName ? ` ${payload.lastName}` : ""}`,
        mediaMetadata: { contact: { firstName: payload.firstName, lastName: payload.lastName, phone: payload.phone, userId: payload.userId } },
      };
    case "poll":
      return {
        messageType: "POLL",
        content: `📊 ${payload.question}`,
        mediaMetadata: { poll: { question: payload.question, options: payload.options.map((text) => ({ text })), totalVoters: 0, closed: payload.closed === true } },
      };
    case "dice":
      return { messageType: "DICE", content: payload.emoticon, mediaMetadata: { dice: { emoticon: payload.emoticon } } };
    case "story":
      return { messageType: "STORY", content: "📖 Telegram Story", mediaMetadata: { story: { peerId: payload.peerId, storyId: payload.storyId, expired: false } } };
  }
}


export type EditedMessageCallback = (params: {
  accountId: string;
  chatId: string | null;
  platformMessageId: string;
  newContent: string;
  /**
   * 2026-05-21:編輯後的 inline keyboard。bot 換頁 / 切換狀態時常只改按鈕,
   * 不改文字 — 不帶這個的話 Switchboard 端按鈕會 stale。
   * undefined = 此次編輯沒帶 replyMarkup 資訊(保守不動 DB 既有值);
   * null = 明確「按鈕被移除」。
   */
  replyMarkup?: NormalizedReplyMarkup | null;
}) => void | Promise<void>;

export type DeletedMessageCallback = (params: {
  accountId: string;
  chatId: string | null;
  platformMessageId: string;
}) => void | Promise<void>;

export type TypingCallback = (params: {
  /** Receiving account id (which of our accounts saw the typing event). */
  accountId: string;
  /** Chat id as string (negative for groups, -100xxxxxxxxx for supergroups). */
  platformGroupId: string;
  /** User id as string (positive number). */
  platformUserId: string;
}) => void | Promise<void>;

export type ChatTitleChangedCallback = (params: {
  accountId: string;
  chatId: string;
  newTitle: string;
}) => void | Promise<void>;

/** UI 用的 reaction 摘要：emoji + count + 「我（聽眾帳號）有沒有按」*/
export type ReactionSummary = {
  emoji: string;
  count: number;
  chosen: boolean;
};

export type ReactionChangedCallback = (params: {
  accountId: string;
  chatId: string;
  platformMessageId: string;
  reactions: ReactionSummary[];
}) => void | Promise<void>;

/**
 * 已讀回執 (2026-05-21 Backend-first):
 *   direction = "outbox" → 對方已讀「我方」的訊息(我們的 OUTBOUND);maxId 含到此 id 都算讀過。
 *   direction = "inbox"  → 「我方」已讀對方訊息(INBOUND 已被我們閱讀);UI 用於消除未讀 badge。
 * maxId 是 TG 的 message id(整數),DCM 用 platformMessageId(字串)比對時要轉型。
 */
export type ReadHistoryCallback = (params: {
  accountId: string;
  chatId: string;
  direction: "outbox" | "inbox";
  maxId: number;
}) => void | Promise<void>;

export class ClientManager {
  private static readonly MAX_CLIENTS = 100;
  private clients = new Map<string, ManagedClient>();
  private eventHandlers = new Map<string, (event: NewMessageEvent) => void>();
  private editedHandlers = new Map<string, (event: EditedMessageEvent) => void>();
  private deletedHandlers = new Map<string, (event: DeletedMessageEvent) => void>();
  private prisma: PrismaClient;
  private onMessage: MessageCallback | null = null;
  public onEditedMessage?: EditedMessageCallback;
  public onDeletedMessage?: DeletedMessageCallback;
  public onChatTitleChanged?: ChatTitleChangedCallback;
  public onTyping?: TypingCallback;
  public onReactionChanged?: ReactionChangedCallback;
  public onReadHistory?: ReadHistoryCallback;
  private healthCheckInterval: ReturnType<typeof setInterval> | null = null;

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
  }

  setMessageHandler(handler: MessageCallback) {
    this.onMessage = handler;
  }

  setEditedMessageHandler(handler: EditedMessageCallback) {
    this.onEditedMessage = handler;
  }

  setDeletedMessageHandler(handler: DeletedMessageCallback) {
    this.onDeletedMessage = handler;
  }

  setChatTitleChangedHandler(handler: ChatTitleChangedCallback) {
    this.onChatTitleChanged = handler;
  }

  setReadHistoryHandler(handler: ReadHistoryCallback) {
    this.onReadHistory = handler;
  }

  setReactionChangedHandler(handler: ReactionChangedCallback) {
    this.onReactionChanged = handler;
  }

  async loadAllAccounts() {
    const accounts = await this.prisma.communicationAccount.findMany({
      where: { status: "ACTIVE" },
      include: { telegramSession: true },
    });

    log.info("Found active accounts", { count: accounts.length });

    for (const account of accounts) {
      if (account.telegramSession) {
        await this.startOne(account.id);
      }
    }
  }

  async startOne(accountId: string) {
    // Stop existing client if any
    await this.stopOne(accountId);

    try {
      const account = await this.prisma.communicationAccount.findUnique({
        where: { id: accountId },
        include: { telegramSession: true },
      });

      if (!account?.telegramSession) {
        log.info("No session for account", { accountId });
        return;
      }

      const session = account.telegramSession;

      // Decrypt session string
      const sessionString = decrypt(
        session.encryptedSession,
        session.iv,
        session.authTag
      );

      log.info("Connecting account", { displayName: account.displayName });

      // Evict LRU client if pool is full
      if (this.clients.size >= ClientManager.MAX_CLIENTS) {
        let lruKey: string | null = null;
        let lruTime = Infinity;
        for (const [key, mc] of this.clients.entries()) {
          if ((mc.lastUsed ?? 0) < lruTime) {
            lruTime = mc.lastUsed ?? 0;
            lruKey = key;
          }
        }
        if (lruKey) {
          log.info("Evicting LRU client to make room", { accountId: lruKey });
          await this.stopOne(lruKey);
        }
      }

      const client = new TelegramClient(
        new StringSession(sessionString),
        session.apiId,
        session.apiHash,
        {
          connectionRetries: 5,
          autoReconnect: true,
          timeout: 30000,
        }
      );

      const now = Date.now();

      this.clients.set(accountId, {
        accountId,
        workspaceId: account.workspaceId,
        status: "connecting",
        client,
        lastUsed: now,
      });

      // Connect first, then register handler only on success (prevents event handler leak)
      await client.connect();

      const handler = (event: NewMessageEvent) => this.handleNewMessage(accountId, event);
      // 明確訂閱 incoming + outgoing — GramJS 的 NewMessage 預設會把 outgoing 過濾掉，
      // 結果我們收不到「自己人發的訊息」，導致直面 / 內部群對話頁看不到我方訊息、
      // 客戶引用我們的訊息時也找不到原文。設 outgoing: true 後 bridge 才能 archive OUTBOUND。
      client.addEventHandler(
        handler,
        new NewMessage({ incoming: true, outgoing: true }),
      );
      this.eventHandlers.set(accountId, handler);

      const editedHandler = (event: EditedMessageEvent) =>
        this.handleEditedMessage(accountId, event);
      client.addEventHandler(editedHandler, new EditedMessage({}));
      this.editedHandlers.set(accountId, editedHandler);

      const deletedHandler = (event: DeletedMessageEvent) =>
        this.handleDeletedMessages(accountId, event);
      client.addEventHandler(deletedHandler, new DeletedMessage({}));
      this.deletedHandlers.set(accountId, deletedHandler);

      // Raw updates: subscribe specifically to typing so we can surface
      // "X is typing…" in the UI. Registering with `types:` scopes the
      // firehose to the two update classes we care about; any other raw
      // update is skipped before reaching our handler. Events are fire-
      // and-forget — typing is purely informational, errors shouldn't
      // crash the bridge.
      const typingHandler = (update: Api.TypeUpdate) => {
        try {
          this.handleTypingUpdate(accountId, update);
        } catch (err) {
          log.warn("Typing handler error", { accountId, error: String(err).slice(0, 200) });
        }
      };
      client.addEventHandler(
        typingHandler,
        new Raw({
          types: [
            Api.UpdateUserTyping,
            Api.UpdateChatUserTyping,
            Api.UpdateChannelUserTyping,
          ],
        }),
      );

      // Reactions：updateMessageReactions 對 1:1 / 小群 / 私訊用；
      // 對 megagroup / channel TG 還會送 updateBotMessageReactions（即使我們
      // 不是 bot — 這是 layer 198 的歷史包袱）以及包在 updateChannelMessageViews
      // 裡的 reaction count 增量。我們監聽前兩個就夠了。
      //
      // 註：昨天觀察到我方帳號自己對自己 OUTBOUND 訊息加 reaction 後，bridge
      // 完全收不到 echo（log 沒任何 reaction event）。這個 listener 註冊看起來
      // 沒問題，所以加 instrumentation 來釐清是「沒收到」還是「收到但被 filter
      // 過濾掉」— DIAGNOSTIC handler 訂閱所有 Raw 更新並只 log 跟 reaction
      // 相關 className 的，不會輸出 typing/onlineStatus 等高頻事件。
      const reactionHandler = (update: Api.TypeUpdate) => {
        try {
          this.handleReactionUpdate(accountId, update);
        } catch (err) {
          log.warn("Reaction handler error", { accountId, error: String(err).slice(0, 200) });
        }
      };
      client.addEventHandler(
        reactionHandler,
        new Raw({
          types: [Api.UpdateMessageReactions, Api.UpdateBotMessageReactions],
        }),
      );

      // 已讀回執 (2026-05-21 Backend-first):
      // - UpdateReadHistoryOutbox 對方讀了「我方」訊息 → DCM.readAt
      // - UpdateReadHistoryInbox  「我方」讀了對方訊息 → DCM.deliveredAt (對應「我看過 INBOUND 了」)
      // - UpdateReadChannelOutbox / UpdateReadChannelInbox 是 channel/megagroup 版本
      const readHistoryHandler = (update: Api.TypeUpdate) => {
        try {
          this.handleReadHistoryUpdate(accountId, update);
        } catch (err) {
          log.warn("Read history handler error", {
            accountId,
            error: String(err).slice(0, 200),
          });
        }
      };
      client.addEventHandler(
        readHistoryHandler,
        new Raw({
          types: [
            Api.UpdateReadHistoryOutbox,
            Api.UpdateReadHistoryInbox,
            Api.UpdateReadChannelOutbox,
            Api.UpdateReadChannelInbox,
          ],
        }),
      );

      this.clients.set(accountId, {
        accountId,
        workspaceId: account.workspaceId,
        status: "connected",
        client,
        lastUsed: now,
      });

      // Update last connected time
      await this.prisma.telegramSession.update({
        where: { accountId },
        data: { lastConnectedAt: new Date() },
      });

      await this.prisma.communicationAccount.update({
        where: { id: accountId },
        data: { status: "ACTIVE" },
      });

      log.info("Connected", { displayName: account.displayName });
    } catch (error) {
      log.error("Failed to start account", { accountId, error: String(error) });

      const existing = this.clients.get(accountId);
      if (existing) {
        existing.status = "error";
        existing.error = String(error);
      }

      // Mark the account as AUTH_ERROR so the UI reflects the failure.
      // This also covers session-decryption failures (e.g. rotated key,
      // corrupted ciphertext) which otherwise silently leave the account
      // "ACTIVE" with no running client.
      await this.prisma.communicationAccount.update({
        where: { id: accountId },
        data: { status: "AUTH_ERROR" },
      }).catch((err) => {
        log.error("Failed to mark account AUTH_ERROR", { accountId, err: String(err) });
      });
    }
  }

  private async handleNewMessage(
    accountId: string,
    event: NewMessageEvent
  ) {
    try {
      const managed = this.clients.get(accountId);
      if (managed) managed.lastUsed = Date.now();

      const message = event.message;
      if (!message || !message.chatId) return;

      // Skip messages from ourselves (outgoing)
      const isOutgoing = message.out ?? false;

      const chatId = message.chatId.toString();

      // Service messages (action messages): title change, member join/leave, etc.
      // We only care about title changes here; fire the rename callback and stop.
      const action = (message as unknown as { action?: { className?: string; title?: string } }).action;
      if (action && typeof action.className === "string") {
        const isTitleChange =
          action.className === "MessageActionChatEditTitle" ||
          action.className === "MessageActionChannelEditTitle";
        if (isTitleChange && typeof action.title === "string" && action.title.length > 0) {
          if (this.onChatTitleChanged) {
            try {
              await this.onChatTitleChanged({
                accountId,
                chatId,
                newTitle: action.title,
              });
            } catch (err) {
              log.error("ChatTitleChanged handler failed", { accountId, err: String(err) });
            }
          }
        }
        // Service messages are not forwarded as regular content.
        return;
      }

      const senderId = message.senderId?.toString() || "";
      const text = message.text || "";

      // Get chat title
      let chatTitle = "";
      try {
        const managed = this.clients.get(accountId);
        if (managed) {
          const entity = await managed.client.getEntity(message.chatId);
          chatTitle =
            "title" in entity
              ? (entity.title as string) || ""
              : "firstName" in entity
                ? (entity.firstName as string) || ""
                : "";
        }
      } catch {
        chatTitle = `Chat ${chatId}`;
      }

      // Get sender name
      let senderName = "";
      if (message.senderId) {
        try {
          const managed = this.clients.get(accountId);
          if (managed) {
            const sender = await managed.client.getEntity(message.senderId);
            senderName =
              "firstName" in sender
                ? `${(sender.firstName as string) || ""} ${(sender.lastName as string) || ""}`.trim()
                : "title" in sender
                  ? (sender.title as string) || ""
                  : "";
          }
        } catch {
          senderName = `User ${senderId}`;
        }
      }

      // Determine message type and handle media — 用共用 helper(P0
      // 2026-05-20 後 helper 不只下載 bytes,還會偵測 LOCATION / CONTACT /
      // POLL 等 bytes-less 類型,並區分 VOICE / VIDEO_NOTE / Sticker / GIF。
      let messageType: 'TEXT' | 'IMAGE' | 'DOCUMENT' | 'AUDIO' | 'VIDEO' | 'STICKER' | 'VOICE' | 'VIDEO_NOTE' | 'LOCATION' | 'CONTACT' | 'POLL' | 'DICE' | 'STORY' = 'TEXT';
      let mediaInfo: MediaInfo | undefined = undefined;
      let metadata: MediaMetadata | undefined = undefined;

      if (message.media) {
        const managed = this.clients.get(accountId);
        if (managed) {
          const extracted = await this.extractMessageMedia(managed.client, message);
          messageType = extracted.messageType;
          mediaInfo = extracted.mediaInfo;
          metadata = extracted.metadata;
        }
      }

      // Extract reply-to info. GramJS exposes `replyToMsgId` on the message
      // when the user replied to an earlier message. The `replyTo` object
      // (MessageReplyHeader) is the modern shape; fall back to either.
      let replyToMessageId: number | null = null;
      const msgAny = message as unknown as {
        replyToMsgId?: number | bigint | null;
        replyTo?: {
          replyToMsgId?: number | bigint | null;
          quoteText?: string;
        } | null;
      };
      const rawReplyId =
        msgAny.replyToMsgId ?? msgAny.replyTo?.replyToMsgId ?? null;
      if (rawReplyId != null) {
        const asNum = typeof rawReplyId === "bigint" ? Number(rawReplyId) : rawReplyId;
        if (typeof asNum === "number" && Number.isFinite(asNum) && asNum > 0) {
          replyToMessageId = asNum;
        }
      }
      // P3 quote reply — TG 2023+ 新功能,replyTo.quoteText 是用戶選的引用片段。
      const replyToQuoteText = (msgAny.replyTo as unknown as { quoteText?: string } | null | undefined)
        ?.quoteText;
      const quoteText =
        typeof replyToQuoteText === "string" && replyToQuoteText.length > 0
          ? replyToQuoteText
          : undefined;

      // P2: 轉發來源 — TG 的 MessageFwdHeader,只在轉發訊息上有值。
      // fromId 可能是 PeerUser / PeerChannel / PeerChat。我們抽用得到的位掉。
      const forwardedFrom = extractForwardedFrom(
        (message as unknown as { fwdFrom?: unknown }).fwdFrom,
      );

      // P2 forum topic — TG message.replyTo.forumTopic + replyTo.replyToTopId。
      // 在 forum-enabled supergroup 內訊息會帶這個欄位;General topic 通常
      // 沒明確 id 或為 1,這裡保守:有非零的就存。
      const topicReplyTo = (message as unknown as {
        replyTo?: { forumTopic?: boolean; replyToTopId?: number | bigint };
      }).replyTo;
      let topicId: number | undefined;
      if (topicReplyTo?.forumTopic && topicReplyTo.replyToTopId != null) {
        const t =
          typeof topicReplyTo.replyToTopId === "bigint"
            ? Number(topicReplyTo.replyToTopId)
            : topicReplyTo.replyToTopId;
        if (Number.isFinite(t) && t > 0) topicId = t;
      }

      // P3 view count — TG broadcast channel posts have a `views` integer
      // 紀錄誰看了 post。普通群組 / 私訊永遠 null。
      const rawViews = (message as unknown as { views?: number | null }).views;
      const viewCount =
        typeof rawViews === "number" && rawViews >= 0 ? rawViews : undefined;

      // 2026-05-21 TG parity:Message entities + Album grouped_id 提取。
      // entities 來自 message.entities;groupedId 在 GramJS 物件上是 bigint,
      // 轉字串避免 JSON.stringify 失敗(JS Number 對 long 會掉精度)。
      const entities = normalizeEntities(
        (message as unknown as { entities?: unknown[] }).entities,
      );
      const rawGroupedId = (message as unknown as { groupedId?: bigint | number | null })
        .groupedId;
      const groupedId =
        rawGroupedId != null && rawGroupedId !== 0
          ? typeof rawGroupedId === "bigint"
            ? rawGroupedId.toString()
            : String(rawGroupedId)
          : undefined;
      // 2026-05-21 訊息按鈕:bot / 服務帳號訊息的 inline keyboard。
      const replyMarkup = normalizeReplyMarkup(
        (message as unknown as { replyMarkup?: unknown }).replyMarkup,
      );

      if (this.onMessage) {
        await this.onMessage({
          accountId,
          chatId,
          chatTitle,
          senderId,
          senderName,
          text,
          messageId: message.id,
          replyToMessageId,
          date: new Date((message.date || 0) * 1000),
          isOutgoing,
          messageType,
          mediaInfo,
          metadata,
          forwardedFrom,
          topicId,
          viewCount,
          quoteText,
          entities,
          groupedId,
          replyMarkup,
        });
      }
    } catch (error) {
      log.error("Error handling message", { accountId, error: String(error) });
    }
  }

  private async handleEditedMessage(
    accountId: string,
    event: EditedMessageEvent,
  ) {
    try {
      const managed = this.clients.get(accountId);
      if (managed) managed.lastUsed = Date.now();

      const message = event.message;
      if (!message) return;
      if (message.out) return; // skip our own edits

      const chatId = message.chatId ? message.chatId.toString() : null;
      // 2026-05-21:移除舊的「只處理群組、跳過 1:1 私訊」guard。那是 broker
      // 時代的限制(broker 只做群組轉發)。broker-strip 後 Switchboard archive 所有
      // 對話 — 私訊 / bot 對話的編輯也要同步,否則 bot 換頁更新 inline keyboard
      // 時 Switchboard 端的按鈕會 stale。
      if (!chatId) return;

      const platformMessageId = message.id.toString();
      const newContent = message.text || message.message || "";
      // 2026-05-21 訊息按鈕:編輯後的 inline keyboard。
      // message 沒有 replyMarkup 屬性時 → undefined(保守);明確 null → 按鈕被移除。
      const rawMarkup = (message as unknown as { replyMarkup?: unknown }).replyMarkup;
      const replyMarkup =
        rawMarkup === undefined
          ? undefined
          : (normalizeReplyMarkup(rawMarkup) ?? null);

      if (this.onEditedMessage) {
        await this.onEditedMessage({
          accountId,
          chatId,
          platformMessageId,
          newContent,
          replyMarkup,
        });
      }
    } catch (error) {
      log.error("Error handling edited message", { accountId, error: String(error) });
    }
  }

  /**
   * Receives Telegram typing updates and surfaces them through onTyping.
   *
   * Two update flavors we care about:
   *   - UpdateUserTyping: 1:1 chat — user is typing in a PM with the account
   *   - UpdateChatUserTyping: group chat — some user in a group is typing
   *
   * For broker use we only care about group typing; 1:1 typing is for the
   * direct-chat surface where the account is one peer and the customer is
   * the other. We emit both; consumers decide whether to display.
   */
  private handleTypingUpdate(accountId: string, update: Api.TypeUpdate) {
    if (!this.onTyping) return;
    // Narrow to the two typing classes via instanceof (more robust than
    // className string comparison across GramJS versions).
    if (update instanceof Api.UpdateChatUserTyping) {
      const chatIdRaw = update.chatId?.toString();
      const fromId = (update.fromId as Api.TypePeer | undefined) ?? null;
      const userIdRaw = fromId instanceof Api.PeerUser ? fromId.userId?.toString() : null;
      if (!chatIdRaw || !userIdRaw) return;
      // Basic group chat ids come in without the -100 prefix; prepend -
      // to keep the caller's format consistent with platformGroupId.
      const platformGroupId = chatIdRaw.startsWith("-") ? chatIdRaw : `-${chatIdRaw}`;
      void this.onTyping({ accountId, platformGroupId, platformUserId: userIdRaw });
    } else if (update instanceof Api.UpdateUserTyping) {
      const userIdRaw = update.userId?.toString();
      if (!userIdRaw) return;
      // 1:1 typing — use the peer user id as the "group" id so the direct-chat
      // UI can match on it; clients of onTyping can check whether the group
      // is actually a 1:1 peer via their own data.
      void this.onTyping({ accountId, platformGroupId: userIdRaw, platformUserId: userIdRaw });
    } else if (update instanceof Api.UpdateChannelUserTyping) {
      // Supergroup/channel typing. channelId is a big int without -100 prefix
      // but our platformGroupId convention stores these as -100<channelId>.
      const channelRaw = update.channelId?.toString();
      const fromId = (update.fromId as Api.TypePeer | undefined) ?? null;
      const userIdRaw = fromId instanceof Api.PeerUser ? fromId.userId?.toString() : null;
      if (!channelRaw || !userIdRaw) return;
      const platformGroupId = `-100${channelRaw}`;
      void this.onTyping({ accountId, platformGroupId, platformUserId: userIdRaw });
    }
  }

  /**
   * 處理 TG `updateMessageReactions` 事件。
   *
   * MTProto payload：
   *   - peer: TypePeer（PeerUser / PeerChat / PeerChannel）
   *   - msg_id: int
   *   - reactions: MessageReactions
   *       - results: Vector<ReactionCount>
   *           - reaction: TypeReaction（ReactionEmoji / ReactionCustomEmoji）
   *           - count: int
   *           - chosen_order: 有設代表「我（這個 listening 帳號）按過」
   *
   * 對 ReactionCustomEmoji（premium / sticker pack 自訂 emoji）我們現階段
   * 不支援 — 只取 ReactionEmoji 的 emoticon 字串。其他類型靜默 skip。
   */
  private handleReactionUpdate(accountId: string, update: Api.TypeUpdate) {
    if (!this.onReactionChanged) return;
    // 我們同時支援 UpdateMessageReactions 跟 UpdateBotMessageReactions —
    // megagroup 場景 TG 會送後者（即使我們不是 bot，是 layer 198 的歷史行為）。
    if (
      !(update instanceof Api.UpdateMessageReactions) &&
      !(update instanceof Api.UpdateBotMessageReactions)
    ) {
      return;
    }

    const peer = update.peer;
    let chatId: string | null = null;
    if (peer instanceof Api.PeerUser) {
      chatId = peer.userId?.toString() ?? null;
    } else if (peer instanceof Api.PeerChat) {
      const raw = peer.chatId?.toString();
      chatId = raw ? (raw.startsWith("-") ? raw : `-${raw}`) : null;
    } else if (peer instanceof Api.PeerChannel) {
      const raw = peer.channelId?.toString();
      chatId = raw ? `-100${raw}` : null;
    }
    if (!chatId) return;

    const msgIdRaw = update.msgId;
    const platformMessageId = msgIdRaw != null ? String(msgIdRaw) : null;
    if (!platformMessageId) return;

    // Shape 差異：
    //   UpdateMessageReactions.reactions:    MessageReactions { results: ReactionCount[] }
    //   UpdateBotMessageReactions.reactions: ReactionCount[]（直接是陣列）
    let results: Array<{
      reaction?: unknown;
      count?: number;
      chosenOrder?: number;
    }> = [];
    if (update instanceof Api.UpdateMessageReactions) {
      results = update.reactions?.results ?? [];
    } else if (update instanceof Api.UpdateBotMessageReactions) {
      // gramjs 6.x 把 reactions 標成 Vector<ReactionCount>
      results = (update.reactions as unknown as typeof results) ?? [];
    }
    const reactions: ReactionSummary[] = [];
    for (const r of results) {
      const reaction = r.reaction;
      let emoji: string | null = null;
      if (reaction instanceof Api.ReactionEmoji) {
        emoji = reaction.emoticon ?? null;
      }
      // ReactionCustomEmoji（自訂貼圖 emoji）暫不支援 — 跳過。
      // ReactionPaid（付費 reaction）也跳過。
      if (!emoji) continue;
      const count = typeof r.count === "number" ? r.count : 0;
      const chosen = typeof r.chosenOrder === "number"; // 有 chosenOrder = listener 按過
      reactions.push({ emoji, count, chosen });
    }

    void this.onReactionChanged({
      accountId,
      chatId,
      platformMessageId,
      reactions,
    });
  }

  /**
   * 已讀回執 raw handler — TG 把對方讀到哪 / 我方讀到哪「整批」用 maxId 回告,
   * 而不是一筆一筆通知。bridge 收到後依 direction 改 DCM.readAt / deliveredAt。
   *
   * 不同 update 變體的 peer/maxId 抽取邏輯:
   *   - UpdateReadHistoryOutbox : peer (Peer), maxId
   *   - UpdateReadHistoryInbox  : peer (Peer), maxId
   *   - UpdateReadChannelOutbox : channelId (long),  maxId    (megagroup/channel)
   *   - UpdateReadChannelInbox  : channelId (long),  maxId    (megagroup/channel)
   */
  private handleReadHistoryUpdate(accountId: string, update: Api.TypeUpdate) {
    if (!this.onReadHistory) return;

    let chatId: string | null = null;
    let direction: "outbox" | "inbox" | null = null;
    let maxId: number | null = null;

    if (update instanceof Api.UpdateReadHistoryOutbox) {
      direction = "outbox";
      maxId = update.maxId;
      const peer = update.peer;
      if (peer instanceof Api.PeerUser) {
        chatId = peer.userId?.toString() ?? null;
      } else if (peer instanceof Api.PeerChat) {
        const raw = peer.chatId?.toString();
        chatId = raw ? (raw.startsWith("-") ? raw : `-${raw}`) : null;
      } else if (peer instanceof Api.PeerChannel) {
        const raw = peer.channelId?.toString();
        chatId = raw ? `-100${raw}` : null;
      }
    } else if (update instanceof Api.UpdateReadHistoryInbox) {
      direction = "inbox";
      maxId = update.maxId;
      const peer = update.peer;
      if (peer instanceof Api.PeerUser) {
        chatId = peer.userId?.toString() ?? null;
      } else if (peer instanceof Api.PeerChat) {
        const raw = peer.chatId?.toString();
        chatId = raw ? (raw.startsWith("-") ? raw : `-${raw}`) : null;
      } else if (peer instanceof Api.PeerChannel) {
        const raw = peer.channelId?.toString();
        chatId = raw ? `-100${raw}` : null;
      }
    } else if (update instanceof Api.UpdateReadChannelOutbox) {
      direction = "outbox";
      maxId = update.maxId;
      const raw = update.channelId?.toString();
      chatId = raw ? `-100${raw}` : null;
    } else if (update instanceof Api.UpdateReadChannelInbox) {
      direction = "inbox";
      maxId = update.maxId;
      const raw = update.channelId?.toString();
      chatId = raw ? `-100${raw}` : null;
    }

    if (!chatId || direction == null || maxId == null) return;

    void this.onReadHistory({ accountId, chatId, direction, maxId });
  }

  private async handleDeletedMessages(
    accountId: string,
    event: DeletedMessageEvent,
  ) {
    try {
      const managed = this.clients.get(accountId);
      if (managed) managed.lastUsed = Date.now();

      // event.deletedIds is an array of numeric Telegram message ids
      const deletedIds: number[] = Array.isArray(event.deletedIds) ? event.deletedIds : [];
      // peer is only populated for channel/supergroup deletes; for small
      // groups/private chats the chat is unknown (GramJS limitation).
      let chatId: string | null = null;
      const peer = (event as unknown as { peer?: TgPeerLike }).peer;
      if (peer) {
        if (peer.channelId != null) {
          // Channel IDs are presented with a -100 prefix in GramJS conventions
          const rawId = peer.channelId.toString();
          chatId = rawId.startsWith("-100") ? rawId : `-100${rawId}`;
        } else if (peer.chatId != null) {
          const rawId = peer.chatId.toString();
          chatId = rawId.startsWith("-") ? rawId : `-${rawId}`;
        }
      }

      if (!this.onDeletedMessage) return;

      for (const id of deletedIds) {
        await this.onDeletedMessage({
          accountId,
          chatId,
          platformMessageId: id.toString(),
        });
      }
    } catch (error) {
      log.error("Error handling deleted messages", { accountId, error: String(error) });
    }
  }

  private getMimeTypeFromMedia(media: unknown): string {
    const m = (media && typeof media === "object" ? (media as TgMediaLike) : {});
    if (m.document?.mimeType) {
      return m.document.mimeType;
    }
    if (m.className?.includes('Photo')) {
      return 'image/jpeg';
    }
    return 'application/octet-stream';
  }

  private getFileNameFromMedia(media: unknown): string {
    const m = (media && typeof media === "object" ? (media as TgMediaLike) : {});
    if (m.document?.attributes) {
      for (const attr of m.document.attributes) {
        if (attr.fileName) {
          return attr.fileName;
        }
      }
    }
    if (m.className?.includes('Photo')) {
      return `image_${Date.now()}.jpg`;
    }
    return `file_${Date.now()}`;
  }

  /**
   * 取得帳號當前 client 狀態，給 API 查詢用（前端 poll 時不用 throw）
   * 回傳: "connected" | "connecting" | "not_loaded" | "disconnected"
   */
  getAccountStatus(accountId: string): "connected" | "connecting" | "not_loaded" | "disconnected" {
    const managed = this.clients.get(accountId);
    if (!managed) return "not_loaded";
    return managed.status as "connected" | "connecting" | "disconnected";
  }

  /**
   * 確保帳號 client 已連線；如果還沒載入則自動 startOne。
   * 完成或失敗後回傳布林值，呼叫端可重試 / 報錯。
   */
  async ensureConnected(accountId: string, timeoutMs = 30000): Promise<boolean> {
    const status = this.getAccountStatus(accountId);
    if (status === "connected") return true;

    // 還沒載入 → 主動 startOne 並等待
    if (status === "not_loaded") {
      log.info("Account not loaded, starting client", { accountId });
      try {
        await this.startOne(accountId);
      } catch (err) {
        log.error("ensureConnected: startOne failed", { accountId, error: String(err) });
        return false;
      }
    }

    // 在 connecting 狀態 → 輪詢等到 connected 或 timeout
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const s = this.getAccountStatus(accountId);
      if (s === "connected") return true;
      if (s === "not_loaded" || s === "disconnected") return false;
      await new Promise((r) => setTimeout(r, 500));
    }
    log.warn("ensureConnected: timeout", { accountId });
    return false;
  }

  async discoverGroups(accountId: string) {
    // 自我修復：未連線時嘗試自動 startOne 並等待
    const ok = await this.ensureConnected(accountId);
    if (!ok) {
      const status = this.getAccountStatus(accountId);
      log.warn("discoverGroups: account not ready", { accountId, status });
      throw new Error(
        `帳號未連線（狀態: ${status}）。可能仍在連線中或 session 失效，請稍後重試或重新連線該帳號。`
      );
    }

    const managed = this.clients.get(accountId)!;
    const groups: {
      platformGroupId: string;
      title: string;
      chatType: "GROUP" | "CHANNEL" | "PRIVATE";
    }[] = [];

    try {
      const dialogs = await managed.client.getDialogs({ limit: 200 });

      for (const dialog of dialogs) {
        const chatId = dialog.id?.toString();
        if (!chatId) continue;

        // Spec 2026-04-24: PRIVATE 1:1 chats are now discoverable too. The
        // sync preview modal lists them alongside groups/channels; the user
        // ticks which ones to actually register. The bridge archival path
        // handles inbound PRIVATE messages identically to unpaired groups.
        let chatType: "GROUP" | "CHANNEL" | "PRIVATE";
        let title: string;
        if (dialog.isUser) {
          chatType = "PRIVATE";
          title = dialog.title || `User ${chatId}`;
        } else if (dialog.isChannel) {
          // GramJS isChannel 對「超級群組」跟「廣播頻道」都回 true。
          // 兩者要靠 entity.megagroup 才分得出來：
          //   megagroup=true  → 超級群組 (多人聊天) → 我們系統把它當 GROUP
          //   megagroup=false → 純廣播頻道 → CHANNEL
          // 拿不到 entity.megagroup 時保守回 GROUP（CS 用途幾乎都是群組）
          const entity = (dialog as unknown as { entity?: { megagroup?: boolean; broadcast?: boolean } })
            .entity;
          if (entity?.broadcast === true && entity?.megagroup !== true) {
            chatType = "CHANNEL";
          } else {
            chatType = "GROUP";
          }
          title = dialog.title || `Chat ${chatId}`;
        } else if (dialog.isGroup) {
          chatType = "GROUP";
          title = dialog.title || `Chat ${chatId}`;
        } else {
          // Fallback by id shape — 一律當 GROUP（避免再因為 -100 開頭誤判 CHANNEL）
          if (chatId.startsWith("-")) chatType = "GROUP";
          else chatType = "PRIVATE";
          title = dialog.title || `Chat ${chatId}`;
        }

        groups.push({
          platformGroupId: chatId,
          title,
          chatType,
        });
      }

      log.info("Discovered chats", { count: groups.length, accountId });
    } catch (error) {
      // 改成 throw 讓上層（HTTP endpoint）能回應給前端，UI 可顯示真實錯誤
      log.error("Chat discovery failed", { accountId, error: String(error) });
      throw new Error(
        `Telegram 對話列表抓取失敗：${error instanceof Error ? error.message : String(error)}`
      );
    }

    return groups;
  }

  async sendMessage(
    accountId: string,
    chatId: string,
    text: string,
    replyToMsgId?: number | null,
    parseMode?: "html" | "markdown" | null,
    /**
     * P3 排程發送 — Unix timestamp (秒) 表示「到這個時間才實際發送」。
     * 必須是未來時間且離現在至少 10 秒(TG 對排程的硬性下限)。傳 null/undefined
     * 等同立刻發送。GramJS 直接把 scheduleDate 帶到 messages.SendMessage。
     */
    scheduleDate?: number | null,
    /**
     * 2026-05-21 TG parity — Quote-reply on send。
     * 員工選原訊息一段文字當 "引用片段"。TG client 端拖選後送出時帶這幾欄。
     * 必須同時提供 quoteText + quoteOffset(原文字串中片段起始位置);
     * quoteEntities 可選 — 引用片段內若有格式化,送同步格式化資料。
     * 沒帶 = 一般 reply(舊 replyToMsgId only 行為)。
     */
    quote?: {
      quoteText: string;
      quoteOffset: number;
      quoteEntities?: NormalizedMessageEntity[];
    } | null,
    topicId?: number | null,
  ): Promise<SendResult> {
    const managed = this.clients.get(accountId);
    if (!managed || managed.status !== "connected") {
      log.error("Cannot send: account not connected", { accountId });
      return { success: false, error: "Account not connected" };
    }

    try {
      managed.lastUsed = Date.now();
      const validScheduleDate =
        scheduleDate != null &&
        Number.isFinite(scheduleDate) &&
        scheduleDate > Math.floor(Date.now() / 1000) + 5
          ? Math.floor(scheduleDate)
          : undefined;

      // Resolve peer first(無論走哪條路徑都要 InputPeer)。
      let peer: Parameters<typeof managed.client.sendMessage>[0] = chatId;
      try {
        peer = await managed.client.getInputEntity(chatId);
      } catch (resolveErr) {
        log.warn("Peer resolution failed, falling back to raw chatId", {
          accountId,
          chatId,
          error: String(resolveErr).slice(0, 200),
        });
      }

      const validTopicId =
        topicId != null && Number.isFinite(topicId) && topicId > 0
          ? Math.floor(topicId)
          : null;

      // 2026-05-21 TG parity:Quote-reply 路徑 — GramJS 的 high-level
      // `client.sendMessage` 只接受 `replyTo: number | Message`,不認 InputReplyToMessage,
      // 所以帶 quote 時改走低階 `client.invoke(new Api.messages.SendMessage(...))`,
      // 對應 TL method `messages.sendMessage`,可以直接餵 InputReplyToMessage。
      const hasQuote =
        replyToMsgId != null &&
        Number.isFinite(replyToMsgId) &&
        replyToMsgId > 0 &&
        quote != null &&
        quote.quoteText.length > 0;

      if (hasQuote && (peer as Api.TypeInputPeer)) {
        // randomId — GramJS sendMessage 平常會 auto-generate;我們走低階 invoke
        // 自己給。用 bigInt(Math.random) 在 53-bit 範圍內 — 跟 GramJS 預設邏輯一致。
        const bigInt = (await import("big-integer")).default;
        const randomId = bigInt(Math.floor(Math.random() * Number.MAX_SAFE_INTEGER));
        const inputReplyTo = new Api.InputReplyToMessage({
          replyToMsgId: replyToMsgId!,
          ...(validTopicId != null ? { topMsgId: validTopicId } : {}),
          quoteText: quote!.quoteText,
          quoteOffset: Number.isFinite(quote!.quoteOffset) ? quote!.quoteOffset : 0,
          // quoteEntities 暫不送(MVP 純文字 quote);UI 端 quote 取出時也只是純文字選取。
        });
        const result = await managed.client.invoke(
          new Api.messages.SendMessage({
            peer: peer as Api.TypeInputPeer,
            message: text,
            replyTo: inputReplyTo,
            randomId,
            ...(validScheduleDate != null ? { scheduleDate: validScheduleDate } : {}),
          }),
        );
        // result shape:Updates / UpdatesCombined / UpdateShortSentMessage 等。
        // 我們抽 UpdateNewMessage / UpdateMessageID 拿到 id;最簡實作直接遞迴找。
        const sentId = extractSentMessageId(result);
        return { success: true, sentMessageId: sentId };
      }

      // Forum topic text delivery needs low-level SendMessage so Telegram receives topMsgId.
      if (validTopicId != null && (peer as Api.TypeInputPeer)) {
        const randomId = bigInt(Math.floor(Math.random() * Number.MAX_SAFE_INTEGER));
        const replyTo = new Api.InputReplyToMessage({
          replyToMsgId: replyToMsgId != null && Number.isFinite(replyToMsgId) && replyToMsgId > 0
            ? Math.floor(replyToMsgId)
            : validTopicId,
          topMsgId: validTopicId,
        });
        const result = await managed.client.invoke(
          new Api.messages.SendMessage({
            peer: peer as Api.TypeInputPeer,
            message: text,
            replyTo,
            randomId,
            ...(validScheduleDate != null ? { scheduleDate: validScheduleDate } : {}),
          }),
        );
        return { success: true, sentMessageId: extractSentMessageId(result) };
      }

      // 一般 / 純 reply / schedule / parseMode 路徑 — 沿用 GramJS high-level。
      const sendOpts: {
        message: string;
        replyTo?: number;
        parseMode?: "html" | "markdown";
        scheduleDate?: number;
      } = { message: text };
      if (replyToMsgId != null && Number.isFinite(replyToMsgId) && replyToMsgId > 0) {
        sendOpts.replyTo = replyToMsgId;
      }
      if (parseMode === "html" || parseMode === "markdown") {
        sendOpts.parseMode = parseMode;
      }
      if (validScheduleDate != null) {
        sendOpts.scheduleDate = validScheduleDate;
      }

      const sent = await managed.client.sendMessage(peer, sendOpts);
      const sentId = sent && typeof (sent as { id?: unknown }).id !== "undefined"
        ? String((sent as { id: number | bigint }).id)
        : undefined;
      return { success: true, sentMessageId: sentId };
    } catch (error: unknown) {
      const tgErr = asTgSendError(error);
      const rawErrorMessage = tgErr.errorMessage || tgErr.message || String(error);
      const errMsg = String(error);
      log.error("Failed to send message", { accountId, error: errMsg });

      // Detect FLOOD_WAIT — Telegram requires pausing further requests
      if (rawErrorMessage.includes("FLOOD_WAIT") || rawErrorMessage.includes("FloodWait")) {
        const seconds = Number(tgErr.seconds) || 60;
        log.warn("FloodWait triggered", { accountId, seconds });
        return { success: false, error: rawErrorMessage, floodWaitSeconds: seconds };
      }

      // Detect supergroup migration (Telegram error codes 400 CHAT_MIGRATED or PEER_ID_INVALID)
      // GramJS throws RPCError with errorMessage like "CHAT_MIGRATED" or "CHANNEL_INVALID"
      // The new supergroup ID is typically in error.message or can be found from the error object
      const isMigrated =
        errMsg.includes("CHAT_MIGRATED") ||
        errMsg.includes("PEER_MIGRATE") ||
        errMsg.includes("ChatMigrated");

      const isChatNotFound =
        errMsg.includes("CHAT_ID_INVALID") ||
        errMsg.includes("PEER_ID_INVALID") ||
        errMsg.includes("CHANNEL_INVALID") ||
        errMsg.includes("Chat not found");

      if (isMigrated) {
        // GramJS RPCError may contain the new channel_id in the error object
        let newChatId: string | undefined;
        if (tgErr.newChannelId) {
          newChatId = String(tgErr.newChannelId);
        } else if (tgErr.errorMessage?.includes("CHAT_MIGRATED") && tgErr.result?.newChannelId) {
          newChatId = String(tgErr.result.newChannelId);
        }
        // Also try extracting from error message (some GramJS versions embed it)
        if (!newChatId) {
          const match = errMsg.match(/migrate[d]?\s+to\s+(-?\d+)/i);
          if (match) newChatId = match[1];
        }
        return { success: false, error: errMsg, migratedToChatId: newChatId };
      }

      if (isChatNotFound) {
        // Chat not found could also indicate a migration that we can't auto-detect the new ID for
        return { success: false, error: errMsg, migratedToChatId: undefined };
      }

      return { success: false, error: errMsg };
    }
  }

  /**
   * Send a file / image / document as a NATIVE Telegram attachment via
   * GramJS's sendFile. The recipient gets a proper TG attachment (with
   * thumbnail, download button, etc.) rather than a text message containing
   * a URL.
   *
   * `file` may be a local filesystem path (string) or a Buffer. Optional
   * `caption` is the text shown under the file.
   */
  async sendFile(
    accountId: string,
    chatId: string,
    file: string | Buffer,
    caption?: string,
    options?: { voiceNote?: boolean; videoNote?: boolean; supportsStreaming?: boolean; forceDocument?: boolean; topicId?: number | null },
  ): Promise<SendResult> {
    const managed = this.clients.get(accountId);
    if (!managed || managed.status !== "connected") {
      return { success: false, error: "Account not connected" };
    }
    try {
      managed.lastUsed = Date.now();
      let peer: Parameters<typeof managed.client.sendFile>[0] = chatId;
      try {
        peer = await managed.client.getInputEntity(chatId);
      } catch {
        peer = chatId;
      }
      const sent = await managed.client.sendFile(peer, {
        file,
        caption,
        ...(options?.voiceNote ? { voiceNote: true } : {}),
        ...(options?.videoNote ? { videoNote: true } : {}),
        ...(options?.supportsStreaming ? { supportsStreaming: true } : {}),
        ...(options?.forceDocument ? { forceDocument: true } : {}),
      });
      const sentId =
        sent && typeof (sent as { id?: unknown }).id !== "undefined"
          ? String((sent as { id: number | bigint }).id)
          : undefined;
      return { success: true, sentMessageId: sentId };
    } catch (error: unknown) {
      const errMsg = String(error);
      log.error("Failed to send file", { accountId, chatId, error: errMsg });
      return { success: false, error: errMsg };
    }
  }

  async sendNative(
    accountId: string,
    chatId: string,
    payload: NativeOutboundPayload,
    options?: { replyToMsgId?: number | null; topicId?: number | null; scheduleDate?: number | null },
  ): Promise<NativeSendResult> {
    const managed = this.clients.get(accountId);
    const fallback = buildNativeOutboundMetadata(payload);
    if (!managed || managed.status !== "connected") return { success: false, error: "Account not connected", ...fallback };

    try {
      managed.lastUsed = Date.now();
      let peer: Api.TypeInputPeer;
      try {
        peer = await managed.client.getInputEntity(chatId) as Api.TypeInputPeer;
      } catch {
        peer = chatId as unknown as Api.TypeInputPeer;
      }

      const media = await this.buildNativeInputMedia(managed.client, payload);
      const replyToMsgId =
        options?.replyToMsgId != null && Number.isFinite(options.replyToMsgId) && options.replyToMsgId > 0
          ? Math.floor(options.replyToMsgId)
          : options?.topicId != null && Number.isFinite(options.topicId) && options.topicId > 0
            ? Math.floor(options.topicId)
            : undefined;
      const replyTo = replyToMsgId != null
        ? new Api.InputReplyToMessage({
            replyToMsgId,
            ...(options?.topicId != null && Number.isFinite(options.topicId) && options.topicId > 0
              ? { topMsgId: Math.floor(options.topicId) }
              : {}),
          })
        : undefined;
      const validScheduleDate =
        options?.scheduleDate != null && Number.isFinite(options.scheduleDate) && options.scheduleDate > Math.floor(Date.now() / 1000) + 5
          ? Math.floor(options.scheduleDate)
          : undefined;

      const result = await managed.client.invoke(
        new Api.messages.SendMedia({
          peer,
          media,
          message: fallback.content,
          randomId: bigInt(Math.floor(Math.random() * Number.MAX_SAFE_INTEGER)),
          ...(replyTo ? { replyTo } : {}),
          ...(validScheduleDate != null ? { scheduleDate: validScheduleDate } : {}),
        }),
      );
      return { success: true, sentMessageId: extractSentMessageId(result), ...fallback };
    } catch (error) {
      const errMsg = String(error);
      log.error("Failed to send native media", { accountId, chatId, kind: payload.kind, error: errMsg });
      return { success: false, error: errMsg, ...fallback };
    }
  }

  private async buildNativeInputMedia(
    client: TelegramClient,
    payload: NativeOutboundPayload,
  ): Promise<Api.TypeInputMedia> {
    switch (payload.kind) {
      case "location":
        return payload.livePeriod && payload.livePeriod > 0
          ? new Api.InputMediaGeoLive({
              geoPoint: new Api.InputGeoPoint({ lat: payload.lat, long: payload.lng }),
              period: Math.floor(payload.livePeriod),
            })
          : new Api.InputMediaGeoPoint({
              geoPoint: new Api.InputGeoPoint({ lat: payload.lat, long: payload.lng }),
            });
      case "contact":
        return new Api.InputMediaContact({
          phoneNumber: payload.phone,
          firstName: payload.firstName,
          lastName: payload.lastName ?? "",
          vcard: "",
        });
      case "poll": {
        const answers = payload.options.slice(0, 10).map((text, idx) =>
          new Api.PollAnswer({
            text: new Api.TextWithEntities({ text, entities: [] }),
            option: Buffer.from([idx]),
          }),
        );
        const correct = payload.quiz && payload.correctOptionIndex != null
          ? [Buffer.from([Math.max(0, Math.min(answers.length - 1, payload.correctOptionIndex))])]
          : undefined;
        return new Api.InputMediaPoll({
          poll: new Api.Poll({
            id: bigInt(Math.floor(Math.random() * Number.MAX_SAFE_INTEGER)),
            question: new Api.TextWithEntities({ text: payload.question, entities: [] }),
            answers,
            publicVoters: payload.anonymous === false,
            multipleChoice: payload.multipleChoice === true,
            quiz: payload.quiz === true,
            closed: payload.closed === true,
          }),
          ...(correct ? { correctAnswers: correct } : {}),
        });
      }
      case "dice":
        return new Api.InputMediaDice({ emoticon: payload.emoticon });
      case "story": {
        let storyPeer: Api.TypeInputPeer;
        try {
          storyPeer = await client.getInputEntity(payload.peerId) as Api.TypeInputPeer;
        } catch {
          storyPeer = payload.peerId as unknown as Api.TypeInputPeer;
        }
        return new Api.InputMediaStory({ peer: storyPeer, id: Math.floor(payload.storyId) });
      }
    }
  }

  async applyTelegramAdminAction(accountId: string, action: TelegramAdminAction): Promise<SendResult> {
    const managed = this.clients.get(accountId);
    if (!managed || managed.status !== "connected") return { success: false, error: "Account not connected" };
    try {
      managed.lastUsed = Date.now();
      const resolvePeer = async (id: string) => managed.client.getInputEntity(id) as Promise<Api.TypeInputPeer>;
      const resolveInputChannel = async (id: string): Promise<Api.TypeInputChannel> => {
        const peer = await resolvePeer(id);
        if (peer instanceof Api.InputPeerChannel) {
          return new Api.InputChannel({ channelId: peer.channelId, accessHash: peer.accessHash });
        }
        return peer as unknown as Api.TypeInputChannel;
      };
      const resolveInputUser = async (id: string): Promise<Api.TypeInputUser> => {
        const peer = await resolvePeer(id);
        if (peer instanceof Api.InputPeerUser) {
          return new Api.InputUser({ userId: peer.userId, accessHash: peer.accessHash });
        }
        return peer as unknown as Api.TypeInputUser;
      };
      switch (action.kind) {
        case "pin-message": {
          await managed.client.invoke(new Api.messages.UpdatePinnedMessage({
            peer: await resolvePeer(action.chatId),
            id: Math.floor(action.messageId),
            silent: action.silent === true,
            unpin: action.unpin === true,
          }));
          return { success: true };
        }
        case "dialog-pin": {
          const peer = await resolvePeer(action.chatId);
          await managed.client.invoke(new Api.messages.ToggleDialogPin({
            pinned: action.pinned,
            peer: new Api.InputDialogPeer({ peer }),
          }));
          return { success: true };
        }
        case "folder-delete":
          await managed.client.invoke(new Api.messages.UpdateDialogFilter({ id: Math.floor(action.filterId) }));
          return { success: true };
        case "folder-update": {
          const toInputPeers = async (ids: string[] = []) => Promise.all(ids.map((id) => resolvePeer(id)));
          await managed.client.invoke(new Api.messages.UpdateDialogFilter({
            id: Math.floor(action.filterId),
            filter: new Api.DialogFilter({
              id: Math.floor(action.filterId),
              title: new Api.TextWithEntities({ text: action.title, entities: [] }),
              emoticon: action.emoticon,
              includePeers: await toInputPeers(action.includeChatIds),
              pinnedPeers: await toInputPeers(action.pinnedChatIds ?? []),
              excludePeers: await toInputPeers(action.excludeChatIds ?? []),
            }),
          }));
          return { success: true };
        }
        case "channel-title":
          await managed.client.invoke(new Api.channels.EditTitle({ channel: await resolveInputChannel(action.chatId), title: action.title }));
          return { success: true };
        case "channel-admin":
          await managed.client.invoke(new Api.channels.EditAdmin({
            channel: await resolveInputChannel(action.chatId),
            userId: await resolveInputUser(action.userId),
            adminRights: new Api.ChatAdminRights(action.rights),
            rank: action.rank ?? "",
          }));
          return { success: true };
      }
    } catch (error) {
      log.error("Telegram admin action failed", { accountId, kind: action.kind, error: String(error) });
      return { success: false, error: String(error) };
    }
  }

  getUnsupportedNativeCapability(capability: "calls" | "secret-chats"): SendResult {
    return {
      success: false,
      error: capability === "calls"
        ? "OUT_OF_SCOPE: GramJS exposes phone.* raw RPCs, but Switchboard does not implement the required Telegram VoIP media engine/signaling stack."
        : "OUT_OF_SCOPE: GramJS exposes encrypted chat raw RPCs, but Switchboard does not implement Telegram secret-chat encrypted-layer state machine.",
    };
  }

  /**
   * Fetch the set of message IDs currently live in a chat (i.e. not deleted
   * server-side), limited to the most recent N.
   *
   * Used by the bridge's delete reconciliation pass to compare against our
   * DB and mark anything we have that Telegram no longer does as deleted.
   * Telegram's UpdateDeleteMessages event isn't reliable for basic groups
   * (no chat_id in the update); this is our catch-up mechanism.
   *
   * Returns null when the call fails for any reason — the caller treats
   * that as "skip this group, try again next tick" rather than as an empty
   * result (which would incorrectly mark everything deleted).
   */
  async fetchChatMessageIds(
    accountId: string,
    chatId: string,
    limit: number = 100,
  ): Promise<Set<number> | null> {
    const managed = this.clients.get(accountId);
    if (!managed || managed.status !== "connected") return null;
    try {
      managed.lastUsed = Date.now();
      let peer: Parameters<typeof managed.client.getMessages>[0] = chatId;
      try {
        peer = await managed.client.getInputEntity(chatId);
      } catch {
        peer = chatId;
      }
      const messages = await Promise.race([
        managed.client.getMessages(peer, { limit }),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 10000)),
      ]);
      if (!messages || !Array.isArray(messages)) return null;
      const ids = new Set<number>();
      for (const m of messages) {
        if (m && typeof (m as { id?: unknown }).id === "number") {
          ids.add((m as { id: number }).id);
        }
      }
      return ids;
    } catch (err) {
      log.warn("fetchChatMessageIds failed", { accountId, chatId, error: String(err).slice(0, 200) });
      return null;
    }
  }

  /**
   * 從一則 TG message 抽出 messageType + 媒體 buffer。
   *
   * 共用給 (a) NewMessage 即時 handler，(b) fetchHistory 補抓歷史。
   * 之前 (a) 的邏輯內聯在 handleNewMessage 裡 — 為了讓 backfill 拿一樣
   * 的媒體 metadata，獨立出來這個 helper。
   *
   * 限制：
   *   - 50MB 上限（estimatedSize 看下載前；實際下載超過一樣丟）
   *   - 圖片 / Document / Sticker 走 download 路徑，其他類型（Voice/Audio/
   *     Video 大檔）暫時也用 IMAGE/DOCUMENT 類別下載 — 行為跟 NewMessage
   *     既有路徑保持一致
   *   - download timeout 30 秒
   *
   * 回傳：
   *   messageType: "TEXT" / "IMAGE" / "DOCUMENT" / "AUDIO" / "VIDEO" / "STICKER"
   *   mediaInfo: 含 buffer 才能呼叫 MediaFileManager.storeFromTelegram；
   *              失敗 / 太大 / 不支援 → undefined（caller 視為純文字）
   */
  private async extractMessageMedia(
    client: TelegramClient,
    message: { media?: unknown },
  ): Promise<{
    messageType: "TEXT" | "IMAGE" | "DOCUMENT" | "AUDIO" | "VIDEO" | "STICKER" | "VOICE" | "VIDEO_NOTE" | "LOCATION" | "CONTACT" | "POLL" | "DICE" | "STORY";
    mediaInfo: MediaInfo | undefined;
    /** Structured payload for LOCATION / CONTACT / POLL (byte 類型用 mediaInfo)。 */
    metadata: MediaMetadata | undefined;
  }> {
    const MAX_MEDIA_SIZE = 50 * 1024 * 1024;
    const DOWNLOAD_TIMEOUT_MS = 30_000;
    type MsgType = "TEXT" | "IMAGE" | "DOCUMENT" | "AUDIO" | "VIDEO" | "STICKER" | "VOICE" | "VIDEO_NOTE" | "LOCATION" | "CONTACT" | "POLL" | "DICE" | "STORY";
    let messageType: MsgType = "TEXT";
    let mediaInfo: MediaInfo | undefined = undefined;
    let metadata: MediaMetadata | undefined = undefined;
    if (!message.media) return { messageType, mediaInfo, metadata };

    try {
      const media = message.media as unknown as TgMediaLike & {
        geo?: { lat?: number; long?: number };
        period?: number;
        firstName?: string;
        lastName?: string;
        phoneNumber?: string;
        userId?: bigint | number;
        poll?: { question?: { text?: string } | string; answers?: Array<{ text?: { text?: string } | string }>; closed?: boolean };
        results?: { totalVoters?: number; results?: Array<{ voters?: number }> };
      };
      const mediaClassName = media.className || "";

      // ── Bytes-less types: Geo / GeoLive / Contact / Poll / Dice ──────────
      // 直接組 metadata 後 return,不走 download。這些是 H4-P0 / P3 補上的類型,
      // 之前 bridge 把它們當「未知 media」silently drop 掉。
      if (mediaClassName.includes("Geo")) {
        const lat = typeof media.geo?.lat === "number" ? media.geo.lat : Number(media.geo?.lat ?? NaN);
        const lng = typeof media.geo?.long === "number" ? media.geo.long : Number(media.geo?.long ?? NaN);
        if (Number.isFinite(lat) && Number.isFinite(lng)) {
          metadata = {
            geo: {
              lat,
              lng,
              livePeriod: mediaClassName.includes("GeoLive")
                ? (Number(media.period ?? 0) || undefined)
                : undefined,
            },
          };
          return { messageType: "LOCATION", mediaInfo: undefined, metadata };
        }
        // 位置欄壞掉(罕見)→ 當 TEXT 處理,讓 content 顯示
        return { messageType: "TEXT", mediaInfo: undefined, metadata: undefined };
      }
      if (mediaClassName.includes("Contact")) {
        metadata = {
          contact: {
            firstName: typeof media.firstName === "string" ? media.firstName : undefined,
            lastName: typeof media.lastName === "string" ? media.lastName : undefined,
            phone: typeof media.phoneNumber === "string" ? media.phoneNumber : undefined,
            userId: media.userId != null ? String(media.userId) : undefined,
          },
        };
        return { messageType: "CONTACT", mediaInfo: undefined, metadata };
      }
      if (mediaClassName.includes("Poll")) {
        const poll = media.poll;
        const results = media.results;
        const question = typeof poll?.question === "string"
          ? poll.question
          : (poll?.question as { text?: string } | undefined)?.text ?? "";
        const options = (poll?.answers ?? []).map((a, idx) => {
          const txt = typeof a.text === "string"
            ? a.text
            : (a.text as { text?: string } | undefined)?.text ?? `選項 ${idx + 1}`;
          return { text: txt, voters: results?.results?.[idx]?.voters };
        });
        metadata = {
          poll: {
            question,
            options,
            totalVoters: results?.totalVoters,
            closed: poll?.closed,
          },
        };
        return { messageType: "POLL", mediaInfo: undefined, metadata };
      }
      // P3 Dice (動畫表情) — MessageMediaDice 有 emoticon + value(server roll 結果)
      if (mediaClassName.includes("Dice")) {
        const dice = media as unknown as { emoticon?: string; value?: number };
        const emoticon = typeof dice.emoticon === "string" ? dice.emoticon : "🎲";
        const value = typeof dice.value === "number" ? dice.value : 0;
        metadata = { dice: { emoticon, value } };
        return { messageType: "DICE", mediaInfo: undefined, metadata };
      }
      // P3 Story repost — MessageMediaStory:對方轉發 24h 限時 story。
      // 原 story 可能已過期(story = null);我們只保 reference + 標記 expired,
      // UI 顯示「📖 轉發故事」placeholder + (若沒過期)外連到 t.me。
      if (mediaClassName.includes("Story")) {
        const storyMedia = media as unknown as {
          id?: number | bigint;
          peer?: {
            className?: string;
            userId?: bigint | number;
            channelId?: bigint | number;
          };
          story?: unknown;
        };
        const sid =
          storyMedia.id == null
            ? 0
            : typeof storyMedia.id === "bigint"
              ? Number(storyMedia.id)
              : Number(storyMedia.id);
        let peerId: string | undefined;
        const peerCn = storyMedia.peer?.className ?? "";
        if (peerCn.includes("PeerUser") && storyMedia.peer?.userId != null) {
          peerId = String(storyMedia.peer.userId);
        } else if (peerCn.includes("PeerChannel") && storyMedia.peer?.channelId != null) {
          peerId = `-100${storyMedia.peer.channelId}`;
        }
        metadata = {
          story: {
            storyId: Number.isFinite(sid) ? sid : 0,
            peerId,
            // story 物件存在 → 還沒過期;null/undefined → 過期或無法取得
            expired: !storyMedia.story,
          },
        };
        return { messageType: "STORY", mediaInfo: undefined, metadata };
      }

      // ── Byte types: Photo / Document ───────────────────────────────────
      // Document 進階分類:看 attributes 區分 voice vs music、round vs regular
      // video、sticker、animated(GIF)。
      if (mediaClassName.includes("Photo")) {
        messageType = "IMAGE";
      } else if (mediaClassName.includes("Document")) {
        // gramjs `document.attributes` 是 union — 不同 attribute 子型別有不同
        // shape(DocumentAttributeAudio 有 voice/duration、Video 有 roundMessage/
        // duration、Filename 只有 fileName 等)。tsc 從 TgMediaLike 看到的是
        // 最窄型,所以這裡用 unknown 旁路一下、自己 narrow 屬性。
        type DocAttr = {
          className?: string;
          voice?: boolean;
          roundMessage?: boolean;
        };
        const docAttrs = (media.document as { attributes?: unknown } | undefined)
          ?.attributes;
        const attrs: DocAttr[] = Array.isArray(docAttrs) ? (docAttrs as DocAttr[]) : [];
        const audioAttr = attrs.find((a) => (a.className ?? "").includes("Audio"));
        const videoAttr = attrs.find((a) => (a.className ?? "").includes("Video"));
        const stickerAttr = attrs.find((a) => (a.className ?? "").includes("Sticker"));
        const animatedAttr = attrs.find((a) => (a.className ?? "").includes("Animated"));

        if (audioAttr?.voice) {
          messageType = "VOICE";
        } else if (videoAttr?.roundMessage) {
          messageType = "VIDEO_NOTE";
        } else if (stickerAttr) {
          messageType = "STICKER";
        } else if (animatedAttr) {
          // GIF / animated MP4 — 用 VIDEO 類型(可 loop autoplay)
          messageType = "VIDEO";
        } else if (media.document?.mimeType?.startsWith("image/")) {
          messageType = "IMAGE";
        } else if (media.document?.mimeType?.startsWith("audio/")) {
          messageType = "AUDIO";
        } else if (media.document?.mimeType?.startsWith("video/")) {
          messageType = "VIDEO";
        } else {
          messageType = "DOCUMENT";
        }
      } else {
        // 其他 media 類別(Story / Invoice / Game 等)→ TEXT fallback
        log.warn("Unsupported media class — falling back to TEXT", { mediaClassName });
        return { messageType: "TEXT", mediaInfo: undefined, metadata: undefined };
      }

      const estimatedSize = media.document?.size || media.photo?.sizes?.slice(-1)?.[0]?.size || 0;
      if (estimatedSize > MAX_MEDIA_SIZE) {
        log.warn("Media too large, skipping download", { estimatedSize });
        return { messageType: "TEXT", mediaInfo: undefined, metadata: undefined };
      }

      // 下載允許清單 — 比舊版多了 AUDIO / VIDEO / VOICE / VIDEO_NOTE / STICKER。
      // 原本只有 IMAGE / DOCUMENT 會下載 bytes,造成 UI「看得到泡泡看不到內容」
      // 的長期 P0 bug。STICKER 四種格式(靜態 WEBP/PNG、影片 WEBM、動畫 TGS)
      // bytes 都會拉下來 — 前端 chat-bubble 依 mimeType 分派渲染:TGS 走
      // <TgsSticker>(pako 解壓 + lottie-react),WEBM 走 <video>,其餘走 <img>。
      const DOWNLOADABLE: MsgType[] = ["IMAGE", "DOCUMENT", "AUDIO", "VIDEO", "VOICE", "VIDEO_NOTE", "STICKER"];
      if (!DOWNLOADABLE.includes(messageType)) {
        return { messageType, mediaInfo: undefined, metadata: undefined };
      }

      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
      try {
        const downloadPromise = client.downloadMedia(message as unknown as Parameters<typeof client.downloadMedia>[0]);
        const timeoutPromise = new Promise<never>((_, reject) => {
          timeoutHandle = setTimeout(
            () => reject(new Error("Media download timeout")),
            DOWNLOAD_TIMEOUT_MS,
          );
        });
        const buffer = await Promise.race([downloadPromise, timeoutPromise]);
        if (timeoutHandle) clearTimeout(timeoutHandle);
        if (buffer && buffer instanceof Buffer) {
          if (buffer.length > MAX_MEDIA_SIZE) {
            log.warn("Downloaded media exceeds limit", { size: buffer.length });
            return { messageType: "TEXT", mediaInfo: undefined, metadata: undefined };
          }
          mediaInfo = {
            mimeType: this.getMimeTypeFromMedia(message.media as Parameters<typeof this.getMimeTypeFromMedia>[0]),
            fileName: this.getFileNameFromMedia(message.media as Parameters<typeof this.getFileNameFromMedia>[0]),
            fileSize: buffer.length,
            buffer,
          };
        }
      } catch (downloadError) {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        log.warn("Media download failed", { error: String(downloadError) });
        return { messageType: "TEXT", mediaInfo: undefined, metadata: undefined };
      }
    } catch (mediaError) {
      log.error("Media processing failed", { error: String(mediaError) });
    }
    return { messageType, mediaInfo, metadata };
  }

  /**
   * 抓某個對話最近 N 則「完整訊息」（含內容、發送者、時間）。
   *
   * 跟 fetchChatMessageIds 不同 — 那支只回 ID 集合給 delete reconciliation
   * 用。這支的用途是「補抓歷史」：使用者第一次連 TG 帳號 / 之前 bridge
   * 沒抓到 / 拒絕監聽過後又開啟監聽，要把過去訊息塞進 DirectChatMessage
   * 讓 Switchboard UI 看得到。
   *
   * 回傳格式跟 NewMessage event 同形狀，呼叫端可重用 archive 邏輯。
   * 失敗（含 timeout）回 null。
   */
  async fetchHistory(
    accountId: string,
    chatId: string,
    limit: number = 100,
  ): Promise<Array<{
    messageId: number;
    fromMe: boolean;
    senderId: string | null;
    senderName: string | null;
    text: string;
    date: Date;
    replyToMessageId: number | null;
    /** 補抓時抓到的媒體（含 buffer）— caller 用來呼叫 MediaFileManager 入庫 */
    messageType: "TEXT" | "IMAGE" | "DOCUMENT" | "AUDIO" | "VIDEO" | "STICKER" | "VOICE" | "VIDEO_NOTE" | "LOCATION" | "CONTACT" | "POLL" | "DICE" | "STORY";
    mediaInfo: MediaInfo | undefined;
    /** Bytes-less metadata (LOCATION/CONTACT/POLL); null for byte 類型。 */
    metadata: MediaMetadata | undefined;
    /** P2: 轉發來源 metadata(若這則是轉發);非轉發回 undefined。 */
    forwardedFrom: ForwardedFromMeta | undefined;
    /** P2: forum topic id(supergroup 才有);非 forum 群組回 undefined。 */
    topicId: number | undefined;
    /** P3: channel post view count;非 channel 訊息回 undefined。 */
    viewCount: number | undefined;
    /** P3: TG quote reply 引用片段;一般回覆回 undefined。 */
    quoteText: string | undefined;
    /** 2026-05-21 TG parity:Message entities normalized payload。 */
    entities: NormalizedMessageEntity[] | undefined;
    /** 2026-05-21 TG parity:Album / media group id(字串避免精度損失)。 */
    groupedId: string | undefined;
    /** 2026-05-21:inline keyboard 按鈕(bot / 服務帳號訊息)。 */
    replyMarkup: NormalizedReplyMarkup | undefined;
  }> | null> {
    const managed = this.clients.get(accountId);
    if (!managed || managed.status !== "connected") return null;
    try {
      managed.lastUsed = Date.now();
      let peer: Parameters<typeof managed.client.getMessages>[0] = chatId;
      try {
        peer = await managed.client.getInputEntity(chatId);
      } catch {
        peer = chatId;
      }
      const result = await Promise.race([
        managed.client.getMessages(peer, { limit: Math.min(Math.max(limit, 1), 500) }),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 30_000)),
      ]);
      if (!result || !Array.isArray(result)) return null;

      // 我們自己這邊 active TG user IDs — 用來判斷某則訊息算 INBOUND 還是 OUTBOUND
      const ourIds = new Set(await this.getActiveTelegramUserIds());

      const out: Array<{
        messageId: number;
        fromMe: boolean;
        senderId: string | null;
        senderName: string | null;
        text: string;
        date: Date;
        replyToMessageId: number | null;
        messageType: "TEXT" | "IMAGE" | "DOCUMENT" | "AUDIO" | "VIDEO" | "STICKER" | "VOICE" | "VIDEO_NOTE" | "LOCATION" | "CONTACT" | "POLL" | "DICE" | "STORY";
        mediaInfo: MediaInfo | undefined;
        metadata: MediaMetadata | undefined;
        forwardedFrom: ForwardedFromMeta | undefined;
        topicId: number | undefined;
        viewCount: number | undefined;
        quoteText: string | undefined;
        entities: NormalizedMessageEntity[] | undefined;
        groupedId: string | undefined;
        replyMarkup: NormalizedReplyMarkup | undefined;
      }> = [];
      for (const m of result) {
        if (!m || typeof (m as { id?: unknown }).id !== "number") continue;
        const msg = m as {
          id: number;
          out?: boolean;
          message?: string;
          date?: number;
          media?: unknown;
          replyTo?: {
            replyToMsgId?: number;
            forumTopic?: boolean;
            replyToTopId?: number | bigint;
            quoteText?: string;
          };
          senderId?: { toString?: () => string };
          sender?: { firstName?: string; lastName?: string; username?: string };
          fwdFrom?: unknown;
          views?: number | null;
          entities?: unknown[];
          groupedId?: bigint | number | null;
        };
        const senderIdRaw = msg.senderId?.toString?.() ?? null;
        const fromMe =
          msg.out === true || (senderIdRaw != null && ourIds.has(senderIdRaw));
        const senderName =
          [msg.sender?.firstName, msg.sender?.lastName]
            .filter(Boolean)
            .join(" ")
            .trim() ||
          msg.sender?.username ||
          null;

        // 抓媒體：跑共用 helper，遇到太大 / 失敗會回 TEXT + undefined
        // 注意：補抓 100 則 × 每則 30s timeout 最壞會跑很久 — 但實際上
        // 大部分訊息是純文字、會立刻 short-circuit 跳過 download 路徑。
        const { messageType, mediaInfo, metadata } = await this.extractMessageMedia(
          managed.client,
          msg,
        );

        let topicId: number | undefined;
        if (msg.replyTo?.forumTopic && msg.replyTo.replyToTopId != null) {
          const t =
            typeof msg.replyTo.replyToTopId === "bigint"
              ? Number(msg.replyTo.replyToTopId)
              : msg.replyTo.replyToTopId;
          if (Number.isFinite(t) && t > 0) topicId = t;
        }

        out.push({
          messageId: msg.id,
          fromMe,
          senderId: senderIdRaw,
          senderName,
          text: msg.message ?? "",
          date: msg.date ? new Date(msg.date * 1000) : new Date(),
          replyToMessageId: msg.replyTo?.replyToMsgId ?? null,
          messageType,
          mediaInfo,
          metadata,
          forwardedFrom: extractForwardedFrom(msg.fwdFrom),
          topicId,
          viewCount:
            typeof msg.views === "number" && msg.views >= 0 ? msg.views : undefined,
          quoteText:
            typeof msg.replyTo?.quoteText === "string" && msg.replyTo.quoteText.length > 0
              ? msg.replyTo.quoteText
              : undefined,
          // 2026-05-21 TG parity
          entities: normalizeEntities(msg.entities),
          groupedId:
            msg.groupedId != null && msg.groupedId !== 0
              ? typeof msg.groupedId === "bigint"
                ? msg.groupedId.toString()
                : String(msg.groupedId)
              : undefined,
          replyMarkup: normalizeReplyMarkup(
            (msg as { replyMarkup?: unknown }).replyMarkup,
          ),
        });
      }
      // TG 回傳是新 → 舊。CALLER 需要時序的話自己反；這裡保留原順序
      return out;
    } catch (err) {
      log.warn("fetchHistory failed", {
        accountId,
        chatId,
        error: String(err).slice(0, 200),
      });
      return null;
    }
  }

  /**
   * Download a user's current profile photo via the given account.
   *
   * Returns a JPEG buffer (Telegram's default photo format) or null when the
   * user has no profile photo set / photo is privacy-restricted / the peer
   * can't be resolved. Swallows errors — avatar caching is best-effort.
   */
  async downloadProfilePhoto(
    accountId: string,
    peerId: string,
  ): Promise<{ buffer: Buffer; mimeType: string } | null> {
    const managed = this.clients.get(accountId);
    if (!managed || managed.status !== "connected") return null;
    try {
      managed.lastUsed = Date.now();
      let entity;
      try {
        entity = await managed.client.getInputEntity(peerId);
      } catch {
        // If we can't resolve the peer through the session cache, try the
        // raw numeric id. GramJS sometimes accepts this when the user is
        // already known via dialog traversal.
        entity = peerId;
      }
      // Telegram profile photos are standard JPEGs. downloadProfilePhoto
      // returns a Buffer when the user has a photo, null-ish otherwise.
      const buffer = await Promise.race([
        managed.client.downloadProfilePhoto(entity, { isBig: false }),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 10000)),
      ]);
      if (!buffer || !(buffer instanceof Buffer) || buffer.length === 0) return null;
      return { buffer, mimeType: "image/jpeg" };
    } catch (err) {
      log.warn("Profile photo download failed", { accountId, peerId, error: String(err).slice(0, 200) });
      return null;
    }
  }

  /**
   * 列出某 chat 的所有成員 user id + display name(供 avatar 預熱用)。
   *
   * 走 GramJS 高層 client.iterParticipants — 它對 BasicChat / Megagroup /
   * Channel 都 work,內部處理 GetFullChat / channels.GetParticipants
   * 與分頁。回傳上限 `limit`(預設 200,supergroup 上千人時保護用)。
   *
   * 失敗(沒權限 / peer 解析不到)→ 回空陣列 + log warn。avatar 預熱是
   * best-effort,不能讓單群組失敗影響整個 sweep。
   */
  async listGroupParticipants(
    accountId: string,
    chatId: string,
    limit = 200,
  ): Promise<Array<{ platformUserId: string; displayName: string | null }>> {
    const managed = this.clients.get(accountId);
    if (!managed || managed.status !== "connected") return [];
    try {
      managed.lastUsed = Date.now();
      const entity = await managed.client.getInputEntity(chatId);
      const out: Array<{ platformUserId: string; displayName: string | null }> = [];
      const iter = managed.client.iterParticipants(entity, { limit });
      for await (const p of iter) {
        // p 可以是 User 也可以是 Channel(對 broadcast channel 的 admin
        // list 等),只取 User
        const u = p as unknown as {
          id?: { toString?: () => string };
          firstName?: string | null;
          lastName?: string | null;
          username?: string | null;
        };
        const id = u.id?.toString?.();
        if (!id) continue;
        const display =
          [u.firstName, u.lastName].filter(Boolean).join(" ").trim() ||
          u.username ||
          null;
        out.push({ platformUserId: id, displayName: display });
        if (out.length >= limit) break;
      }
      return out;
    } catch (err) {
      log.warn("listGroupParticipants failed", {
        accountId,
        chatId,
        error: String(err).slice(0, 150),
      });
      return [];
    }
  }

  /**
   * Edit a previously-sent message. Used by the bridge to propagate edits
   * from the source group to every forwarded copy in target groups.
   */
  async editMessage(
    accountId: string,
    chatId: string,
    messageId: number,
    newText: string
  ): Promise<{ success: boolean; error?: string }> {
    const managed = this.clients.get(accountId);
    if (!managed || managed.status !== "connected") {
      return { success: false, error: "Account not connected" };
    }
    try {
      managed.lastUsed = Date.now();
      await managed.client.editMessage(chatId, { message: messageId, text: newText });
      return { success: true };
    } catch (error: unknown) {
      const tgErr = asTgSendError(error);
      const errMsg = tgErr.errorMessage || tgErr.message || String(error);
      log.error("Failed to edit message", { accountId, chatId, messageId, error: errMsg });
      return { success: false, error: errMsg };
    }
  }

  /**
   * Forward messages from one chat to another using the SAME account.
   *
   * P1 2026-05-20: 員工轉發訊息到另一個對話。GramJS `forwardMessages` 對應
   * `Api.messages.ForwardMessages` — 由 TG 自己處理「轉發來源標註」
   * (forward header 會顯示 from X)。我們不自己重 send,因為:
   *   1) 媒體不用重傳(TG 沿用 file_reference,免上傳)
   *   2) 對方看到「forwarded from」原始來源,符合 TG 慣例
   *
   * 限制:account 必須同時在 fromChat 跟 toChat 裡(GramJS 需要兩邊都能解析
   * peer)。API 層會檢查 AccountGroupMembership;這裡只回 TG 錯誤。
   *
   * 成功時回傳 `sentMessageIds[]` = TG 上新訊息的 id,對應到 target chat。
   * caller 用來建立 DCM 紀錄(讓 Switchboard UI 也顯示這條轉發)。
   */
  async forwardMessages(
    accountId: string,
    fromChatId: string,
    messageIds: number[],
    toChatId: string,
  ): Promise<{ success: boolean; error?: string; sentMessageIds?: string[] }> {
    if (messageIds.length === 0) return { success: false, error: "no messages to forward" };
    const managed = this.clients.get(accountId);
    if (!managed || managed.status !== "connected") {
      return { success: false, error: "Account not connected" };
    }
    try {
      managed.lastUsed = Date.now();
      const fromPeer = await managed.client.getInputEntity(fromChatId);
      const toPeer = await managed.client.getInputEntity(toChatId);
      const result = await managed.client.forwardMessages(toPeer, {
        messages: messageIds,
        fromPeer,
      });
      // GramJS 回 Message[] (或單一 Message);抽出每筆的 id 給 caller。
      const arr = Array.isArray(result) ? result : result ? [result] : [];
      const sentIds = arr
        .map((m) => {
          const x = m as { id?: number | bigint };
          if (x.id == null) return null;
          return typeof x.id === "bigint" ? String(x.id) : String(x.id);
        })
        .filter((v): v is string => v !== null);
      return { success: true, sentMessageIds: sentIds };
    } catch (error: unknown) {
      const tgErr = asTgSendError(error);
      const errMsg = tgErr.errorMessage || tgErr.message || String(error);
      log.error("Failed to forward messages", {
        accountId,
        fromChatId,
        toChatId,
        ids: messageIds,
        error: errMsg,
      });
      return { success: false, error: errMsg };
    }
  }

  /**
   * Delete messages. Used by the bridge to propagate deletes from the source
   * group to every forwarded copy in target groups. `revoke: true` removes
   * for all participants, matching the source-side delete semantics.
   */
  async deleteMessages(
    accountId: string,
    chatId: string,
    messageIds: number[]
  ): Promise<{ success: boolean; error?: string }> {
    if (messageIds.length === 0) return { success: true };
    const managed = this.clients.get(accountId);
    if (!managed || managed.status !== "connected") {
      return { success: false, error: "Account not connected" };
    }
    try {
      managed.lastUsed = Date.now();
      await managed.client.deleteMessages(chatId, messageIds, { revoke: true });
      return { success: true };
    } catch (error: unknown) {
      const tgErr = asTgSendError(error);
      const errMsg = tgErr.errorMessage || tgErr.message || String(error);
      log.error("Failed to delete messages", { accountId, chatId, ids: messageIds, error: errMsg });
      return { success: false, error: errMsg };
    }
  }

  /**
   * P2 2026-05-20:抓 TG 原生資料夾(DialogFilter)清單。
   *
   * 包 GramJS `Api.messages.GetDialogFilters`。員工在 TG 客戶端建立的資料夾
   * (「工作」「朋友」「廣告」...)會回傳給我們,bridge sync 後 Switchboard chat
   * list 可以用它快速 filter。
   *
   * 處理三種 DialogFilter 變體:
   *   - DialogFilter:一般使用者建立的;有 includePeers / excludePeers / pinnedPeers
   *   - DialogFilterDefault:「所有對話」tab,我們不存(Switchboard 已經有預設 listing)
   *   - DialogFilterChatlist:premium 共享資料夾,我們先不處理
   *
   * peer 規格化:
   *   InputPeerUser    → "<userId>"
   *   InputPeerChat    → "-<chatId>"
   *   InputPeerChannel → "-100<channelId>"
   *   其他 / self      → 跳過(Switchboard 不會把自己當 chat 來儲存)
   *
   * 跟 Switchboard Group.platformGroupId 同一個 normalized format。
   */
  async getDialogFilters(
    accountId: string,
  ): Promise<
    Array<{
      tgFilterId: number;
      title: string;
      emoticon: string | null;
      /** Pinned + included + excluded 之外的所有「應該屬於」此 filter 的 peer id。
       *  Switchboard 簡化:把 pinned + included 合併,excluded 過濾。 */
      peerIds: string[];
    }>
  > {
    const managed = this.clients.get(accountId);
    if (!managed || managed.status !== "connected") return [];
    try {
      managed.lastUsed = Date.now();
      const Api = (await import("telegram")).Api;
      const result = (await managed.client.invoke(
        new Api.messages.GetDialogFilters(),
      )) as unknown as {
        filters?: Array<{
          className?: string;
          id?: number;
          title?: { text?: string } | string;
          emoticon?: string;
          pinnedPeers?: Array<unknown>;
          includePeers?: Array<unknown>;
          excludePeers?: Array<unknown>;
        }>;
      };

      const peerToId = (p: unknown): string | null => {
        if (!p || typeof p !== "object") return null;
        const peer = p as {
          className?: string;
          userId?: bigint | number;
          chatId?: bigint | number;
          channelId?: bigint | number;
        };
        const cn = peer.className ?? "";
        if (cn.includes("InputPeerUser") && peer.userId != null) {
          return String(peer.userId);
        }
        if (cn.includes("InputPeerChat") && peer.chatId != null) {
          return `-${peer.chatId}`;
        }
        if (cn.includes("InputPeerChannel") && peer.channelId != null) {
          return `-100${peer.channelId}`;
        }
        // self / empty / 其他 → 跳過
        return null;
      };

      const out: Array<{
        tgFilterId: number;
        title: string;
        emoticon: string | null;
        peerIds: string[];
      }> = [];
      for (const f of result.filters ?? []) {
        const cn = f.className ?? "";
        // Default tab / Chatlist (shared folders) 不處理
        if (cn.includes("Default") || cn.includes("Chatlist")) continue;
        if (f.id == null) continue;
        const title =
          typeof f.title === "string"
            ? f.title
            : (f.title as { text?: string } | undefined)?.text ?? "";
        if (!title) continue;
        const excluded = new Set<string>(
          (f.excludePeers ?? []).map(peerToId).filter((v): v is string => !!v),
        );
        const peerIds: string[] = [];
        for (const p of [...(f.pinnedPeers ?? []), ...(f.includePeers ?? [])]) {
          const id = peerToId(p);
          if (id && !excluded.has(id) && !peerIds.includes(id)) {
            peerIds.push(id);
          }
        }
        out.push({
          tgFilterId: Number(f.id),
          title,
          emoticon: f.emoticon || null,
          peerIds,
        });
      }
      return out;
    } catch (err) {
      log.warn("getDialogFilters failed", {
        accountId,
        error: String(err).slice(0, 200),
      });
      return [];
    }
  }

  /**
   * P2 2026-05-20:列出某則訊息的「reaction 反應者」。
   *
   * 包 GramJS `Api.messages.GetMessageReactionsList` — 對應 TG 客戶端的
   * 「看誰按了 👍 / ❤️」清單。回 user + emoji 對(同一個 user 可能對同一則
   * 訊息 react 多次的 premium 情況也支援,我們的 model 保留 array)。
   *
   * 限制:GetMessageReactionsList 需要 client 已 join 該 chat。1:1 私訊也
   * 可用。回傳上限 100 reactions(TG API 內部分頁,這裡先抓 100 應該 cover
   * Switchboard 常見場景)。
   *
   * 失敗時(沒權限 / peer 解析不到)→ 回空陣列 + log warn。non-fatal。
   */
  /**
   * 2026-05-21 TG parity:`messages.GetMessageReadParticipants` —
   * 小群組(<=100 成員)看誰已讀某則訊息。TG 對「7 天內 + 群組大小」雙重限制;
   * 失敗或大群會回空陣列(caller UI 不顯示已讀列表即可)。
   *
   * 回傳:platformUserId[] — 客戶端去 SenderAvatar / GroupMember 表撈名字頭像。
   */
  /**
   * 2026-05-21 Wave 1 — 對 1:1 私訊聯絡人的操作:封鎖 / 解除封鎖 / 加為聯絡人。
   * block / unblock 用 InputPeer;addContact 需要 InputUser(從 InputPeerUser 取值重建)。
   */
  async contactAction(
    accountId: string,
    chatId: string,
    action: "block" | "unblock" | "add",
    firstName?: string,
  ): Promise<{ success: boolean; error?: string }> {
    const managed = this.clients.get(accountId);
    if (!managed || managed.status !== "connected") {
      return { success: false, error: "Account not connected" };
    }
    try {
      managed.lastUsed = Date.now();
      const peer = await managed.client.getInputEntity(chatId);
      if (action === "block") {
        await managed.client.invoke(new Api.contacts.Block({ id: peer }));
      } else if (action === "unblock") {
        await managed.client.invoke(new Api.contacts.Unblock({ id: peer }));
      } else {
        // contacts.AddContact 需要 InputUser(非 InputPeer)。
        const p = peer as unknown as {
          className?: string;
          userId?: bigInt.BigInteger;
          accessHash?: bigInt.BigInteger;
        };
        if (p.className !== "InputPeerUser" || !p.userId) {
          return { success: false, error: "只能對個人(1:1 私訊)新增聯絡人" };
        }
        await managed.client.invoke(
          new Api.contacts.AddContact({
            id: new Api.InputUser({
              userId: p.userId,
              accessHash: p.accessHash ?? bigInt(0),
            }),
            firstName: (firstName ?? "").slice(0, 64) || "聯絡人",
            lastName: "",
            phone: "",
            addPhonePrivacyException: false,
          }),
        );
      }
      return { success: true };
    } catch (err) {
      const tgErr = asTgSendError(err);
      const errMsg = tgErr.errorMessage || tgErr.message || String(err);
      log.warn("contactAction failed", {
        accountId,
        action,
        error: errMsg.slice(0, 200),
      });
      return { success: false, error: errMsg };
    }
  }

  /**
   * 2026-05-21 Batch 4 — 列出此帳號目前在 Telegram 上的所有已登入裝置 / session。
   * account.getAuthorizations。hash 正規化成 decimal string 供 HTTP 往返。
   */
  async getAuthorizations(accountId: string): Promise<{
    authorizations: Array<{
      hash: string;
      deviceModel: string;
      platform: string;
      systemVersion: string;
      appName: string;
      appVersion: string;
      dateCreated: number;
      dateActive: number;
      ip: string;
      country: string;
      region: string;
      isCurrent: boolean;
      isOfficialApp: boolean;
      isPasswordPending: boolean;
    }>;
    error?: string;
  }> {
    const managed = this.clients.get(accountId);
    if (!managed || managed.status !== "connected") {
      return { authorizations: [], error: "Account not connected" };
    }
    try {
      managed.lastUsed = Date.now();
      const result = await managed.client.invoke(
        new Api.account.GetAuthorizations(),
      );
      const list =
        (result as unknown as {
          authorizations?: Array<Record<string, unknown>>;
        }).authorizations ?? [];
      const out = list.map((a) => ({
        hash: String(a.hash ?? "0"),
        deviceModel: String(a.deviceModel ?? ""),
        platform: String(a.platform ?? ""),
        systemVersion: String(a.systemVersion ?? ""),
        appName: String(a.appName ?? ""),
        appVersion: String(a.appVersion ?? ""),
        dateCreated: Number(a.dateCreated ?? 0),
        dateActive: Number(a.dateActive ?? 0),
        ip: String(a.ip ?? ""),
        country: String(a.country ?? ""),
        region: String(a.region ?? ""),
        isCurrent: Boolean(a.current),
        isOfficialApp: Boolean(a.officialApp),
        isPasswordPending: Boolean(a.passwordPending),
      }));
      return { authorizations: out };
    } catch (err) {
      const tgErr = asTgSendError(err);
      const errMsg = tgErr.errorMessage || tgErr.message || String(err);
      log.warn("getAuthorizations failed", {
        accountId,
        error: errMsg.slice(0, 200),
      });
      return { authorizations: [], error: errMsg };
    }
  }

  /**
   * 2026-05-21 Batch 4 — 遠端登出此帳號的某個裝置 / session。
   * account.resetAuthorization。hash 由 getAuthorizations 帶回的 decimal string。
   * 不能登出「目前這個 session」(TG 端會回 FRESH_RESET_AUTHORISATION_FORBIDDEN 等)。
   */
  async resetAuthorization(
    accountId: string,
    hash: string,
  ): Promise<{ success: boolean; error?: string }> {
    const managed = this.clients.get(accountId);
    if (!managed || managed.status !== "connected") {
      return { success: false, error: "Account not connected" };
    }
    try {
      managed.lastUsed = Date.now();
      await managed.client.invoke(
        new Api.account.ResetAuthorization({ hash: bigInt(hash) }),
      );
      return { success: true };
    } catch (err) {
      const tgErr = asTgSendError(err);
      const errMsg = tgErr.errorMessage || tgErr.message || String(err);
      log.warn("resetAuthorization failed", {
        accountId,
        error: errMsg.slice(0, 200),
      });
      return { success: false, error: errMsg };
    }
  }

  async getMessageReadParticipants(
    accountId: string,
    chatId: string,
    messageId: number,
  ): Promise<{ readBy: string[]; error?: string }> {
    const managed = this.clients.get(accountId);
    if (!managed || managed.status !== "connected") {
      return { readBy: [], error: "Account not connected" };
    }
    try {
      managed.lastUsed = Date.now();
      const peer = await managed.client.getInputEntity(chatId);
      const result = await managed.client.invoke(
        new Api.messages.GetMessageReadParticipants({
          peer,
          msgId: messageId,
        }),
      );
      // 回傳是 Vector<ReadParticipantDate> — 每筆 { userId: long, date: int }。
      // 老 layer 可能直接回 long[] — 兩種都 normalize 成 string[]。
      const out: string[] = [];
      const arr = result as unknown as Array<
        | bigint
        | number
        | { userId?: bigint | number }
      >;
      if (Array.isArray(arr)) {
        for (const entry of arr) {
          if (typeof entry === "bigint" || typeof entry === "number") {
            out.push(String(entry));
          } else if (entry && typeof entry === "object" && entry.userId != null) {
            out.push(String(entry.userId));
          }
        }
      }
      return { readBy: out };
    } catch (err) {
      const tgErr = asTgSendError(err);
      const errMsg = tgErr.errorMessage || tgErr.message || String(err);
      log.warn("getMessageReadParticipants failed", {
        accountId,
        chatId,
        messageId,
        error: errMsg.slice(0, 200),
      });
      return { readBy: [], error: errMsg };
    }
  }

  async getReactionList(
    accountId: string,
    chatId: string,
    messageId: number,
  ): Promise<
    Array<{
      platformUserId: string;
      firstName: string | null;
      lastName: string | null;
      username: string | null;
      emoji: string;
      date: string | null;
    }>
  > {
    const managed = this.clients.get(accountId);
    if (!managed || managed.status !== "connected") return [];
    try {
      managed.lastUsed = Date.now();
      const Api = (await import("telegram")).Api;
      const peer = await managed.client.getInputEntity(chatId);
      const result = await managed.client.invoke(
        new Api.messages.GetMessageReactionsList({
          peer,
          id: messageId,
          limit: 100,
        }),
      );
      const users = new Map<
        string,
        { firstName: string | null; lastName: string | null; username: string | null }
      >();
      for (const u of (result.users as unknown as Array<{
        id?: { toString?: () => string };
        firstName?: string | null;
        lastName?: string | null;
        username?: string | null;
      }>) ?? []) {
        const uid = u.id?.toString?.();
        if (!uid) continue;
        users.set(uid, {
          firstName: u.firstName ?? null,
          lastName: u.lastName ?? null,
          username: u.username ?? null,
        });
      }
      const out: Array<{
        platformUserId: string;
        firstName: string | null;
        lastName: string | null;
        username: string | null;
        emoji: string;
        date: string | null;
      }> = [];
      for (const r of (result.reactions as unknown as Array<{
        peerId?: { className?: string; userId?: bigint | number };
        date?: number;
        reaction?: { className?: string; emoticon?: string };
      }>) ?? []) {
        const cn = r.peerId?.className ?? "";
        if (!cn.includes("PeerUser") || r.peerId?.userId == null) continue;
        const uid = String(r.peerId.userId);
        const userInfo = users.get(uid);
        const emoji = r.reaction?.emoticon ?? "";
        if (!emoji) continue; // 跳過 custom emoji / paid 之類 — UI 不會渲染
        out.push({
          platformUserId: uid,
          firstName: userInfo?.firstName ?? null,
          lastName: userInfo?.lastName ?? null,
          username: userInfo?.username ?? null,
          emoji,
          date:
            typeof r.date === "number" && r.date > 0
              ? new Date(r.date * 1000).toISOString()
              : null,
        });
      }
      return out;
    } catch (err) {
      log.warn("getReactionList failed", {
        accountId,
        chatId,
        messageId,
        error: String(err).slice(0, 200),
      });
      return [];
    }
  }

  /**
   * P1 2026-05-20:抓 group / channel 的釘選訊息 id。
   *
   * 1:1 私訊回 null(我們不展示「自己跟自己的 pinned」)。Channel / Megagroup
   * 走 channels.GetFullChannel,普通 chat 走 messages.GetFullChat,兩者
   * `fullChat.pinnedMsgId` 都是 TG 端釘選那則訊息的 id(可能為 0 表示沒釘)。
   *
   * 注意:不主動每分鐘 poll — caller (API 路由)在使用者開對話時觸發 + UI
   * 在收到「客戶釘新訊息」的 service msg 時可選擇性 refresh。
   */
  async getPinnedMessageId(
    accountId: string,
    chatId: string,
  ): Promise<{ pinnedMessageId: string | null; error?: string }> {
    const managed = this.clients.get(accountId);
    if (!managed || managed.status !== "connected") {
      return { pinnedMessageId: null, error: "Account not connected" };
    }
    try {
      managed.lastUsed = Date.now();
      const Api = (await import("telegram")).Api;
      const peer = await managed.client.getInputEntity(chatId);
      let fullChat: Api.TypeChatFull | undefined;
      if (peer instanceof Api.InputPeerUser || peer instanceof Api.InputPeerSelf) {
        // 1:1 chat — TG 雖有 dialog-level pinned,但我們不在這呈現;一律 null。
        return { pinnedMessageId: null };
      }
      if (peer instanceof Api.InputPeerChannel) {
        const inputChannel = new Api.InputChannel({
          channelId: peer.channelId,
          accessHash: peer.accessHash,
        });
        const res = await managed.client.invoke(
          new Api.channels.GetFullChannel({ channel: inputChannel }),
        );
        fullChat = res.fullChat;
      } else if (peer instanceof Api.InputPeerChat) {
        const res = await managed.client.invoke(
          new Api.messages.GetFullChat({ chatId: peer.chatId }),
        );
        fullChat = res.fullChat;
      } else {
        return { pinnedMessageId: null };
      }
      const raw = (fullChat as { pinnedMsgId?: number | bigint } | undefined)?.pinnedMsgId;
      if (raw == null) return { pinnedMessageId: null };
      const idStr = typeof raw === "bigint" ? String(raw) : String(raw);
      // pinnedMsgId 為 0 / "0" 都表示「沒釘」
      if (idStr === "0") return { pinnedMessageId: null };
      return { pinnedMessageId: idStr };
    } catch (error: unknown) {
      const tgErr = asTgSendError(error);
      const errMsg = tgErr.errorMessage || tgErr.message || String(error);
      log.warn("getPinnedMessageId failed", { accountId, chatId, error: errMsg.slice(0, 200) });
      return { pinnedMessageId: null, error: errMsg };
    }
  }

  /**
   * 2026-05-21 二線:`messages.GetPinnedDialogs` — pull TG 端「釘選對話」清單。
   *
   * TG 客戶端讓使用者把對話釘到頂部(per-account 設定,跨裝置同步)。Switchboard 同步
   * 過來,讓員工在 Switchboard 看到的「釘選」狀態跟他們 TG 端一致。
   * 一次性 pull,bridge endpoint `/sync-pinned-dialogs` 觸發,結果寫到
   * `Group.conversationPinnedAt`(null=未釘,有時間=釘住的順序)。
   *
   * 範圍:只 folder 0(主清單)— 進階使用者用 multiple folders,我們暫不支援。
   */
  async getPinnedDialogIds(
    accountId: string,
  ): Promise<{ pinnedChatIds: string[]; error?: string }> {
    const managed = this.clients.get(accountId);
    if (!managed || managed.status !== "connected") {
      return { pinnedChatIds: [], error: "Account not connected" };
    }
    try {
      managed.lastUsed = Date.now();
      const result = await managed.client.invoke(
        new Api.messages.GetPinnedDialogs({ folderId: 0 }),
      );
      const dialogs = (result as unknown as {
        dialogs?: Array<{
          peer?: {
            className?: string;
            userId?: bigint | number;
            chatId?: bigint | number;
            channelId?: bigint | number;
          };
        }>;
      }).dialogs;
      if (!Array.isArray(dialogs)) return { pinnedChatIds: [] };
      const out: string[] = [];
      for (const d of dialogs) {
        const peer = d.peer;
        if (!peer) continue;
        if (peer.className === "PeerUser" && peer.userId != null) {
          out.push(String(peer.userId));
        } else if (peer.className === "PeerChat" && peer.chatId != null) {
          const raw = String(peer.chatId);
          out.push(raw.startsWith("-") ? raw : `-${raw}`);
        } else if (peer.className === "PeerChannel" && peer.channelId != null) {
          out.push(`-100${peer.channelId}`);
        }
      }
      return { pinnedChatIds: out };
    } catch (err) {
      const tgErr = asTgSendError(err);
      const errMsg = tgErr.errorMessage || tgErr.message || String(err);
      log.warn("getPinnedDialogIds failed", {
        accountId,
        error: errMsg.slice(0, 200),
      });
      return { pinnedChatIds: [], error: errMsg };
    }
  }

  /**
   * 2026-05-21 TG Business Phase B(round 4):pull TG server-side quick replies。
   * `messages.GetQuickReplies` 回傳該帳號設定的所有 server-side shortcut(employee 在
   * 任何 TG 客戶端上設定的 / 之 cross-device shortcut)。Switchboard 把它們 mirror 進
   * QuickReply 表,讓員工換到 Switchboard 操作時馬上有同樣的 / 觸發 word。
   *
   * 只有 TG Premium 帳號才能用 Business 功能;非 Premium 帳號呼叫會回空 set 或 error
   * (TG 並未一致報錯 — 我們把 error 完整 forward 給 caller)。
   */
  async getQuickReplies(
    accountId: string,
  ): Promise<{
    shortcuts: Array<{
      shortcutId: number;
      shortcut: string;
      topMessageId: number;
      count: number;
    }>;
    error?: string;
  }> {
    const managed = this.clients.get(accountId);
    if (!managed || managed.status !== "connected") {
      return { shortcuts: [], error: "Account not connected" };
    }
    try {
      managed.lastUsed = Date.now();
      const bigInt = (await import("big-integer")).default;
      const result = await managed.client.invoke(
        new Api.messages.GetQuickReplies({ hash: bigInt(0) }),
      );
      // Result type:messages.QuickReplies { quickReplies, messages, chats, users }
      // 或 messages.QuickRepliesNotModified(沒變動)。我們只關心 shortcuts。
      const arr = (result as unknown as {
        quickReplies?: Array<{
          shortcutId?: number;
          shortcut?: string;
          topMessage?: number;
          count?: number;
        }>;
      }).quickReplies;
      if (!Array.isArray(arr)) return { shortcuts: [] };
      return {
        shortcuts: arr
          .filter((q) => q.shortcutId != null && q.shortcut != null)
          .map((q) => ({
            shortcutId: q.shortcutId!,
            shortcut: q.shortcut!,
            topMessageId: q.topMessage ?? 0,
            count: q.count ?? 0,
          })),
      };
    } catch (err) {
      const tgErr = asTgSendError(err);
      const errMsg = tgErr.errorMessage || tgErr.message || String(err);
      log.warn("getQuickReplies failed", {
        accountId,
        error: errMsg.slice(0, 200),
      });
      return { shortcuts: [], error: errMsg };
    }
  }

  /**
   * 2026-05-21 TG Business Phase B:更新 away message。
   * `account.UpdateBusinessAwayMessage`:設定營業時間外自動回覆。
   * 傳 null/empty 等於關閉。
   */
  async updateBusinessAwayMessage(
    accountId: string,
    text: string | null,
  ): Promise<{ ok: boolean; error?: string }> {
    return this.updateBusinessSimpleMessage(
      accountId,
      "UpdateBusinessAwayMessage",
      text,
    );
  }

  async updateBusinessGreetingMessage(
    accountId: string,
    text: string | null,
  ): Promise<{ ok: boolean; error?: string }> {
    return this.updateBusinessSimpleMessage(
      accountId,
      "UpdateBusinessGreetingMessage",
      text,
    );
  }

  /**
   * 共用:account.UpdateBusinessAwayMessage / UpdateBusinessGreetingMessage 的 shape
   * 一樣 — { message?: BusinessAwayMessage|BusinessGreetingMessage }。
   * 都靠 InputBusinessAwayMessage / InputBusinessGreetingMessage 包文字 + schedule。
   *
   * 簡化:本回合只設「永遠開啟」(scheduleAlways)的 away message + 空 recipients
   * (對所有人)。詳細 schedule / recipients 之後 UI 接通再擴。
   */
  private async updateBusinessSimpleMessage(
    accountId: string,
    methodName: "UpdateBusinessAwayMessage" | "UpdateBusinessGreetingMessage",
    text: string | null,
  ): Promise<{ ok: boolean; error?: string }> {
    const managed = this.clients.get(accountId);
    if (!managed || managed.status !== "connected") {
      return { ok: false, error: "Account not connected" };
    }
    try {
      managed.lastUsed = Date.now();
      const ApiAny = Api as unknown as Record<string, unknown>;
      const accountNs = (ApiAny.account ?? {}) as Record<string, unknown>;
      const Method = accountNs[methodName] as
        | (new (params: { message?: unknown }) => { className: string })
        | undefined;
      if (!Method) {
        return {
          ok: false,
          error: `Method account.${methodName} not in this GramJS layer`,
        };
      }
      if (!text || text.trim().length === 0) {
        // 清除設定 → 不傳 message
        await managed.client.invoke(new Method({}) as unknown as Api.AnyRequest);
        return { ok: true };
      }
      // 構造 InputBusiness*Message — 不同 method 對應不同 Input class
      const InputName =
        methodName === "UpdateBusinessAwayMessage"
          ? "InputBusinessAwayMessage"
          : "InputBusinessGreetingMessage";
      const InputCtor = ApiAny[InputName] as
        | (new (params: Record<string, unknown>) => unknown)
        | undefined;
      if (!InputCtor) {
        return {
          ok: false,
          error: `${InputName} not in this GramJS layer`,
        };
      }
      // shortcutId 是 InputBusinessAwayMessage / GreetingMessage 必填欄(指向某個
      // quick reply 的 id)。MVP 我們直接送 0 / 1 — TG 會 fallback 用文字。實務上
      // 要先建 quick reply 再用它的 id;此 simplified 路徑只是 verify 通訊管道。
      const inputObj = new InputCtor({
        shortcutId: 0,
        ...(methodName === "UpdateBusinessAwayMessage"
          ? { schedule: new (ApiAny.BusinessAwayMessageScheduleAlways as new () => unknown)() }
          : {}),
        recipients: new (ApiAny.InputBusinessRecipients as new (
          p: Record<string, unknown>,
        ) => unknown)({}),
      });
      await managed.client.invoke(
        new Method({ message: inputObj }) as unknown as Api.AnyRequest,
      );
      return { ok: true };
    } catch (err) {
      const tgErr = asTgSendError(err);
      const errMsg = tgErr.errorMessage || tgErr.message || String(err);
      log.warn(`account.${methodName} failed`, {
        accountId,
        error: errMsg.slice(0, 200),
      });
      return { ok: false, error: errMsg };
    }
  }

  /**
   * 2026-05-21 TG Business Phase B:更新 work hours。
   * `account.UpdateBusinessWorkHours`:設定營業時間(weekly,跨午夜可分段)。
   * 傳 null 等於清除設定。
   *
   * hours.businessHours 結構符合 TG `BusinessWeeklyOpen`:
   *   { startMinute, endMinute }[]  — 從週一 00:00 起算的 minute 偏移
   * utcOffsetMinutes:該帳號所在地的 UTC offset(分鐘);Taipei = 480。
   */
  async updateBusinessWorkHours(
    accountId: string,
    hours: { startMinute: number; endMinute: number }[] | null,
    utcOffsetMinutes: number | null,
  ): Promise<{ ok: boolean; error?: string }> {
    const managed = this.clients.get(accountId);
    if (!managed || managed.status !== "connected") {
      return { ok: false, error: "Account not connected" };
    }
    try {
      managed.lastUsed = Date.now();
      const ApiAny = Api as unknown as Record<string, unknown>;
      const Method = (ApiAny.account as Record<string, unknown>)
        .UpdateBusinessWorkHours as
        | (new (params: { businessWorkHours?: unknown }) => unknown)
        | undefined;
      if (!Method) {
        return {
          ok: false,
          error: "account.UpdateBusinessWorkHours not in this GramJS layer",
        };
      }
      if (!hours || hours.length === 0) {
        await managed.client.invoke(
          new Method({}) as unknown as Api.AnyRequest,
        );
        return { ok: true };
      }
      const WeeklyOpenCtor = ApiAny.BusinessWeeklyOpen as
        | (new (p: { startMinute: number; endMinute: number }) => unknown)
        | undefined;
      const WorkHoursCtor = ApiAny.BusinessWorkHours as
        | (new (p: {
            timezoneId: string;
            weeklyOpen: unknown[];
          }) => unknown)
        | undefined;
      if (!WeeklyOpenCtor || !WorkHoursCtor) {
        return {
          ok: false,
          error: "BusinessWeeklyOpen / BusinessWorkHours not in this GramJS layer",
        };
      }
      // TG 的 timezoneId 是字串(e.g. "Asia/Taipei"),不是分鐘 offset。
      // 我們把 UTC offset 對應到最常用的 timezone — 不完美但 MVP 夠用。
      // 後續 UI 應該直接讓使用者選 IANA timezone。
      const utc = utcOffsetMinutes ?? 0;
      const timezoneId =
        utc === 480
          ? "Asia/Taipei"
          : utc === 540
            ? "Asia/Tokyo"
            : utc === 0
              ? "UTC"
              : utc < 0
                ? `Etc/GMT+${Math.round(-utc / 60)}`
                : `Etc/GMT-${Math.round(utc / 60)}`;
      await managed.client.invoke(
        new Method({
          businessWorkHours: new WorkHoursCtor({
            timezoneId,
            weeklyOpen: hours.map(
              (h) =>
                new WeeklyOpenCtor({
                  startMinute: h.startMinute,
                  endMinute: h.endMinute,
                }),
            ),
          }),
        }) as unknown as Api.AnyRequest,
      );
      return { ok: true };
    } catch (err) {
      const tgErr = asTgSendError(err);
      const errMsg = tgErr.errorMessage || tgErr.message || String(err);
      log.warn("account.UpdateBusinessWorkHours failed", {
        accountId,
        error: errMsg.slice(0, 200),
      });
      return { ok: false, error: errMsg };
    }
  }

  /**
   * 2026-05-21 訊息按鈕:點 callback 按鈕 → `messages.GetBotCallbackAnswer`。
   *
   * bot 收到 callback 後同步回一個「answer」:
   *   - message:要顯示給使用者的文字(toast 或彈窗)
   *   - alert:true = 用彈窗(modal),false = 用 toast
   *   - url:有的話客戶端要開這個連結(例:某些 bot 用 callback 按鈕跳轉)
   * bot 也常會「順便」編輯訊息(換頁/切狀態)— 那會走 UpdateEditMessage,
   * 由 handleEditedMessage + replyMarkup 同步處理,不在此函式內。
   *
   * @param dataBase64 base64 編碼的 callback bytes(從 NormalizedButton.data 來)
   */
  async clickCallbackButton(
    accountId: string,
    chatId: string,
    messageId: number,
    dataBase64: string,
  ): Promise<{
    ok: boolean;
    message?: string;
    alert?: boolean;
    url?: string;
    error?: string;
  }> {
    const managed = this.clients.get(accountId);
    if (!managed || managed.status !== "connected") {
      return { ok: false, error: "Account not connected" };
    }
    try {
      managed.lastUsed = Date.now();
      const peer = await managed.client.getInputEntity(chatId);
      const data = Buffer.from(dataBase64, "base64");
      const result = await managed.client.invoke(
        new Api.messages.GetBotCallbackAnswer({
          peer,
          msgId: messageId,
          data,
        }),
      );
      const r = result as unknown as {
        message?: string;
        alert?: boolean;
        url?: string;
      };
      return {
        ok: true,
        message: typeof r.message === "string" ? r.message : undefined,
        alert: r.alert === true,
        url: typeof r.url === "string" ? r.url : undefined,
      };
    } catch (err) {
      const tgErr = asTgSendError(err);
      const errMsg = tgErr.errorMessage || tgErr.message || String(err);
      log.warn("clickCallbackButton failed", {
        accountId,
        chatId,
        messageId,
        error: errMsg.slice(0, 200),
      });
      // DATA_INVALID / 過期的 callback data 給友善訊息
      if (errMsg.includes("DATA_INVALID")) {
        return { ok: false, error: "此按鈕已失效(訊息可能已更新,請重新整理)" };
      }
      if (errMsg.includes("BOT_RESPONSE_TIMEOUT")) {
        return { ok: false, error: "Bot 沒有回應(可能正忙或已離線)" };
      }
      return { ok: false, error: errMsg.slice(0, 120) };
    }
  }

  /**
   * 2026-05-21 TG parity:Native TG translation (`messages.TranslateText`)。
   *
   * TG 本身就附帶 server-side 翻譯服務(免費 + 高品質),呼叫一次回包含
   * `translatedText` 跟對應的 entities(若 source 有格式化)。
   * 我們把翻譯結果 cache 進 ConversationMessageTranslation,避免反覆打 API。
   *
   * 限制(實測中常見):
   *   - 對「沒提供 peer + msgId」的純字串翻譯也支援(provide `text` only),
   *     但會吃緊一點 quota — 偏好的用法是 peer + msgId 走第一條路。
   *   - 部分語言 / 過長文字 可能回 TRANSLATE_REQ_INVALID;我們把 error 完整 forward,
   *     UI 可選擇 fallback 到別的 provider(本 PR 不接,接 hook 而已)。
   *
   * 回傳結構:
   *   - text: 翻譯後字串
   *   - entities: 翻譯後對應 entities(可能跟原文不同位置)— 若有就 normalize 後存
   *   - error: 失敗時的訊息(API call 不丟,讓 caller 自己決定)
   */
  async translateMessage(
    accountId: string,
    chatId: string,
    platformMessageId: number,
    toLang: string,
  ): Promise<{
    text: string | null;
    entities: NormalizedMessageEntity[] | undefined;
    error?: string;
  }> {
    const managed = this.clients.get(accountId);
    if (!managed || managed.status !== "connected") {
      return { text: null, entities: undefined, error: "Account not connected" };
    }
    try {
      managed.lastUsed = Date.now();
      const peer = await managed.client.getInputEntity(chatId);
      const res = await managed.client.invoke(
        new Api.messages.TranslateText({
          peer,
          id: [platformMessageId],
          toLang,
        }),
      );
      // 回應 shape:{ result: Array<TextWithEntities> };result[0] = { text, entities }。
      const result = (res as unknown as {
        result?: Array<{ text?: string; entities?: unknown[] }>;
      }).result;
      const first = Array.isArray(result) ? result[0] : null;
      if (!first || typeof first.text !== "string") {
        return { text: null, entities: undefined, error: "Empty translation result" };
      }
      return {
        text: first.text,
        entities: normalizeEntities(first.entities),
      };
    } catch (error: unknown) {
      const tgErr = asTgSendError(error);
      const errMsg = tgErr.errorMessage || tgErr.message || String(error);
      log.warn("translateMessage failed", {
        accountId,
        chatId,
        platformMessageId,
        toLang,
        error: errMsg.slice(0, 200),
      });
      return { text: null, entities: undefined, error: errMsg };
    }
  }

  /**
   * 對 TG 訊息加上 emoji reaction（或清除 reaction）。
   *
   * Telegram 的 reaction 模型：每位使用者對單一訊息只能放 1 個 emoji（普通帳號）。
   * 重複設同一個 emoji = 切換掉。傳空陣列 = 清掉這個帳號對該訊息的 reaction。
   *
   * @param emoji 要設的 emoji 字串；傳 null/undefined = 清除 reaction
   */
  async sendReaction(
    accountId: string,
    chatId: string,
    messageId: number,
    emoji: string | null,
  ): Promise<{ success: boolean; error?: string }> {
    const managed = this.clients.get(accountId);
    if (!managed || managed.status !== "connected") {
      return { success: false, error: "Account not connected" };
    }
    try {
      managed.lastUsed = Date.now();
      // GramJS Api.messages.SendReaction：建構 ReactionEmoji 列表丟過去
      const Api = (await import("telegram")).Api;
      const peer = await managed.client.getInputEntity(chatId);

      // 預先檢查：若這個 chat 的「允許 reactions」是受限的（ChatReactionsSome），
      // 我們的 emoji 不在 allowed list → TG 會回 SEND_REACTION_RESULT1_INVALID（昨天 logs 看過）。
      // 直接攔下來給使用者清楚的中文訊息，避免 caller 看到 raw TG error。
      // 私訊（User）不會有此限制；只有 Channel / Chat 需要查。
      if (emoji) {
        const allowedCheck = await this.checkReactionAllowed(managed.client, peer, emoji);
        if (allowedCheck.disabled) {
          return { success: false, error: "此對話已停用 reactions（管理員設定）" };
        }
        if (allowedCheck.notAllowed) {
          const allowed = allowedCheck.allowedList?.length
            ? `；此對話只允許：${allowedCheck.allowedList.join(" ")}`
            : "";
          return { success: false, error: `此 emoji 在這個對話被禁用${allowed}` };
        }
      }

      const reaction = emoji
        ? [new Api.ReactionEmoji({ emoticon: emoji })]
        : []; // 空 = 清除
      const sendResult = await managed.client.invoke(
        new Api.messages.SendReaction({
          peer,
          msgId: messageId,
          reaction,
          // 明確不寫進 TG「最近用過的 reactions」 — 我們是客服場景，
          // 不希望 17 帳號的個人偏好被汙染。
          addToRecent: false,
        }),
      );

      // ─── 自己 react 的事件補發 ───────────────────────────────
      // GramJS 的 event dispatcher 不會把 RPC 回應的 updates 餵回 raw event
      // handler — 只處理 push update。這就是為什麼帳號 17 對自己訊息按
      // reaction 後，bridge listener 完全沒動靜（昨天觀察到的 bug）。
      //
      // 解法：手動 walk 過 SendReaction 的回應，挑出 UpdateMessageReactions
      // 並 dispatch 給我們自己的 handler。其他人 react 仍走原本 push update
      // 路徑（不會雙觸發）— 因為那走 event dispatcher 我們這裡只看 RPC response。
      try {
        const updates = this.extractUpdatesFromResponse(sendResult);
        for (const upd of updates) {
          if (
            upd instanceof Api.UpdateMessageReactions ||
            upd instanceof Api.UpdateBotMessageReactions
          ) {
            this.handleReactionUpdate(accountId, upd);
          }
        }
      } catch (dispatchErr) {
        log.warn("Failed to dispatch self-reaction update", {
          error: String(dispatchErr).slice(0, 200),
        });
      }

      return { success: true };
    } catch (error: unknown) {
      const tgErr = asTgSendError(error);
      const errMsg = tgErr.errorMessage || tgErr.message || String(error);
      // 把常見錯誤翻成有 actionable hint 的中文回給 UI
      const friendlyError = this.translateReactionError(errMsg);
      log.error("Failed to send reaction", {
        accountId,
        chatId,
        messageId,
        emoji,
        rawError: errMsg,
        friendlyError,
      });
      return { success: false, error: friendlyError };
    }
  }

  /**
   * 查詢一個 chat 是否允許指定 emoji reaction。
   *
   * 對於 Channel / Megagroup：呼叫 channels.GetFullChannel 拿 fullChat.availableReactions
   * 對於普通 Chat：呼叫 messages.GetFullChat
   * 對於 User（私聊）：直接視為允許（私聊預設全部 emoji）
   *
   * 失敗（peer 不可達 / 沒權限查）→ 回 unknown，呼叫端就直接送 reaction
   * 讓 TG 自己判斷（比預先擋掉誤殺好）。
   */
  private async checkReactionAllowed(
    client: TelegramClient,
    peer: Api.TypeInputPeer,
    emoji: string,
  ): Promise<{
    disabled?: boolean;
    notAllowed?: boolean;
    allowedList?: string[];
  }> {
    try {
      const Api = (await import("telegram")).Api;
      let fullChat: Api.TypeChatFull | undefined;
      // 直接識別 peer 類型：InputPeerUser / Channel / Chat
      if (peer instanceof Api.InputPeerUser || peer instanceof Api.InputPeerSelf) {
        return {}; // 私聊不限
      }
      if (peer instanceof Api.InputPeerChannel) {
        const inputChannel = new Api.InputChannel({
          channelId: peer.channelId,
          accessHash: peer.accessHash,
        });
        const res = await client.invoke(
          new Api.channels.GetFullChannel({ channel: inputChannel }),
        );
        fullChat = res.fullChat;
      } else if (peer instanceof Api.InputPeerChat) {
        const res = await client.invoke(
          new Api.messages.GetFullChat({ chatId: peer.chatId }),
        );
        fullChat = res.fullChat;
      } else {
        return {}; // 其他 peer 類型 — 不擋
      }
      const ar = (fullChat as { availableReactions?: Api.TypeChatReactions }).availableReactions;
      if (!ar) return {}; // 沒設 → 預設允許全部
      if (ar instanceof Api.ChatReactionsNone) {
        return { disabled: true };
      }
      if (ar instanceof Api.ChatReactionsAll) {
        return {}; // 全部允許
      }
      if (ar instanceof Api.ChatReactionsSome) {
        const allowed = ar.reactions
          .map((r) => (r instanceof Api.ReactionEmoji ? r.emoticon : null))
          .filter((s): s is string => !!s);
        if (allowed.includes(emoji)) return {};
        return { notAllowed: true, allowedList: allowed };
      }
      return {};
    } catch (err) {
      // 查不到（可能 peer 沒權限 / 暫時失敗）→ 不擋，讓 TG 自己判斷
      log.warn("checkReactionAllowed failed (skipping precheck)", {
        error: String(err).slice(0, 150),
      });
      return {};
    }
  }

  /**
   * 把 messages.SendReaction（或其他 invoke）的 RPC response 拆出 update list。
   *
   * TG 的 Updates 包裝有四種：
   *   - UpdatesCombined / Updates → updates: Update[]
   *   - UpdateShort → update: Update（單一）
   *   - UpdateShortMessage / UpdateShortChatMessage → 內嵌訊息（沒 reaction 用不到）
   *
   * 我們只需要從前兩個拆出來；後兩個對 reaction 用不到，回空陣列。
   */
  private extractUpdatesFromResponse(response: unknown): Api.TypeUpdate[] {
    if (!response || typeof response !== "object") return [];
    const r = response as {
      updates?: Api.TypeUpdate[];
      update?: Api.TypeUpdate;
    };
    if (Array.isArray(r.updates)) return r.updates;
    if (r.update) return [r.update];
    return [];
  }

  /**
   * 把 TG 端的 reaction error code 翻成可 actionable 的中文。
   * 對應 TG layer 198 觀察到的常見錯誤碼。
   */
  private translateReactionError(rawError: string): string {
    if (!rawError) return "Reaction 失敗（未知錯誤）";
    const code = rawError.toUpperCase();
    if (code.includes("REACTION_INVALID") || code.includes("REACTION_EMPTY")) {
      return "TG 拒絕了這個 emoji（可能是 chat 限制了允許清單，或這個 emoji 已下架）";
    }
    if (code.includes("RESULT1_INVALID") || code.includes("RESULT_INVALID")) {
      return "TG 拒絕了這個 reaction（chat 限制了允許清單，請換其他 emoji 試試）";
    }
    if (code.includes("MSG_ID_INVALID")) {
      return "找不到該訊息（可能已被刪除）";
    }
    if (code.includes("PEER_ID_INVALID")) {
      return "找不到該對話";
    }
    if (code.includes("CHAT_ADMIN_REQUIRED") || code.includes("ANONYMOUS_REACTIONS_DISABLED")) {
      return "此對話需要管理員權限才能 reaction";
    }
    if (code.includes("REACTIONS_TOO_MANY")) {
      return "你已對此訊息 react 過太多次了";
    }
    if (code.includes("FLOOD_WAIT")) {
      return "TG 限流中，請稍後再試";
    }
    // MESSAGE_NOT_MODIFIED / CHAT_NOT_MODIFIED：
    // TG 對「無法 react 的訊息」（系統服務訊息、或非真實同步的訊息）會回這個 —
    // 它沒有更精確的 code，就用「沒東西可改」來包裝。
    // 注意：測試用的 seed demo 訊息有假的 platformMessageId，不對應真實 TG 訊息，
    // react 時也會得到這個錯誤 — 真正連線的帳號對真實訊息 react 才會成功。
    if (code.includes("MESSAGE_NOT_MODIFIED") || code.includes("CHAT_NOT_MODIFIED")) {
      return "此訊息無法加表情（系統訊息，或此訊息不是從 Telegram 真實同步來的）";
    }
    return `TG 端錯誤：${rawError.slice(0, 100)}`;
  }

  async stopOne(accountId: string) {
    const managed = this.clients.get(accountId);
    if (managed) {
      // Remove event handlers before disconnect
      const handler = this.eventHandlers.get(accountId);
      if (handler) {
        managed.client.removeEventHandler(
          handler,
          new NewMessage({ incoming: true, outgoing: true }),
        );
        this.eventHandlers.delete(accountId);
      }
      const editedHandler = this.editedHandlers.get(accountId);
      if (editedHandler) {
        managed.client.removeEventHandler(editedHandler, new EditedMessage({}));
        this.editedHandlers.delete(accountId);
      }
      const deletedHandler = this.deletedHandlers.get(accountId);
      if (deletedHandler) {
        managed.client.removeEventHandler(deletedHandler, new DeletedMessage({}));
        this.deletedHandlers.delete(accountId);
      }
      try {
        await managed.client.disconnect();
      } catch {
        // Ignore disconnect errors
      }
      this.clients.delete(accountId);
    }
  }

  getStatus(): Record<string, { status: string; error?: string }> {
    const entries: Record<string, { status: string; error?: string }> = {};
    for (const [id, managed] of this.clients) {
      entries[id] = {
        status: managed.status,
        ...(managed.error && { error: managed.error }),
      };
    }
    return entries;
  }

  getWorkspaceId(accountId: string): string | undefined {
    return this.clients.get(accountId)?.workspaceId;
  }

  /**
   * Returns Telegram user IDs for every currently connected bridge account.
   * Used to detect and short-circuit self-forwarding loops when a bridge
   * account happens to sit on both sides of a pairing.
   */
  async getActiveTelegramUserIds(): Promise<string[]> {
    const accountIds = Array.from(this.clients.keys());
    if (accountIds.length === 0) return [];
    const accounts = await this.prisma.communicationAccount.findMany({
      where: { id: { in: accountIds } },
      select: { telegramUserId: true },
    });
    return accounts
      .map((a) => a.telegramUserId)
      .filter((id): id is string => Boolean(id));
  }

  /**
   * 取得指定 TG user 的基本 profile（透過任一個此 workspace 的 client）。
   * 用於「點擊使用者名稱彈窗」功能 — 抓 username / bio / status / phone。
   *
   * P2 2026-05-20 補:`status` 欄位 — 對應 TG UserStatus(Online / Offline /
   * Recently / LastWeek / LastMonth / Empty / Hidden)。對方有設「對誰隱藏
   * 上線狀態」privacy 時 TG 回 UserStatusEmpty,我們映到 "hidden"。
   */
  async getUserInfo(
    accountId: string,
    platformUserId: string,
  ): Promise<{
    firstName?: string;
    lastName?: string;
    username?: string;
    bio?: string;
    /** TG UserStatus → 結構化標籤 + (online 才有 expires / offline 才有 lastSeenAt) */
    status?: {
      kind: "online" | "offline" | "recently" | "lastWeek" | "lastMonth" | "hidden";
      /** Online 狀態的「下次 offline 預估時間」(秒級轉 ISO) */
      onlineUntil?: string;
      /** Offline 狀態的「上次在線時間」(秒級轉 ISO) */
      lastSeenAt?: string;
    };
    /** 對方公開的電話(很少有,通常 privacy 是關的) */
    phone?: string;
  } | null> {
    const managed = this.clients.get(accountId);
    if (!managed || managed.status !== "connected") return null;
    try {
      managed.lastUsed = Date.now();
      // 用 getEntity 拿基本欄位（first/last name, username, status）
      const entity = (await managed.client.getEntity(platformUserId)) as {
        firstName?: string;
        lastName?: string;
        username?: string;
        phone?: string;
        status?: { className?: string; expires?: number; wasOnline?: number };
      };

      // 對 entity.status 做結構化映射
      let status: {
        kind: "online" | "offline" | "recently" | "lastWeek" | "lastMonth" | "hidden";
        onlineUntil?: string;
        lastSeenAt?: string;
      } | undefined;
      const cn = entity.status?.className ?? "";
      if (cn.includes("UserStatusOnline")) {
        status = {
          kind: "online",
          onlineUntil:
            typeof entity.status?.expires === "number" && entity.status.expires > 0
              ? new Date(entity.status.expires * 1000).toISOString()
              : undefined,
        };
      } else if (cn.includes("UserStatusOffline")) {
        status = {
          kind: "offline",
          lastSeenAt:
            typeof entity.status?.wasOnline === "number" && entity.status.wasOnline > 0
              ? new Date(entity.status.wasOnline * 1000).toISOString()
              : undefined,
        };
      } else if (cn.includes("UserStatusRecently")) {
        status = { kind: "recently" };
      } else if (cn.includes("UserStatusLastWeek")) {
        status = { kind: "lastWeek" };
      } else if (cn.includes("UserStatusLastMonth")) {
        status = { kind: "lastMonth" };
      } else if (cn.includes("UserStatusEmpty") || !cn) {
        // 對方關了上線狀態 privacy → TG 回 Empty。我們稱為 "hidden"。
        status = { kind: "hidden" };
      }

      // bio 要透過 users.getFullUser 才能拿到。GramJS 暴露 invoke。
      let bio: string | undefined;
      try {
        // 動態 import 避免頂層耦合
        const { Api } = await import("telegram");
        const full = (await managed.client.invoke(
          new Api.users.GetFullUser({ id: platformUserId }),
        )) as unknown as { fullUser?: { about?: string } };
        bio = full?.fullUser?.about ?? undefined;
      } catch {
        // bio 拿不到不算錯
      }
      return {
        firstName: entity.firstName,
        lastName: entity.lastName,
        username: entity.username,
        phone: entity.phone || undefined,
        bio,
        status,
      };
    } catch (err) {
      log.warn("getUserInfo failed", {
        accountId,
        platformUserId,
        error: String(err).slice(0, 200),
      });
      return null;
    }
  }

  /**
   * 取得「指定 TG user 跟此帳號共有的 chat 清單」(messages.GetCommonChats)。
   * 用於 user profile 彈窗的「共同群」— 不依賴本地訊息紀錄，
   * 即使該 user 從未在某群裡說話，只要他在群裡且我們的帳號也在，就會列出來。
   *
   * 回傳的 chatId 已 normalize 成跟 DB Group.platformGroupId 一致的格式：
   *   - supergroup / channel：`-100<id>`
   *   - basic group：`-<id>`
   */
  async getCommonChats(
    accountId: string,
    platformUserId: string,
  ): Promise<Array<{ chatId: string; title: string }> | null> {
    const managed = this.clients.get(accountId);
    if (!managed || managed.status !== "connected") return null;
    try {
      managed.lastUsed = Date.now();
      const { Api } = await import("telegram");
      const bigInt = (await import("big-integer")).default;
      const userEntity = await managed.client.getEntity(platformUserId);
      // GramJS GetCommonChats 簽名要求：userId: EntityLike, maxId: BigInteger.
      // GramJS 對 EntityLike 的型別偶爾過嚴；用 unknown 強轉避免假錯誤。
      const params = {
        userId: userEntity,
        maxId: bigInt(0),
        limit: 100,
      } as unknown as ConstructorParameters<typeof Api.messages.GetCommonChats>[0];
      const result = (await managed.client.invoke(
        new Api.messages.GetCommonChats(params),
      )) as unknown as {
        chats?: Array<{
          className?: string;
          id?: { toString(): string } | string | number;
          title?: string;
          megagroup?: boolean;
        }>;
      };
      const chats = result?.chats ?? [];
      const out: Array<{ chatId: string; title: string }> = [];
      for (const c of chats) {
        if (!c.id) continue;
        const idStr = typeof c.id === "object" ? c.id.toString() : String(c.id);
        // Channel / Supergroup → -100 前綴；basic Chat → 負號前綴
        const cls = c.className ?? "";
        let normalized: string;
        if (cls === "Channel") normalized = `-100${idStr}`;
        else if (cls === "Chat") normalized = `-${idStr}`;
        else normalized = idStr;
        out.push({ chatId: normalized, title: c.title ?? "(未命名)" });
      }
      return out;
    } catch (err) {
      log.warn("getCommonChats failed", {
        accountId,
        platformUserId,
        error: String(err).slice(0, 200),
      });
      return null;
    }
  }

  async stopAll() {
    for (const [accountId] of this.clients) {
      await this.stopOne(accountId);
    }
  }

  /** Get list of account's saved sticker sets. */
  async getStickerSets(accountId: string): Promise<{
    id: string; accessHash: string; title: string; shortName: string; count: number;
  }[]> {
    const managed = this.clients.get(accountId);
    if (!managed || managed.status !== "connected") return [];
    try {
      const result = await managed.client.invoke(
        new Api.messages.GetAllStickers({ hash: bigInt(0) }),
      );
      if (result.className === "messages.AllStickersNotModified") return [];
      return (result as Api.messages.AllStickers).sets.map((s) => {
        const set = s as Api.StickerSet;
        return {
          id: set.id.toString(),
          accessHash: set.accessHash.toString(),
          title: set.title,
          shortName: set.shortName,
          count: set.count,
        };
      });
    } catch (err) {
      log.warn("getStickerSets failed", { accountId, error: String(err) });
      return [];
    }
  }

  /** Get stickers in a specific set. */
  async getStickerSetStickers(
    accountId: string, id: string, accessHash: string,
  ): Promise<{
    id: string; accessHash: string; fileReference: string;
    emoji: string; mimeType: string;
  }[]> {
    const managed = this.clients.get(accountId);
    if (!managed || managed.status !== "connected") return [];
    try {
      const result = await managed.client.invoke(
        new Api.messages.GetStickerSet({
          stickerset: new Api.InputStickerSetID({ id: bigInt(id), accessHash: bigInt(accessHash) }),
          hash: 0,
        }),
      );
      // Cast to the concrete StickerSet shape (not StickerSetNotModified)
      const stickerSet = result as Api.messages.StickerSet;
      // Build emoji map: document id → emoticon
      const emojiMap = new Map<string, string>();
      for (const pack of stickerSet.packs) {
        const sp = pack as Api.StickerPack;
        for (const docId of sp.documents) {
          emojiMap.set(docId.toString(), sp.emoticon);
        }
      }
      return stickerSet.documents
        .filter((d) => (d as { className?: string }).className === "Document")
        .map((d) => {
          const doc = d as Api.Document;
          return {
            id: doc.id.toString(),
            accessHash: doc.accessHash.toString(),
            fileReference: Buffer.from(doc.fileReference as Buffer).toString("base64"),
            emoji: emojiMap.get(doc.id.toString()) ?? "🎭",
            mimeType: doc.mimeType ?? "image/webp",
          };
        });
    } catch (err) {
      log.warn("getStickerSetStickers failed", { accountId, id, error: String(err) });
      return [];
    }
  }

  /** Download a sticker's file bytes (for thumbnail proxy). */
  async downloadStickerMedia(
    accountId: string, docId: string, accessHash: string, fileReference: string,
  ): Promise<Buffer | null> {
    const managed = this.clients.get(accountId);
    if (!managed || managed.status !== "connected") return null;
    try {
      const buf = await managed.client.downloadFile(
        new Api.InputDocumentFileLocation({
          id: bigInt(docId),
          accessHash: bigInt(accessHash),
          fileReference: Buffer.from(fileReference, "base64"),
          thumbSize: "",
        }),
        {},
      );
      if (!buf) return null;
      return Buffer.from(buf as Uint8Array);
    } catch (err) {
      log.warn("downloadStickerMedia failed", { accountId, docId, error: String(err) });
      return null;
    }
  }

  /** Send an existing TG sticker document to a chat. */
  async sendStickerDocument(
    accountId: string, chatId: string,
    docId: string, accessHash: string, fileReference: string,
  ): Promise<SendResult> {
    const managed = this.clients.get(accountId);
    if (!managed || managed.status !== "connected") {
      return { success: false, error: "Account not connected" };
    }
    try {
      managed.lastUsed = Date.now();
      let peer: Api.TypeInputPeer;
      try {
        peer = await managed.client.getInputEntity(chatId) as Api.TypeInputPeer;
      } catch {
        peer = chatId as unknown as Api.TypeInputPeer;
      }
      const result = await managed.client.invoke(
        new Api.messages.SendMedia({
          peer,
          media: new Api.InputMediaDocument({
            id: new Api.InputDocument({
              id: bigInt(docId),
              accessHash: bigInt(accessHash),
              fileReference: Buffer.from(fileReference, "base64"),
            }),
            ttlSeconds: 0,
          }),
          message: "",
          randomId: bigInt(Math.floor(Math.random() * 2 ** 52)),
        }),
      );
      const updates = (result as { updates?: unknown[] }).updates ?? [];
      const sentId = updates
        .map((u) => (u as { id?: number }).id)
        .find((id) => id !== undefined);
      return { success: true, sentMessageId: sentId?.toString() };
    } catch (error) {
      log.error("sendStickerDocument failed", { accountId, chatId, docId, error: String(error) });
      return { success: false, error: String(error) };
    }
  }

  startHealthCheck() {
    this.healthCheckInterval = setInterval(async () => {
      for (const [accountId, mc] of this.clients.entries()) {
        try {
          if (mc.client.connected) continue;
          log.warn("Client disconnected, attempting reconnect", { accountId });
          await this.stopOne(accountId);
          await this.startOne(accountId);
        } catch (error) {
          log.error("Health check reconnect failed", { accountId, error: String(error) });
        }
      }
    }, 60000); // Check every 60 seconds
  }

  stopHealthCheck() {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }
  }
}
