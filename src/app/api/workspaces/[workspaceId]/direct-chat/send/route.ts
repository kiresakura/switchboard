import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { MessageType } from "@prisma/client";
import { requireWorkspacePermission } from "@/lib/auth/middleware";
import { resolveVisibleAccountIds } from "@/lib/account-visibility";
import { logAudit } from "@/lib/audit/logger";
import { logger } from "@/lib/logger";
import { MediaFileManager } from "@/lib/media/file-manager.server";
import type { NativeOutboundPayload } from "@/lib/telegram/client-manager";
import { normalizeNativeOutboundPayload } from "@/lib/telegram/native-outbound";

/** Map MIME type → Prisma MessageType enum. Mirrors inferMessageType() on the client. */
function mimeToMessageType(mime: string): MessageType {
  if (mime.startsWith("image/")) return MessageType.IMAGE;
  if (mime.startsWith("video/")) return MessageType.VIDEO;
  if (mime.startsWith("audio/")) return MessageType.AUDIO;
  return MessageType.DOCUMENT;
}

function nativeDbFields(payload: NativeOutboundPayload, bridgeResult?: { messageType?: MessageType | string; content?: string; mediaMetadata?: unknown }) {
  const fallback = (() => {
    switch (payload.kind) {
      case "location": return { messageType: MessageType.LOCATION, content: "📍 位置", mediaMetadata: { geo: { lat: payload.lat, lng: payload.lng, ...(payload.livePeriod ? { livePeriod: payload.livePeriod } : {}) } } };
      case "contact": return { messageType: MessageType.CONTACT, content: `👤 ${payload.firstName}${payload.lastName ? ` ${payload.lastName}` : ""}`, mediaMetadata: { contact: { firstName: payload.firstName, lastName: payload.lastName, phone: payload.phone, userId: payload.userId } } };
      case "poll": return { messageType: MessageType.POLL, content: `📊 ${payload.question}`, mediaMetadata: { poll: { question: payload.question, options: payload.options.map((text) => ({ text })), totalVoters: 0, closed: payload.closed === true } } };
      case "dice": return { messageType: MessageType.DICE, content: payload.emoticon, mediaMetadata: { dice: { emoticon: payload.emoticon } } };
      case "story": return { messageType: MessageType.STORY, content: "📖 Telegram Story", mediaMetadata: { story: { peerId: payload.peerId, storyId: payload.storyId, expired: false } } };
    }
  })();
  return {
    messageType: Object.values(MessageType).includes(bridgeResult?.messageType as MessageType) ? bridgeResult?.messageType as MessageType : fallback.messageType,
    content: typeof bridgeResult?.content === "string" ? bridgeResult.content : fallback.content,
    mediaMetadata: bridgeResult?.mediaMetadata ?? fallback.mediaMetadata,
  };
}

const log = logger("DirectChat");

type RouteParams = { params: Promise<{ workspaceId: string }> };

const BRIDGE_URL = process.env.BRIDGE_URL || `http://localhost:${process.env.BRIDGE_PORT || 3001}`;
const INTERNAL_SECRET = process.env.INTERNAL_SECRET;
if (!INTERNAL_SECRET) {
  log.error("INTERNAL_SECRET is not set — bridge communication will fail");
}

// POST /api/workspaces/:id/direct-chat/send
export async function POST(req: Request, { params }: RouteParams) {
  const { workspaceId } = await params;
  const auth = await requireWorkspacePermission(workspaceId, "canSendManualMessages");
  if (auth instanceof NextResponse) return auth;

  let body: {
    groupId?: string;
    accountId?: string;
    content?: string;
    // Optional attachment — when present, send as a native Telegram file
    // (image/document) instead of text. The app uploads the file first via
    // /api/upload and passes the resulting mediaFileId here; the bridge
    // opens the local file and calls sendFile.
    mediaFileId?: string;
    replyToMessageId?: string;
    /**
     * P3 排程發送 — ISO 8601 字串。後端轉成 Unix sec 給 bridge。必須是未來
     * 時間且至少 10 秒後;低於門檻或非 ISO format → 400。
     */
    scheduleDate?: string;
    /**
     * 2026-05-21 TG parity — Quote-reply on send。
     * 員工拖選原訊息一段文字當 "引用片段"。需與 replyToMessageId 同時提供。
     * quoteOffset = 該片段在原訊息字串中的起始 char offset(從 0 起算)。
     * 純文字 quote 即可,UI 端目前不送 quoteEntities。
     */
    quoteText?: string;
    quoteOffset?: number;
    /** Native outbound Telegram payload: poll/contact/location/dice/story reference. */
    native?: NativeOutboundPayload;
    /** Forum topic top message id. */
    topicId?: number;
    /** Voice/video-note flags for mediaFileId sends. */
    mediaMode?: "file" | "voiceNote" | "videoNote";
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "無效的請求內容" }, { status: 400 });
  }
  const {
    groupId,
    accountId,
    content,
    mediaFileId,
    scheduleDate,
    replyToMessageId,
    quoteText,
    quoteOffset,
    native,
    topicId,
    mediaMode,
  } = body;

  // 解析 scheduleDate(ISO → Unix sec)。bridge 對 < 10 秒未來 / 過去時間
  // 也會 reject,前端最好也提示;這裡多做一層 server-side 驗證避免錯誤往下流。
  let scheduleDateUnix: number | null = null;
  if (scheduleDate) {
    const d = new Date(scheduleDate);
    if (Number.isNaN(d.getTime())) {
      return NextResponse.json(
        { error: "scheduleDate 不是合法 ISO 時間" },
        { status: 400 }
      );
    }
    const diffSec = (d.getTime() - Date.now()) / 1000;
    if (diffSec < 10) {
      return NextResponse.json(
        { error: "排程時間至少要 10 秒之後" },
        { status: 400 }
      );
    }
    scheduleDateUnix = Math.floor(d.getTime() / 1000);
  }

  if (!groupId || !accountId) {
    return NextResponse.json(
      { error: "groupId、accountId 為必填" },
      { status: 400 }
    );
  }

  // Allow either text (content), file (mediaFileId), or native Telegram payload; at least one required.
  if (!content && !mediaFileId && !native) {
    return NextResponse.json(
      { error: "content、mediaFileId 或 native 至少需其一" },
      { status: 400 }
    );
  }

  // Native Telegram payloads are standalone message types in this route.
  // Reject mixed requests so callers cannot accidentally send/persist a
  // different payload than intended via precedence rules (media > native > text).
  if (native && (mediaFileId || (typeof content === "string" && content.trim().length > 0))) {
    return NextResponse.json(
      { error: "native payload 不能與 content 或 mediaFileId 混用" },
      { status: 400 },
    );
  }

  const validTopicId =
    typeof topicId === "number" && Number.isFinite(topicId) && topicId > 0
      ? Math.floor(topicId)
      : null;
  if (topicId != null && validTopicId == null) {
    return NextResponse.json(
      { error: "topicId 不合法" },
      { status: 400 },
    );
  }

  // GramJS sendFile currently does not route attachments through forum topics.
  // Fail closed instead of letting the UI believe a topic attachment was sent
  // there while Telegram/DB record it in the main chat.
  if (mediaFileId && validTopicId != null) {
    return NextResponse.json(
      { error: "目前不支援在 forum topic 內發送檔案附件" },
      { status: 400 },
    );
  }

  const normalizedNative = native ? normalizeNativeOutboundPayload(native) : null;
  if (native && !normalizedNative) {
    return NextResponse.json({ error: "native payload 不合法" }, { status: 400 });
  }

  if (content != null && (typeof content !== "string" || content.length > 4096)) {
    return NextResponse.json(
      { error: "內容必須為字串且不超過 4096 字元" },
      { status: 400 }
    );
  }

  // Verify account belongs to workspace and is active
  const account = await prisma.communicationAccount.findFirst({
    where: { id: accountId, workspaceId, status: "ACTIVE" },
  });

  if (!account) {
    return NextResponse.json(
      { error: "找不到帳號或該帳號未啟用" },
      { status: 404 }
    );
  }

  // 可見性:員工只能用自己被指派 / 代理的帳號發送(2026-05-21 review 補) ——
  // 否則可冒用同事的 TG 帳號對外發訊息。
  const visible = await resolveVisibleAccountIds({
    userId: auth.userId,
    workspaceId,
    isSystemAdmin: auth.isSystemAdmin,
    permissions: auth.permissions,
  });
  if (!visible.has(accountId)) {
    return NextResponse.json(
      { error: "無權使用此帳號發送訊息" },
      { status: 403 }
    );
  }

  // Verify group belongs to workspace, is active, and is a conversation this
  // account actually participates in(擋「用自己帳號往不相干對話發訊息」)。
  const group = await prisma.group.findFirst({
    where: {
      id: groupId,
      workspaceId,
      isActive: true,
      accountMemberships: { some: { accountId } },
    },
  });

  if (!group) {
    return NextResponse.json(
      { error: "找不到群組" },
      { status: 404 }
    );
  }

  if (normalizedNative?.kind === "story") {
    const storyPeer = await prisma.group.findFirst({
      where: {
        workspaceId,
        platformGroupId: normalizedNative.peerId,
        isActive: true,
        accountMemberships: { some: { accountId } },
      },
      select: { id: true },
    });
    if (!storyPeer) {
      return NextResponse.json(
        { error: "無法驗證 story peer 屬於目前工作區/帳號可見對話，已拒絕發送" },
        { status: 403 },
      );
    }
  }

  if (validTopicId != null) {
    const knownTopic = await prisma.directChatMessage.findFirst({
      where: { workspaceId, groupId, topicId: validTopicId },
      select: { id: true },
    });
    if (!knownTopic) {
      return NextResponse.json(
        { error: "無法驗證 topicId 屬於此群組的已知 topic，已拒絕發送" },
        { status: 400 },
      );
    }
  }

  // Load the attachment buffer if present. Bridge previously expected a
  // local file path under /app/uploads, but on Railway the bridge container
  // is separate from the app container and Railway volumes are
  // single-service — bridge cannot see what app wrote to disk. Switch to
  // streaming the file bytes over HTTP via the bridge /send-file endpoint
  // (raw octet-stream body, metadata in custom headers).
  let mediaPayload: {
    buffer: Buffer;
    fileName: string;
    mimeType: string;
  } | null = null;
  if (mediaFileId) {
    const fileData = await MediaFileManager.getFile(mediaFileId);
    if (!fileData || fileData.record.workspaceId !== workspaceId) {
      return NextResponse.json(
        { error: "找不到檔案或無權存取" },
        { status: 404 },
      );
    }
    mediaPayload = {
      buffer: fileData.buffer,
      fileName: fileData.record.originalName,
      mimeType: fileData.record.mimeType,
    };
  }

  if (mediaPayload && mediaMode === "voiceNote" && !mediaPayload.mimeType.startsWith("audio/")) {
    return NextResponse.json({ error: "voiceNote 僅支援 audio/* 檔案" }, { status: 400 });
  }
  if (mediaPayload && mediaMode === "videoNote" && !mediaPayload.mimeType.startsWith("video/")) {
    return NextResponse.json({ error: "videoNote 僅支援 video/* 檔案" }, { status: 400 });
  }

  const effectiveTopicId = mediaPayload ? null : validTopicId;

  // Send via Telegram bridge — /send-file for native attachment, /send for text.
  let sent = false;
  let platformMessageId: string | null = null;
  let nativeBridgeResult: { messageType?: MessageType | string; content?: string; mediaMetadata?: unknown } | undefined;
  try {
    if (mediaPayload) {
      const headers: Record<string, string> = {
        "Content-Type": "application/octet-stream",
        Authorization: `Bearer ${INTERNAL_SECRET || ""}`,
        "X-Account-Id": accountId,
        "X-Chat-Id": String(group.platformGroupId),
        // Filenames may contain non-ASCII (中文 etc.). Header values must be
        // ASCII-safe → URI encode and let bridge decode.
        "X-File-Name": encodeURIComponent(mediaPayload.fileName),
        "X-Mime-Type": mediaPayload.mimeType,
      };
      if (content) headers["X-Caption"] = encodeURIComponent(content);
      if (effectiveTopicId != null) headers["X-Topic-Id"] = String(effectiveTopicId);
      if (mediaMode === "voiceNote") headers["X-Voice-Note"] = "1";
      if (mediaMode === "videoNote") headers["X-Video-Note"] = "1";
      if (mediaMode === "videoNote") headers["X-Supports-Streaming"] = "1";

      const bridgeRes = await fetch(`${BRIDGE_URL}/send-file`, {
        method: "POST",
        headers,
        body: new Uint8Array(mediaPayload.buffer),
        // 60s — file 上傳到 TG(含縮圖、加密)端到端延遲較高
        signal: AbortSignal.timeout(60_000),
      });
      if (bridgeRes.ok) {
        const result = await bridgeRes.json();
        sent = result.success;
        if (result.sentMessageId) {
          platformMessageId = String(result.sentMessageId);
        }
      } else {
        const errBody = await bridgeRes.text().catch(() => "");
        log.warn("Bridge /send-file rejected", {
          status: bridgeRes.status,
          body: errBody.slice(0, 200),
        });
      }
    } else if (normalizedNative) {
      let replyToNumeric: number | null = null;
      if (replyToMessageId) {
        const n = Number(replyToMessageId);
        if (Number.isFinite(n) && n > 0) replyToNumeric = n;
      }
      const bridgeRes = await fetch(`${BRIDGE_URL}/send-native`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${INTERNAL_SECRET || ""}`,
        },
        body: JSON.stringify({
          accountId,
          chatId: group.platformGroupId,
          native: normalizedNative,
          replyTo: replyToNumeric,
          topicId: effectiveTopicId,
          scheduleDate: scheduleDateUnix,
        }),
        signal: AbortSignal.timeout(20_000),
      });
      if (bridgeRes.ok) {
        const result = await bridgeRes.json();
        sent = result.success;
        if (result.sentMessageId) platformMessageId = String(result.sentMessageId);
        nativeBridgeResult = result;
      } else {
        const errBody = await bridgeRes.text().catch(() => "");
        log.warn("Bridge /send-native rejected", { status: bridgeRes.status, body: errBody.slice(0, 200) });
      }
    } else {
      // 解析 replyToMessageId(字串型 platformMessageId → 數字)+ quote。
      // quote 需與 replyToMessageId 同時提供,否則忽略(TG 規格)。
      let replyToNumeric: number | null = null;
      if (replyToMessageId) {
        const n = Number(replyToMessageId);
        if (Number.isFinite(n) && n > 0) replyToNumeric = n;
      }
      const quotePayload =
        replyToNumeric != null &&
        typeof quoteText === "string" &&
        quoteText.length > 0
          ? {
              quoteText,
              quoteOffset:
                typeof quoteOffset === "number" && Number.isFinite(quoteOffset) && quoteOffset >= 0
                  ? Math.floor(quoteOffset)
                  : 0,
            }
          : null;
      const bridgeRes = await fetch(`${BRIDGE_URL}/send`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${INTERNAL_SECRET || ""}`,
        },
        body: JSON.stringify({
          accountId,
          chatId: group.platformGroupId,
          text: content,
          replyTo: replyToNumeric,
          quote: quotePayload,
          // 跳過 bridge 內建的 archive — 下方我們自己寫一筆 DirectChatMessage,
          // 不跳過會雙倍寫入造成 UI 雙泡泡
          skipArchive: true,
          // P3 schedule:Unix sec
          scheduleDate: scheduleDateUnix,
          topicId: effectiveTopicId,
        }),
        // 15s — 純文字訊息正常 1-2s，留 buffer 給 GramJS 偶發抖動
        signal: AbortSignal.timeout(15_000),
      });
      if (bridgeRes.ok) {
        const result = await bridgeRes.json();
        sent = result.success;
        if (result.sentMessageId) {
          platformMessageId = String(result.sentMessageId);
        }
      } else {
        const errBody = await bridgeRes.text().catch(() => "");
        log.warn("Bridge /send rejected", {
          status: bridgeRes.status,
          bridgeUrl: BRIDGE_URL,
          body: errBody.slice(0, 200),
        });
      }
    }
  } catch (err) {
    // Bridge might not be running — log but don't fail
    log.warn("Bridge not available, message not sent via TG", {
      bridgeUrl: BRIDGE_URL,
      error: String(err),
    });
  }

  // Build media fields for the DB record.
  // Previously these were omitted — causing sent images to lose their mediaUrl
  // on DB reload (switching conversations triggered a re-fetch that returned
  // the media-less DB record, making images disappear) and preventing them from
  // appearing in the media gallery.
  const mediaDbFields = mediaPayload
    ? {
        messageType:
          mediaMode === "voiceNote"
            ? MessageType.VOICE
            : mediaMode === "videoNote"
              ? MessageType.VIDEO_NOTE
              : mimeToMessageType(mediaPayload.mimeType),
        mediaUrl: `/api/media/${mediaFileId}`,   // same URL /api/upload returned
        mediaType: mediaPayload.mimeType,
        mediaFileName: mediaPayload.fileName,
      }
    : {};

  const nativeFields = normalizedNative ? nativeDbFields(normalizedNative, nativeBridgeResult) : null;

  // Persist direct chat message to DB. For file-only sends, mark content as
  // the caption (may be empty) — DB requires content non-null, so use ""
  // when the operator sent a pure attachment with no caption.
  // deliveredAt (2026-05-21 Backend-first):成功送到 TG 伺服器 = 「delivered」
  // (TG 沒有區分「server-received」和「device-received」,2-tick 即此狀態);
  // 失敗 / 仍在 retry 維持 null → bubble 顯示 1 grey tick。
  const chatMessage = await prisma.directChatMessage.create({
    data: {
      workspaceId,
      accountId,
      groupId,
      senderId: auth.userId,
      content: nativeFields?.content ?? content ?? "",
      messageType: nativeFields?.messageType ?? mediaDbFields.messageType ?? MessageType.TEXT,
      sentViaTelegram: sent,
      platformMessageId,
      deliveredAt: sent ? new Date() : null,
      topicId: effectiveTopicId,
      ...(nativeFields?.mediaMetadata !== undefined ? { mediaMetadata: nativeFields.mediaMetadata } : {}),
      // 2026-05-21 TG parity:reply + quote-reply 也存進 DCM,
      // 讓 chat-bubble 在 own outbound 上一樣能渲染 reply preview + 引用 chip。
      replyToPlatformId: replyToMessageId ?? null,
      quoteText:
        typeof quoteText === "string" && quoteText.length > 0 ? quoteText : null,
      ...mediaDbFields,
    },
  });

  await prisma.group.update({
    where: { id: groupId },
    data: {
      lastOutboundAt: chatMessage.createdAt,
      conversationStatus: "OPEN",
      conversationClosedAt: null,
    },
  }).catch(() => null);

  await logAudit({
    workspaceId,
    userId: auth.userId,
    action: "direct_chat.send",
    entityType: "DirectMessage",
    entityId: chatMessage.id,
    details: {
      accountId,
      groupId,
      groupTitle: group.title,
      contentPreview: (content ?? "").substring(0, 100),
      sentViaTelegram: sent,
    },
  });

  // 把 platformMessageId + media 欄位一起回給前端,讓 optimistic message 可以立即
  // 拿到「TG 那邊的 message id」— 後續 edit / delete / reaction 不必等
  // reload 從 DB 重 fetch 才有,UI 一發出就能 hover 到完整 toolbar。
  // media 欄位回傳:確保 optimistic reconcile 時 mediaUrl / messageType 和
  // DB 一致,避免下次 fetchChat 用 DB 值覆蓋時圖片消失。
  return NextResponse.json({
    success: true,
    sent,
    messageId: chatMessage.id,
    platformMessageId,
    messageType: nativeFields?.messageType ?? mediaDbFields.messageType ?? MessageType.TEXT,
    content: nativeFields?.content ?? content ?? "",
    topicId: effectiveTopicId,
    ...(nativeFields?.mediaMetadata !== undefined ? { mediaMetadata: nativeFields.mediaMetadata } : {}),
    ...(mediaDbFields.mediaUrl
      ? {
          mediaUrl: mediaDbFields.mediaUrl,
          mediaType: mediaDbFields.mediaType,
          mediaFileName: mediaDbFields.mediaFileName,
        }
      : {}),
  });
}
