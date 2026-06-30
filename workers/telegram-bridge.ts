/**
 * Telegram Bridge Worker
 *
 * Long-running process that:
 * 1. Connects to all active Telegram accounts via GramJS
 * 2. Listens for incoming messages
 * 3. Routes incoming messages into the workspace conversation pipeline
 * 4. Writes results to the database
 * 5. Notifies the Next.js app via internal HTTP API for SSE push
 * 6. Periodically discovers new groups and cleans up stale locks
 *
 * Run with: npm run bridge
 */

import { PrismaClient, Prisma, type MessageType } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { timingSafeEqual, randomBytes } from "crypto";
import fs from "fs/promises";
import path from "path";
import { ClientManager, type NativeOutboundPayload, type TelegramAdminAction } from "../src/lib/telegram/client-manager";
import { normalizeTelegramAdminAction } from "../src/lib/telegram/admin-action";
import { normalizeNativeOutboundPayload } from "../src/lib/telegram/native-outbound";
import { MediaFileManager, type FileUploadResult } from "../src/lib/media/file-manager";
import { logger } from "../src/lib/logger";
import { acquireBridgeLock, type SingletonLock } from "../src/lib/bridge/singleton-lock";
import { upsertAccountFolders } from "../src/lib/telegram/folder-sync";
import { isPlaceholderSecret } from "../src/lib/security/secret-guard";

const log = logger("Bridge");

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
const prisma = new PrismaClient({ adapter });
const clientManager = new ClientManager(prisma);

// (Failure tracker for broker retry backoff removed in H3 — the pipeline
// that consumed it is gone. Per-pairing message-ordering queue removed
// for the same reason. If the archive path later needs per-chat ordering
// it should re-introduce a similar primitive.)

const APP_URL = process.env.APP_INTERNAL_URL || "http://localhost:3000";
const INTERNAL_SECRET = process.env.INTERNAL_SECRET;
if (!INTERNAL_SECRET) {
  log.error("FATAL: INTERNAL_SECRET is not set! Bridge-to-app communication will be rejected.");
  process.exit(1);
}
// C3: refuse to run on the public build-time placeholder / dev default secret.
if (process.env.NODE_ENV === "production" && isPlaceholderSecret(INTERNAL_SECRET)) {
  log.error("FATAL: INTERNAL_SECRET is a build-time/dev placeholder. Set a real secret (openssl rand -hex 32).");
  process.exit(1);
}
const BRIDGE_PORT = parseInt(process.env.BRIDGE_PORT || "3001");

// S4 fix: timing-safe secret verification
function verifySecret(authHeader: string | undefined): boolean {
  if (!INTERNAL_SECRET || !authHeader) return false;
  const expected = `Bearer ${INTERNAL_SECRET}`;
  if (authHeader.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(authHeader), Buffer.from(expected));
}

// ─── SSE Notification ──────────────────────────────────────────

const NOTIFY_MAX_RETRIES = 3;
const NOTIFY_BASE_DELAY_MS = 1000;

async function notifyApp(event: {
  type: string;
  workspaceId: string;
  data: Record<string, unknown>;
}) {
  for (let attempt = 0; attempt <= NOTIFY_MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(`${APP_URL}/api/internal/telegram-event`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${INTERNAL_SECRET}`,
        },
        body: JSON.stringify(event),
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) return; // success
      log.warn(`notifyApp got ${res.status}`, { attempt: attempt + 1, maxAttempts: NOTIFY_MAX_RETRIES + 1 });
    } catch (error) {
      log.warn(`notifyApp failed`, { attempt: attempt + 1, maxAttempts: NOTIFY_MAX_RETRIES + 1, error: String(error) });
    }
    if (attempt < NOTIFY_MAX_RETRIES) {
      await new Promise((r) => setTimeout(r, NOTIFY_BASE_DELAY_MS * Math.pow(2, attempt)));
    }
  }
  log.error("notifyApp exhausted all retries", { eventType: event.type });
}

// ─── Message Pipeline ──────────────────────────────────────────

clientManager.setMessageHandler(async (params) => {
  const {
    accountId,
    chatId,
    chatTitle,
    senderId,
    senderName,
    messageId,
    replyToMessageId,
    date,
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
  } = params;
  let text = params.text;

  // Skip empty messages (unless has media)
  if (!text.trim() && messageType === 'TEXT') return;

  // 1:1 private chats (chatId is a positive int = user id) are now captured
  // into the archival path (DirectChatMessage with direction=INBOUND) so the
  // direct-chat UI can surface them. (Spec 2026-04-23 "所有的訊息都監聽".)
  const isPrivateChat = !chatId.startsWith("-");

  // 判斷此訊息是否「我們自己這側」發出 — 兩種情況：
  //   (a) GramJS 標記 isOutgoing=true（本帳號自己 send 的）
  //   (b) sender 是我們任一個 bridge 帳號（同帳號池其他客服剛發的，會被本帳號 listen 看到）
  // 兩者都不能進「審核佇列 / 配對轉發」pipeline（會無限迴圈、或自己審自己），
  // 但都應該進 DirectChatMessage(OUTBOUND) 留底，讓直面 / 內部群對話 UI 看到我方訊息。
  // 這樣使用者引用 / 轉發我們發的訊息時，引用對象也找得到。
  let isOurOutgoing = isOutgoing;
  if (!isOurOutgoing) {
    try {
      const ourTelegramUserIds = await clientManager.getActiveTelegramUserIds();
      if (senderId && ourTelegramUserIds.includes(senderId)) {
        isOurOutgoing = true;
      }
    } catch (loopErr) {
      log.warn("Outgoing check (account-pool match) failed, continuing as inbound", {
        error: String(loopErr),
      });
    }
  }

  // Guard against pathologically long messages (schema caps at 8192 chars)
  const MAX_TEXT_LENGTH = 8192;
  if (text.length > MAX_TEXT_LENGTH) {
    log.warn("Message text exceeds max length, truncating", { length: text.length });
    text = text.slice(0, MAX_TEXT_LENGTH);
  }

  const messageDesc = messageType === 'TEXT'
    ? text.substring(0, 50)
    : `[${messageType}] ${mediaInfo?.fileName || 'media file'}`;

  log.info("Message received", { messageType, senderName, chatTitle, preview: messageDesc });

  // Find the group in our database
  const workspaceId = clientManager.getWorkspaceId(accountId);
  if (!workspaceId) return;

  let group = await prisma.group.findUnique({
    where: {
      workspaceId_platformGroupId: {
        workspaceId,
        platformGroupId: chatId,
      },
    },
  });

  if (!group) {
    // Unknown chat — auto-register. 注意：Telegram 對「超級群組 (supergroup)」
    // 跟「廣播頻道 (broadcast channel)」都用 -100 開頭的 ID，光看前綴沒辦法區分。
    // 之前 -100 一律分類成 CHANNEL 是錯的，會把多人超級群組誤標成 CHANNEL（紫色喇叭 icon）。
    //
    // 解法：bridge auto-register 時無法拿到 GramJS Channel.megagroup 旗標，
    // 一律 default 成 GROUP — broadcast channel 比較罕見，要的話讓使用者手動改 chatType。
    // 這也跟「從 Telegram 同步」流程一致，避免兩條路徑分類不同造成 row 重複。
    const autoChatType = isPrivateChat ? "PRIVATE" : "GROUP";

    // 私訊預設 OPT-IN：先靜默註冊到 DB（隱藏 + 不監聽），讓使用者後續能在
    // 「從 Telegram 同步」dialog 看到並選擇要不要納入審核 / 轉發 pipeline。
    // 群組 / 頻道則維持原本自動啟用 + 監聽。
    //
    // 但無論哪種，「先沒勾選」≠「不存歷史」— 訊息一律落地到 DirectChatMessage
    // 讓 CS 在「直面對話 / 內部群對話」看得到對話歷史；只是 pipeline（審核 +
    // 轉發）對 PRIVATE opt-in 期間先不跑。對應使用者反饋：「不然客服會看不到
    // 之前了什麼訊息，會很糟糕」。
    const isPrivateOptIn = isPrivateChat;
    group = await prisma.group.upsert({
      where: {
        workspaceId_platformGroupId: { workspaceId, platformGroupId: chatId },
      },
      create: {
        workspaceId,
        platformGroupId: chatId,
        title: chatTitle,
        side: "UNASSIGNED",
        chatType: autoChatType,
        // 私訊：opt-in 模式 — 先建 row 但 pipeline 不跑（透過 isActive=false 控制）
        isActive: !isPrivateOptIn,
        isHidden: isPrivateOptIn,
      },
      update: {
        title: chatTitle,
      },
    });
    await prisma.accountGroupMembership.upsert({
      where: { accountId_groupId: { accountId, groupId: group.id } },
      create: {
        accountId,
        groupId: group.id,
        // 私訊未啟用前不要當監聽帳號（避免 designated-listener 邏輯誤把它當主）
        isListeningAccount: !isPrivateOptIn,
      },
      update: {},
    });

    log.info("Auto-registered new chat", {
      chatTitle,
      chatType: autoChatType,
      optIn: isPrivateOptIn,
      isActive: !isPrivateOptIn,
    });

    await notifyApp({
      type: "group:discovered",
      workspaceId,
      data: { chatId, chatTitle },
    });

    // PRIVATE opt-in：fall through 走下方 isActive=false guard，讓訊息進
    // archive-only path（只存 DirectChatMessage、不跑 pipeline）。
    // 群組 / 頻道：fall through 進正常 pipeline。
  }

  const archiveInboundDirectMessage = async () => {
    // dedupe by (groupId, platformMessageId) 避免同訊息重覆 insert
    const existing = await prisma.directChatMessage.findFirst({
      where: { groupId: group.id, platformMessageId: String(messageId) },
      select: { id: true },
    });
    if (existing) return null;

    let mediaFileResult: FileUploadResult | null = null;
    if (messageType !== "TEXT" && mediaInfo?.buffer) {
      try {
        mediaFileResult = await MediaFileManager.storeFromTelegram(
          mediaInfo.buffer,
          mediaInfo.fileName || "file",
          mediaInfo.mimeType || "application/octet-stream",
          workspaceId,
        );
      } catch (error) {
        log.error("Inbound media storage failed", { error: String(error) });
      }
    }

    const archived = await prisma.directChatMessage.create({
      data: {
        workspaceId,
        accountId,
        groupId: group.id,
        senderId: null,
        senderPlatformId: senderId,
        senderDisplayName: senderName,
        replyToPlatformId:
          replyToMessageId != null ? String(replyToMessageId) : null,
        direction: "INBOUND",
        content: text,
        messageType: messageType as MessageType,
        mediaUrl: mediaFileResult?.url,
        mediaType: mediaInfo?.mimeType,
        mediaFileName: mediaInfo?.fileName,
        // P0 2026-05-20: bytes-less media (LOCATION/CONTACT/POLL)
        // 走這個 JSON 欄位,UI 才能渲染位置/名片/投票。
        mediaMetadata: metadata ?? Prisma.JsonNull,
        // P2 2026-05-20: 轉發來源 metadata + forum topic id
        forwardedFrom: (forwardedFrom ?? Prisma.JsonNull) as Prisma.InputJsonValue,
        topicId: topicId ?? null,
        viewCount: viewCount ?? null,
        quoteText: quoteText ?? null,
        // 2026-05-21 TG parity:Message entities + Album grouped_id + 訊息按鈕
        entities: (entities ?? Prisma.JsonNull) as Prisma.InputJsonValue,
        groupedId: groupedId ?? null,
        replyMarkup: (replyMarkup ?? Prisma.JsonNull) as Prisma.InputJsonValue,
        platformMessageId: String(messageId),
      },
      select: { id: true },
    });

    // SSE 即時 notify 前端 — 不然客服要一直手動重新整理
    await notifyApp({
      type: "chat:message",
      workspaceId,
      data: {
        groupId: group.id,
        messageId: archived.id,
        platformMessageId: String(messageId),
        replyToPlatformId:
          replyToMessageId != null ? String(replyToMessageId) : null,
        content: text.substring(0, 200),
        senderName,
        senderPlatformId: senderId,
        direction: "INBOUND",
        messageType,
        entities: entities ?? null,
        groupedId: groupedId ?? null,
        replyMarkup: replyMarkup ?? null,
        receivedAt: new Date().toISOString(),
        chatType: group.chatType,
        tags: group.tags ?? [],
        isHidden: group.isHidden,
        isMuted: group.notificationsMutedUntil != null && group.notificationsMutedUntil > new Date(),
        mediaUrl: mediaFileResult?.url ?? null,
        mediaType: mediaInfo?.mimeType ?? null,
        mediaFileName: mediaInfo?.fileName ?? null,
      },
    });

    return archived;
  };

  // ─── 停用群組的處理（含 PRIVATE opt-in 期間）──────────────────
  // Group.isActive=false 代表「使用者沒勾要監聽 / 沒納入 pipeline」。
  // 但「不監聽」只該影響審核 / 轉發 pipeline，**不該連歷史對話都消失** —
  // 否則 CS 跑去看「直面對話 / 內部群對話」會誤以為訊息漏掉，造成嚴重的
  // 服務品質問題（使用者反饋:「不然客服會看不到之前了什麼訊息，會很糟糕」）。
  //
  // 因此所有 chatType（含 PRIVATE）都走 archive-only：
  //   INBOUND  → 寫進 DirectChatMessage(INBOUND) + SSE notify
  //   OUTBOUND → 走下方 isOurOutgoing 分支 archive
  // 兩邊都不進 pipeline（審核 / 轉發）。要重新 opt-in 監聽走 sync dialog。
  if (!group.isActive) {
    log.debug("Inactive group → archive-only mode (no review / no forward)", {
      groupId: group.id,
      chatType: group.chatType,
      title: group.title,
    });
    if (!isOurOutgoing) {
      try {
        await archiveInboundDirectMessage();
      } catch (err) {
        log.warn("inactive-group inbound archive failed (non-fatal)", {
          error: String(err).slice(0, 200),
        });
      }
      return;
    }
    // OUTBOUND 走下方 isOurOutgoing 分支處理 archive
  }

  // ─── 我方訊息（OUTBOUND）：archive only，不進審核 / 配對 pipeline ───
  // 之前是直接 return 把訊息丟掉 → 直面對話 / 內部群對話看不到自己人說的話、
  // 客戶引用 / 轉發我們訊息時也找不到原文。
  // 修法：archive 到 DirectChatMessage(direction=OUTBOUND)，發 SSE 給 UI 即時更新，
  // 然後 return — 不轉發（自己已發送）、不審核（自己人不必審自己）。
  if (isOurOutgoing) {
    try {
      const existing = await prisma.directChatMessage.findFirst({
        where: { groupId: group.id, platformMessageId: String(messageId) },
        select: { id: true },
      });
      if (!existing) {
        let mediaFileResult: FileUploadResult | null = null;
        if (messageType !== "TEXT" && mediaInfo?.buffer) {
          try {
            mediaFileResult = await MediaFileManager.storeFromTelegram(
              mediaInfo.buffer,
              mediaInfo.fileName || "file",
              mediaInfo.mimeType || "application/octet-stream",
              workspaceId,
            );
          } catch (error) {
            log.error("Outbound media storage failed", { error: String(error) });
          }
        }
        const archived = await prisma.directChatMessage.create({
          data: {
            workspaceId,
            accountId,
            groupId: group.id,
            senderId: null, // 我方帳號發的，這個欄位給「站方使用者」用，不適用 TG account 本身
            senderPlatformId: senderId,
            senderDisplayName: senderName,
            replyToPlatformId:
              replyToMessageId != null ? String(replyToMessageId) : null,
            direction: "OUTBOUND",
            content: text,
            messageType: messageType as MessageType,
            mediaUrl: mediaFileResult?.url,
            mediaType: mediaInfo?.mimeType,
            mediaFileName: mediaInfo?.fileName,
            mediaMetadata: metadata ?? Prisma.JsonNull,
            forwardedFrom: (forwardedFrom ?? Prisma.JsonNull) as Prisma.InputJsonValue,
            topicId: topicId ?? null,
            viewCount: viewCount ?? null,
            quoteText: quoteText ?? null,
            // 2026-05-21 TG parity:Message entities + Album grouped_id + 訊息按鈕
            entities: (entities ?? Prisma.JsonNull) as Prisma.InputJsonValue,
            groupedId: groupedId ?? null,
            replyMarkup: (replyMarkup ?? Prisma.JsonNull) as Prisma.InputJsonValue,
            sentViaTelegram: true,
            // OUTBOUND 走 archive 表示 TG 已認 message id;deliveredAt = now
            // (對方有沒有讀由 UpdateReadHistoryOutbox 後來 set readAt)。
            deliveredAt: new Date(),
            platformMessageId: String(messageId),
          },
          select: { id: true },
        });
        await notifyApp({
          type: "chat:message",
          workspaceId,
          data: {
            groupId: group.id,
            messageId: archived.id,
            platformMessageId: String(messageId),
            replyToPlatformId:
              replyToMessageId != null ? String(replyToMessageId) : null,
            content: text.substring(0, 200),
            senderName,
            senderPlatformId: senderId,
            direction: "OUTBOUND",
            messageType,
            receivedAt: new Date().toISOString(),
            chatType: group.chatType,
            tags: group.tags ?? [],
            // isHidden=true → 前端 sidebar / chat list 不會把這條訊息算進
            // unread badge(隱藏的群組不出通知)。bridge 仍會 archive 成
            // DCM,讓使用者「取消隱藏」後還能補看到歷史。
            isHidden: group.isHidden,
            isMuted:
              group.notificationsMutedUntil != null &&
              group.notificationsMutedUntil > new Date(),
          },
        });
      }
    } catch (err) {
      log.error("Failed to archive outbound message", { error: String(err) });
    }
    return;
  }

  // Representative account check: pick ONE account per group to act as the
  // listener, regardless of how `isListeningAccount` is configured. This
  // prevents duplicate review items when:
  //   (a) multiple accounts are marked listening (data misconfig), OR
  //   (b) no account is marked listening but several are members.
  // Rule: prefer `isListeningAccount = true`; tie-break by accountId ASC.
  const groupMemberships = await prisma.accountGroupMembership.findMany({
    where: {
      groupId: group.id,
      account: { status: "ACTIVE" },
    },
    orderBy: [{ isListeningAccount: "desc" }, { accountId: "asc" }],
  });
  const designatedListenerId = groupMemberships[0]?.accountId ?? null;
  if (!designatedListenerId) {
    // No active member — nothing can process this group
    return;
  }
  if (designatedListenerId !== accountId) {
    // I'm not the designated listener; skip silently
    return;
  }

  // Active group inbound path: the old broker review/forward pipeline was
  // removed, so the designated listener must archive directly to the Direct
  // Chat table. Without this, live inbound TG messages for active chats pass
  // the listener check and then disappear until a manual backfill.
  try {
    await archiveInboundDirectMessage();
  } catch (err) {
    log.error("active-group inbound archive failed", { error: String(err).slice(0, 200) });
  }

});

// ─── Edit / Delete Sync ────────────────────────────────────────

clientManager.setEditedMessageHandler(async ({ accountId, chatId, platformMessageId, newContent, replyMarkup }) => {
  try {
    if (!chatId) return;
    const workspaceId = clientManager.getWorkspaceId(accountId);
    if (!workspaceId) return;

    const group = await prisma.group.findUnique({
      where: {
        workspaceId_platformGroupId: { workspaceId, platformGroupId: chatId },
      },
    });
    if (!group) return;

    // ─── DirectChatMessage 同步 ────────────────────────────────
    // 客戶 / bot 在 TG 上編輯訊息時,DCM row 跟著改 + 標 editedAt + 廣播 SSE。
    // 2026-05-21:新增 inline keyboard 同步 — bot 換頁 / 切換狀態時常「只改按鈕、
    // 不改文字」,所以不能再用「content 沒變就 skip」一刀切。
    //   markupProvided = replyMarkup !== undefined(undefined = 此次編輯沒帶按鈕資訊)
    //   contentChanged = 文字真的變了
    // 兩者任一成立就要 update。
    try {
      const dcmRows = await prisma.directChatMessage.findMany({
        where: { groupId: group.id, platformMessageId },
        select: { id: true, content: true },
      });
      const editedAt = new Date();
      const markupProvided = replyMarkup !== undefined;
      for (const dcm of dcmRows) {
        const contentChanged = dcm.content !== newContent;
        if (!contentChanged && !markupProvided) continue; // 真的啥都沒變

        // content 變了才寫編輯歷史(PRE-update content)。
        if (contentChanged) {
          try {
            await prisma.$executeRaw`
              INSERT INTO "DirectChatMessageEditHistory"
                ("id", "dcmId", "previousContent", "editedAt")
              VALUES (${`dcmh_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`},
                      ${dcm.id},
                      ${dcm.content},
                      ${editedAt})
            `;
          } catch (histErr) {
            log.warn("DCM edit history insert failed", {
              dcmId: dcm.id,
              error: String(histErr).slice(0, 200),
            });
          }
        }

        try {
          await prisma.directChatMessage.updateMany({
            where: { id: dcm.id },
            data: {
              ...(contentChanged ? { content: newContent } : {}),
              // markupProvided 時:object = 新按鈕,null = 按鈕被移除
              ...(markupProvided
                ? {
                    replyMarkup: (replyMarkup ?? Prisma.JsonNull) as Prisma.InputJsonValue,
                  }
                : {}),
              editedAt,
            },
          });
        } catch (writeErr) {
          log.warn("DCM edit update failed", {
            dcmId: dcm.id,
            error: String(writeErr).slice(0, 200),
          });
          continue;
        }

        await notifyApp({
          type: "message:edited",
          workspaceId,
          data: {
            groupId: group.id,
            messageId: dcm.id,
            platformMessageId,
            content: newContent,
            // SSE 帶 replyMarkup,UI 即時更新按鈕(換頁 bot 才不會 stale)
            replyMarkup: markupProvided ? (replyMarkup ?? null) : undefined,
            source: "direct",
            editedAt: editedAt.toISOString(),
          },
        });
        log.info("DCM edited from TG side", {
          dcmId: dcm.id,
          groupId: group.id,
          platformMessageId,
          contentChanged,
          markupChanged: markupProvided,
        });
      }
    } catch (err) {
      log.warn("DCM edit sync failed", {
        groupId: group.id,
        platformMessageId,
        error: String(err).slice(0, 200),
      });
    }
  } catch (err) {
    log.error("Edit handler failed", { error: String(err) });
  }
});

clientManager.setDeletedMessageHandler(async ({ accountId, chatId, platformMessageId }) => {
  try {
    const workspaceId = clientManager.getWorkspaceId(accountId);
    if (!workspaceId) return;

    // Resolve sourceGroupId for the DCM soft-delete below. (Broker-side
    // Message lookup + MessageForward propagation removed in H3 — the
    // DCM update below is the whole delete pipeline now.)
    let sourceGroupId: string | null = null;
    if (chatId) {
      const sourceGroup = await prisma.group.findUnique({
        where: { workspaceId_platformGroupId: { workspaceId, platformGroupId: chatId } },
        select: { id: true },
      });
      if (!sourceGroup) return;
      sourceGroupId = sourceGroup.id;
    }

    // ─── DirectChatMessage 同步 ────────────────────────────────
    // 客戶在 TG 上撤回訊息 → 即時把 DCM row 軟標 isDeleted（前端立刻看到
    // 淺色 + 刪除線；不用等 reconcile 跑下一輪）。
    // 只在 chatId 已知時做（basic groups / 私訊 GramJS 不一定給 peer）。
    // schema-resilient：0010 還沒套就靜默 skip。
    if (chatId && sourceGroupId) {
      try {
        const dcmRows = await prisma.directChatMessage.findMany({
          where: { groupId: sourceGroupId, platformMessageId },
          select: { id: true },
        });
        const deletedAt = new Date();
        for (const dcm of dcmRows) {
          let softOk = false;
          try {
            await prisma.$executeRaw`
              UPDATE "DirectChatMessage"
                 SET "isDeleted" = true,
                     "deletedAt" = ${deletedAt}
               WHERE "id" = ${dcm.id}
                 AND "isDeleted" = false
            `;
            softOk = true;
          } catch (writeErr) {
            log.warn("DCM soft-delete column missing", {
              dcmId: dcm.id,
              error: String(writeErr).slice(0, 200),
            });
          }
          if (!softOk) continue;
          await notifyApp({
            type: "message:deleted",
            workspaceId,
            data: {
              groupId: sourceGroupId,
              messageId: dcm.id,
              platformMessageId,
              source: "direct",
              soft: true,
              deletedAt: deletedAt.toISOString(),
            },
          });
          log.info("DCM deleted from TG side", {
            dcmId: dcm.id,
            groupId: sourceGroupId,
            platformMessageId,
          });
        }
      } catch (err) {
        log.warn("DCM delete sync failed", {
          groupId: sourceGroupId,
          platformMessageId,
          error: String(err).slice(0, 200),
        });
      }
    }
  } catch (err) {
    log.error("Delete handler failed", { error: String(err) });
  }
});

// ─── Chat Title Change Sync ────────────────────────────────────

// Typing indicator: the client-manager fires onTyping for every
// UpdateUserTyping / UpdateChatUserTyping / UpdateChannelUserTyping update
// it sees on any active account. We dedupe & forward to the app via SSE.
//
// Debounce note: Telegram emits typing updates every ~5s while the user is
// typing, then stops. The UI uses a 6-second timeout so one missed update
// won't instantly hide the indicator. We don't dedupe here — the SSE
// channel is cheap and the UI handles repeats gracefully.
clientManager.onTyping = async ({ accountId, platformGroupId, platformUserId }) => {
  try {
    const workspaceId = clientManager.getWorkspaceId(accountId);
    if (!workspaceId) return;

    // Resolve group + sender display name so the UI doesn't have to make
    // extra lookups per typing event.
    const [group, avatar] = await Promise.all([
      prisma.group.findUnique({
        where: {
          workspaceId_platformGroupId: { workspaceId, platformGroupId },
        },
        select: { id: true },
      }),
      prisma.senderAvatar.findUnique({
        where: {
          workspaceId_platformUserId: { workspaceId, platformUserId },
        },
        select: { displayName: true },
      }),
    ]);
    if (!group) return; // typing in a group we don't track → ignore

    await notifyApp({
      type: "chat:typing",
      workspaceId,
      data: {
        groupId: group.id,
        platformUserId,
        displayName: avatar?.displayName ?? null,
      },
    });
  } catch (err) {
    log.warn("Typing handler failed", { error: String(err).slice(0, 200) });
  }
};

clientManager.setChatTitleChangedHandler(async ({ accountId, chatId, newTitle }) => {
  try {
    const workspaceId = clientManager.getWorkspaceId(accountId);
    if (!workspaceId) return;

    const existing = await prisma.group.findUnique({
      where: { workspaceId_platformGroupId: { workspaceId, platformGroupId: chatId } },
      select: { id: true, title: true },
    });
    if (!existing) return; // Group not registered, nothing to rename
    if (existing.title === newTitle) return;

    await prisma.group.update({
      where: { id: existing.id },
      data: { title: newTitle },
    });
    await notifyApp({
      type: "group:renamed",
      workspaceId,
      data: {
        groupId: existing.id,
        oldTitle: existing.title,
        newTitle,
      },
    });
    log.info("Group renamed", { groupId: existing.id, oldTitle: existing.title, newTitle });
  } catch (err) {
    log.error("ChatTitleChanged handler failed", { error: String(err) });
  }
});

// ─── Reaction events ───────────────────────────────────────────
//
// TG 推 updateMessageReactions → client-manager 抽出 emoji + count + chosen，
// 這支 handler 把結果寫到 DirectChatMessage.reactions 並 SSE 通知前端。
// 配對 pipeline 的 Message 表暫不支援 reactions（看 commit 2402e49 註腳）。
// ─── Read receipts (2026-05-21 Backend-first) ──────────────────
//
// TG 用「maxId 含到此 id 都已讀」的批次語意通知,而不是一筆一筆。
//   outbox → 對方讀了我方訊息 → DCM.readAt (OUTBOUND DCM,id <= maxId)
//   inbox  → 我方讀了對方訊息 → DCM.deliveredAt (INBOUND DCM,id <= maxId)
//             同時消除這個 group 的「未讀」狀態 — UI sidebar badge 用。
//
// 比對策略:platformMessageId 是 string,maxId 是 number;DCM 用「轉成
// integer 後 <= maxId」的條件。raw SQL CAST 比 prisma client 直接做整數
// 比對更可靠(prisma 直接拿 string 欄位來 <= number 會走字串字典序)。
clientManager.setReadHistoryHandler(async ({ accountId, chatId, direction, maxId }) => {
  try {
    const workspaceId = clientManager.getWorkspaceId(accountId);
    if (!workspaceId) return;

    const group = await prisma.group.findUnique({
      where: { workspaceId_platformGroupId: { workspaceId, platformGroupId: chatId } },
      select: { id: true },
    });
    if (!group) return;

    const now = new Date();

    // raw SQL — platformMessageId 是文字,要 CAST 才能跟整數 maxId 比較;
    // 同時只更新尚未標記的訊息(idempotent;同個 maxId 重發不會反覆寫入)。
    // 兩個 direction 各寫死欄位名(readAt / deliveredAt),不用字串內插組
    // SQL — $executeRaw tagged-template 只把 now / groupId / maxId 當參數
    // 綁定,欄位名與 enum literal 都是原始碼常數,杜絕欄位名注入的風險。
    try {
      const updated =
        direction === "outbox"
          ? await prisma.$executeRaw`
              UPDATE "DirectChatMessage"
                 SET "readAt" = ${now}
               WHERE "groupId" = ${group.id}
                 AND "direction" = 'OUTBOUND'::"ChatDirection"
                 AND "platformMessageId" IS NOT NULL
                 AND "readAt" IS NULL
                 AND CAST("platformMessageId" AS BIGINT) <= ${maxId}`
          : await prisma.$executeRaw`
              UPDATE "DirectChatMessage"
                 SET "deliveredAt" = ${now}
               WHERE "groupId" = ${group.id}
                 AND "direction" = 'INBOUND'::"ChatDirection"
                 AND "platformMessageId" IS NOT NULL
                 AND "deliveredAt" IS NULL
                 AND CAST("platformMessageId" AS BIGINT) <= ${maxId}`;
      log.info("Read history applied", {
        groupId: group.id,
        direction,
        maxId,
        updated,
      });
    } catch (writeErr) {
      log.warn("Read history DB persist failed (schema lag?)", {
        groupId: group.id,
        direction,
        maxId,
        error: String(writeErr).slice(0, 200),
      });
    }

    // 通知 UI:outbox = 對方已讀我方,UI 把 OUTBOUND 變藍勾;
    //         inbox  = 我方已讀對方,UI sidebar 消未讀 badge。
    await notifyApp({
      type: "message:read",
      workspaceId,
      data: {
        groupId: group.id,
        direction,
        maxId,
        at: now.toISOString(),
      },
    });
  } catch (err) {
    log.warn("Read history handler error", { error: String(err).slice(0, 200) });
  }
});

clientManager.setReactionChangedHandler(async ({ accountId, chatId, platformMessageId, reactions }) => {
  try {
    const workspaceId = clientManager.getWorkspaceId(accountId);
    if (!workspaceId) return;

    const group = await prisma.group.findUnique({
      where: { workspaceId_platformGroupId: { workspaceId, platformGroupId: chatId } },
      select: { id: true, chatType: true, tags: true },
    });
    if (!group) return; // 群組沒註冊 → 不處理 reaction

    // 1) 先確認這筆 DCM 存在（不碰 reactions 欄位，不會被 schema lag 影響）
    const dcm = await prisma.directChatMessage.findFirst({
      where: { groupId: group.id, platformMessageId },
      select: { id: true },
    });
    if (!dcm) {
      // DCM row 不存在（可能訊息走的是 Message 表 pipeline，或還沒同步進來）
      return;
    }

    // 2) 嘗試把 reactions 寫進 DB。schema lag（0009 還沒套）→ 拋錯；
    //    我們吞掉、繼續 SSE — 寧可跳過持久化，也要讓正在看的同事即時看到。
    let dbWritten = false;
    try {
      await prisma.directChatMessage.updateMany({
        where: { id: dcm.id },
        // reactions 是 Json 欄位，直接塞 JS 物件 — Prisma 會 serialize
        data: {
          reactions: reactions.length > 0 ? reactions : Prisma.JsonNull,
        },
      });
      dbWritten = true;
    } catch (writeErr) {
      log.warn("Reaction DB persist failed (schema lag?) — falling back to SSE only", {
        groupId: group.id,
        platformMessageId,
        error: String(writeErr).slice(0, 200),
      });
    }

    // 3) SSE 一律發送 — 在線中的同事會立即看到 chip；schema 套上後重新整理
    //    才會持久顯示（這層降級是給 0009 還沒跑的視窗用的）
    await notifyApp({
      type: "chat:reaction-changed",
      workspaceId,
      data: {
        groupId: group.id,
        platformMessageId,
        reactions, // 直接送陣列給前端，不需 DB 雙跳
        chatType: group.chatType,
        tags: group.tags ?? [],
      },
    });
    log.info("Reaction updated", {
      groupId: group.id,
      platformMessageId,
      count: reactions.length,
      dbWritten,
    });
  } catch (err) {
    log.warn("Reaction handler error", { error: String(err).slice(0, 200) });
  }
});

// ─── Group Discovery ───────────────────────────────────────────

// ─── Sender Avatar Caching ─────────────────────────────────────
//
// Lazily fetches profile photos for senders we've seen in messages and stores
// them under uploads/avatars/<workspaceId>/. Keeps a row per
// (workspace, platformUserId) in SenderAvatar — including "miss" rows with
// mediaPath=null for users with no profile photo, so we don't re-check them
// on every pass.
//
// Refresh policy: skip any sender whose refreshedAt is within 7 days.

const AVATAR_REFRESH_MS = 7 * 24 * 60 * 60 * 1000;
// 2026-05-04: 12→30 + 間隔 2min→1min 加速首次 workspace avatar 補滿。
// 一次 batch 寬鬆 (LIMIT 30) 但兩個 sweep 都共用,實際 TG getUserPhotos /
// getFullChat 呼叫量約 1 req/sec,遠低於 Telegram 對單 account 的限制。
const AVATAR_BATCH_SIZE = 30;
const AVATAR_ROOT = process.env.MEDIA_UPLOAD_DIR
  ? path.join(process.env.MEDIA_UPLOAD_DIR, "avatars")
  : "./uploads/avatars";

async function fetchMissingSenderAvatars() {
  // Find recent sender ids we don't yet have (or haven't refreshed in 7 days).
  // Bounded to the last 7 days of activity.
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  // Candidates come from:
  //   1) DirectChatMessage INBOUND — direct-chat archived messages from real TG users
  //   2) Existing SenderAvatar stubs(seeded by enumerateGroupParticipants)
  //
  // 2026-05-21 fix:H4 已刪 broker pipeline 的 Message / Pairing 表,但此 raw SQL
  // 還 hardcoded JOIN "Message" m → 啟動就拋 "relation Message does not exist"。
  // 砍掉那條 subquery 即可 — DCM INBOUND 已涵蓋所有實際對話對象。
  const candidates = await prisma.$queryRaw<
    Array<{ workspaceId: string; platformUserId: string; displayName: string | null }>
  >`
    SELECT DISTINCT
      sources."workspaceId" as "workspaceId",
      sources."platformUserId" as "platformUserId",
      sources."displayName" as "displayName"
    FROM (
      -- 1) Recent DCM INBOUND senders (direct-chat customers)
      SELECT dcm."workspaceId" as "workspaceId",
             dcm."senderPlatformId" as "platformUserId",
             dcm."senderDisplayName" as "displayName"
      FROM "DirectChatMessage" dcm
      WHERE dcm."senderPlatformId" IS NOT NULL
        AND dcm."direction" = 'INBOUND'
        AND dcm."createdAt" > ${since}
      UNION
      -- 2) Any SenderAvatar row that's never been fetched or is stale —
      --    covers participants seeded by enumerateGroupParticipants (group
      --    members who haven't sent a message recently). Without this
      --    branch those rows would sit forever as displayName-only stubs.
      SELECT sa."workspaceId" as "workspaceId",
             sa."platformUserId" as "platformUserId",
             sa."displayName" as "displayName"
      FROM "SenderAvatar" sa
      WHERE sa."refreshedAt" IS NULL
         OR sa."refreshedAt" < NOW() - INTERVAL '7 days'
    ) sources
    LEFT JOIN "SenderAvatar" sa
      ON sa."workspaceId" = sources."workspaceId"
      AND sa."platformUserId" = sources."platformUserId"
    WHERE sa."refreshedAt" IS NULL OR sa."refreshedAt" < NOW() - INTERVAL '7 days'
    LIMIT ${AVATAR_BATCH_SIZE}
  `;

  if (candidates.length === 0) return;

  // Pick a single ACTIVE account per workspace to do the lookups through —
  // Telegram requires any authorized user to resolve another user's entity.
  const activeAccounts = await prisma.communicationAccount.findMany({
    where: { status: "ACTIVE" },
    select: { id: true, workspaceId: true },
    orderBy: { createdAt: "asc" },
  });
  const accountByWs = new Map<string, string>();
  for (const a of activeAccounts) {
    if (!accountByWs.has(a.workspaceId)) accountByWs.set(a.workspaceId, a.id);
  }

  for (const c of candidates) {
    const accountId = accountByWs.get(c.workspaceId);
    if (!accountId) continue;

    const result = await clientManager.downloadProfilePhoto(accountId, c.platformUserId);
    let mediaPath: string | null = null;
    let mimeType: string | null = null;
    let size: number | null = null;

    if (result) {
      try {
        const wsDir = path.join(AVATAR_ROOT, c.workspaceId);
        await fs.mkdir(wsDir, { recursive: true });
        const ext = result.mimeType === "image/png" ? ".png" : ".jpg";
        const filename = `${c.platformUserId}_${randomBytes(4).toString("hex")}${ext}`;
        const abs = path.join(wsDir, filename);
        await fs.writeFile(abs, result.buffer);
        mediaPath = path.relative(".", abs); // relative to CWD
        mimeType = result.mimeType;
        size = result.buffer.length;
      } catch (e) {
        log.warn("Failed to write avatar file", {
          workspaceId: c.workspaceId,
          platformUserId: c.platformUserId,
          error: String(e).slice(0, 200),
        });
        continue;
      }
    }

    // Upsert. If there's an older file to replace, we leave the old one on
    // disk — cheap orphans beat risking deleting a file still in use. A
    // future periodic GC can clean them up.
    await prisma.senderAvatar.upsert({
      where: {
        workspaceId_platformUserId: {
          workspaceId: c.workspaceId,
          platformUserId: c.platformUserId,
        },
      },
      create: {
        workspaceId: c.workspaceId,
        platformUserId: c.platformUserId,
        displayName: c.displayName,
        mediaPath,
        mimeType,
        size,
        refreshedAt: new Date(),
      },
      update: {
        displayName: c.displayName ?? undefined,
        mediaPath,
        mimeType,
        size,
        refreshedAt: new Date(),
      },
    });

    log.info("Avatar cached", {
      workspaceId: c.workspaceId,
      platformUserId: c.platformUserId,
      displayName: c.displayName,
      hasPhoto: mediaPath != null,
    });
  }
}

/**
 * Same idea as fetchMissingSenderAvatars but for Group chat photos. Groups
 * without an avatarRefreshedAt (never fetched) or stale by 7+ days get a
 * download attempt via any ACTIVE account that is a member of the group.
 *
 * Spec 2026-04-24: the direct-chat sidebar must show the
 * ACTUAL group avatar, not the last sender's avatar. This pass populates
 * the cache that /api/workspaces/:ws/group-avatars/:platformGroupId serves.
 */
async function fetchMissingGroupAvatars() {
  const since = new Date(Date.now() - AVATAR_REFRESH_MS);
  const candidates = await prisma.group.findMany({
    where: {
      isActive: true,
      OR: [
        { avatarRefreshedAt: null },
        { avatarRefreshedAt: { lt: since } },
      ],
    },
    include: {
      accountMemberships: {
        where: { account: { status: "ACTIVE" } },
        orderBy: [{ isListeningAccount: "desc" }, { accountId: "asc" }],
        take: 1,
        select: { accountId: true },
      },
    },
    take: AVATAR_BATCH_SIZE,
  });

  for (const g of candidates) {
    const accountId = g.accountMemberships[0]?.accountId;
    if (!accountId) continue;

    let result: { buffer: Buffer; mimeType: string } | null = null;
    try {
      result = await clientManager.downloadProfilePhoto(
        accountId,
        g.platformGroupId,
      );
    } catch (err) {
      log.warn("Group avatar fetch failed", {
        groupId: g.id,
        platformGroupId: g.platformGroupId,
        error: String(err).slice(0, 200),
      });
    }

    let mediaPath: string | null = null;
    let mimeType: string | null = null;

    if (result) {
      try {
        const wsDir = path.join(AVATAR_ROOT, g.workspaceId);
        await fs.mkdir(wsDir, { recursive: true });
        const ext = result.mimeType === "image/png" ? ".png" : ".jpg";
        // Prefix distinguishes group avatar files from user avatar files in
        // the shared directory; the GC pass below uses this prefix.
        const filename = `group_${g.platformGroupId.replace(/^-/, "n")}_${randomBytes(4).toString("hex")}${ext}`;
        const abs = path.join(wsDir, filename);
        await fs.writeFile(abs, result.buffer);
        mediaPath = path.relative(".", abs);
        mimeType = result.mimeType;
      } catch (e) {
        log.warn("Failed to write group avatar file", {
          groupId: g.id,
          error: String(e).slice(0, 200),
        });
        continue;
      }
    }

    await prisma.group.update({
      where: { id: g.id },
      data: {
        avatarPath: mediaPath,
        avatarMimeType: mimeType,
        avatarRefreshedAt: new Date(),
      },
    });

    log.info("Group avatar cached", {
      groupId: g.id,
      title: g.title,
      hasPhoto: mediaPath != null,
    });
  }
}

/**
 * Enumerate participants of every active group via TG and seed the
 * SenderAvatar candidate pool. Goal: 「自動抓取聊天室內所有用戶的大頭貼」 —
 * fetchMissingSenderAvatars only sees senderPlatformId from the last 7 days
 * of messages, so people who joined a group but haven't talked recently
 * never get their avatar cached. This sweep walks each group's member list
 * and writes (refreshedAt=null) rows so the existing photo-fetch tick picks
 * them up next pass.
 *
 * Bounded:
 *   - GROUP_PARTICIPANT_BATCH groups per tick (rate-limit-friendly)
 *   - GROUP_PARTICIPANT_LIMIT users per group (supergroups can be 1000+;
 *     we don't need every shadow member, the people who actually chat)
 *   - skips groups whose members were enumerated within
 *     GROUP_PARTICIPANT_REFRESH_MS (default 24h) — avatars rarely change
 *     identity; we just want catch-up coverage
 *
 * The SenderAvatar.refreshedAt field is reused as the freshness anchor:
 * when we upsert a candidate row we leave refreshedAt=null on create so
 * fetchMissingSenderAvatars treats it as never-fetched. We separately
 * track group-side enumeration recency in-memory (no schema change).
 */
const GROUP_PARTICIPANT_BATCH = 5;
const GROUP_PARTICIPANT_LIMIT = 200;
const GROUP_PARTICIPANT_REFRESH_MS = 24 * 60 * 60 * 1000;
const groupParticipantsLastRun = new Map<string, number>();

async function enumerateGroupParticipants() {
  const now = Date.now();
  const groups = await prisma.group.findMany({
    where: {
      isActive: true,
      // 1-on-1 私聊不需要列 participants(只有對方 + 自己,對方 sender id
      // 已經在 DCM/Message 裡會被另一個 sweep 抓到)
      chatType: { in: ["GROUP", "CHANNEL"] },
    },
    include: {
      accountMemberships: {
        where: { account: { status: "ACTIVE" } },
        orderBy: [{ isListeningAccount: "desc" }, { accountId: "asc" }],
        take: 1,
        select: { accountId: true },
      },
    },
    // 拉多一點再用 in-memory cooldown filter,避免 stale group 把 batch 占滿
    take: GROUP_PARTICIPANT_BATCH * 4,
  });

  let dispatched = 0;
  for (const g of groups) {
    if (dispatched >= GROUP_PARTICIPANT_BATCH) break;
    const last = groupParticipantsLastRun.get(g.id) ?? 0;
    if (now - last < GROUP_PARTICIPANT_REFRESH_MS) continue;
    const accountId = g.accountMemberships[0]?.accountId;
    if (!accountId) continue;

    const members = await clientManager.listGroupParticipants(
      accountId,
      g.platformGroupId,
      GROUP_PARTICIPANT_LIMIT,
    );
    groupParticipantsLastRun.set(g.id, now);
    if (members.length === 0) continue;

    // Upsert as candidate rows. Don't overwrite refreshedAt — if the row
    // already has a real photo cached we leave it; if it's a fresh row we
    // leave refreshedAt null so the next photo sweep picks it up.
    for (const m of members) {
      try {
        await prisma.senderAvatar.upsert({
          where: {
            workspaceId_platformUserId: {
              workspaceId: g.workspaceId,
              platformUserId: m.platformUserId,
            },
          },
          create: {
            workspaceId: g.workspaceId,
            platformUserId: m.platformUserId,
            displayName: m.displayName,
            // refreshedAt left null → fetchMissingSenderAvatars will treat
            // this as a fresh candidate on its next tick
          },
          update: {
            // Refresh display name if TG reports one and we have nothing
            ...(m.displayName ? { displayName: m.displayName } : {}),
          },
        });
      } catch (err) {
        log.warn("Participant avatar candidate upsert failed", {
          workspaceId: g.workspaceId,
          platformUserId: m.platformUserId,
          error: String(err).slice(0, 150),
        });
      }
    }
    log.info("Group participants enumerated", {
      groupId: g.id,
      title: g.title,
      members: members.length,
    });
    dispatched++;
  }
}

/**
 * GC for avatar files under uploads/avatars/<workspaceId>/. Removes any file
 * on disk whose full path is not referenced by a SenderAvatar row or a Group
 * row. Safe to run often — walks the directory once and filters against the
 * DB row set.
 *
 * Called from the same 2-minute tick as avatar fetch so we don't pile orphans.
 */
async function gcOrphanAvatars() {
  let root: string;
  try {
    root = path.resolve(AVATAR_ROOT);
    await fs.access(root);
  } catch {
    return; // No avatar dir yet — nothing to GC.
  }

  const [senderRows, groupRows] = await Promise.all([
    prisma.senderAvatar.findMany({
      where: { mediaPath: { not: null } },
      select: { mediaPath: true },
    }),
    prisma.group.findMany({
      where: { avatarPath: { not: null } },
      select: { avatarPath: true },
    }),
  ]);
  // Both tables store paths as relative-to-CWD; resolve to absolute so we
  // can set-intersect against the filesystem walk.
  const known = new Set<string>();
  for (const r of senderRows) known.add(path.resolve(r.mediaPath!));
  for (const r of groupRows) known.add(path.resolve(r.avatarPath!));

  let workspaceDirs: string[];
  try {
    workspaceDirs = await fs.readdir(root);
  } catch {
    return;
  }

  let removed = 0;
  for (const ws of workspaceDirs) {
    const dir = path.join(root, ws);
    let files: string[];
    try {
      files = await fs.readdir(dir);
    } catch {
      continue;
    }
    for (const f of files) {
      const abs = path.join(dir, f);
      if (known.has(abs)) continue;
      try {
        await fs.unlink(abs);
        removed += 1;
      } catch {
        // ignore — file may have been removed by another pass
      }
    }
  }
  if (removed > 0) log.info("Avatar GC", { removed });
}

// ─── Delete Reconciliation ─────────────────────────────────────
//
// Telegram's UpdateDeleteMessages event is unreliable for basic groups
// (no chat_id in the update) — we miss deletions when our account isn't
// the one who deleted the message, or when GramJS silently drops the
// update after a reconnect. This pass walks recent DB messages per group,
// asks Telegram for the current live set via getMessages, and marks our
// rows as deleted if they're missing server-side.
//
// Heuristics to keep it cheap:
//   - Only groups with at least one message received in the last 3 days
//   - Only the most recent 100 messages per group
//   - Compares PLATFORM ids (Telegram-assigned), not our DB ids
//   - Skips groups where getMessages returns null (peer error, rate limit)
//     so we don't falsely mark everything deleted
const RECONCILE_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;

async function reconcileDeletions() {
  const since = new Date(Date.now() - RECONCILE_WINDOW_MS);
  // Groups that have recent activity — pair each with an ACTIVE account
  // that's a member (through AccountGroupMembership).
  //
  // 涵蓋兩種訊息來源:
  //   - sourceMessages = 廣播 pipeline 的 Message(走配對流程)
  //   - directChatMessages = DCM(直面對話 / 內部群對話)
  // 沒有第二條件的話,「內部群」(無配對、純 DCM)永遠不會被列入候選 → 客戶
  // 在 TG 端撤回訊息時 Switchboard UI 仍顯示原文,違反「軟刪同步」spec。
  // 2026-05-05 reported: 內部群對話被刪除的訊息沒有刪除線提示。
  // (Broker sourceMessages condition dropped — only DCM activity remains.)
  const groups = await prisma.group.findMany({
    where: {
      isActive: true,
      directChatMessages: { some: { createdAt: { gte: since } } },
    },
    select: {
      id: true,
      platformGroupId: true,
      workspaceId: true,
      accountMemberships: {
        where: { account: { status: "ACTIVE" } },
        take: 1,
        select: { accountId: true },
      },
    },
  });

  for (const g of groups) {
    const accountId = g.accountMemberships[0]?.accountId;
    if (!accountId) continue;

    const live = await clientManager.fetchChatMessageIds(accountId, g.platformGroupId, 100);
    if (!live) continue; // peer error / timeout — try again next tick

    // (Broker Message reconciliation removed with H3 — only the DCM-side
    // reconciliation below runs now.)

    // ─── DirectChatMessage reconciliation ──────────────────────
    // 同樣 window + same `live` set，把 DCM 端少掉的訊息也軟刪掉。
    // 為什麼要做：Switchboard UI 直接顯示 DCM；當客戶在 TG App 撤回訊息時，
    // 我方 UI 仍會顯示，造成「我看到的訊息，TG 端早就沒了」的不一致。
    // 0010 migration 套上後可以做 soft-delete；schema lag 期間 raw SQL
    // try/catch 守住（同 chat-route 的模式）。
    try {
      const dcmRows = await prisma.directChatMessage.findMany({
        where: {
          groupId: g.id,
          createdAt: { gte: since },
          platformMessageId: { not: null },
        },
        orderBy: { createdAt: "desc" },
        take: 100,
        select: { id: true, platformMessageId: true },
      });
      // 已軟刪的略過：用 raw SQL 過濾 isDeleted=false（schema lag 時欄位
      // 不存在 → 拋錯 → 整個 reconcile 跳過 DCM 部分，下次再試）
      const ids = dcmRows.map((r) => r.id);
      let stillLive: Set<string> = new Set(ids);
      try {
        const aliveRows = await prisma.$queryRaw<Array<{ id: string }>>`
          SELECT "id" FROM "DirectChatMessage"
           WHERE "id" IN (${Prisma.join(ids.length > 0 ? ids : ["__none__"])})
             AND "isDeleted" = false
        `;
        stillLive = new Set(aliveRows.map((r) => r.id));
      } catch {
        // 欄位不存在 → 全部視為 still live（下面會嘗試 soft-delete，失敗也吞掉）
      }
      const dcmToDelete = dcmRows.filter(
        (r) =>
          stillLive.has(r.id) &&
          r.platformMessageId &&
          !live.has(Number(r.platformMessageId)),
      );
      if (dcmToDelete.length > 0) {
        log.info("Reconciling missing DCM deletions", {
          groupId: g.id,
          count: dcmToDelete.length,
          fromWorkspace: g.workspaceId,
        });
        const deletedAt = new Date();
        for (const m of dcmToDelete) {
          let softOk = false;
          try {
            await prisma.$executeRaw`
              UPDATE "DirectChatMessage"
                 SET "isDeleted" = true,
                     "deletedAt" = ${deletedAt}
               WHERE "id" = ${m.id}
            `;
            softOk = true;
          } catch (rawErr) {
            log.warn("DCM soft-delete column missing during reconcile", {
              dcmId: m.id,
              error: String(rawErr).slice(0, 200),
            });
          }
          if (!softOk) continue; // 沒辦法 soft-delete → 不做、不發 SSE
          await notifyApp({
            type: "message:deleted",
            workspaceId: g.workspaceId,
            data: {
              groupId: g.id,
              messageId: m.id,
              platformMessageId: m.platformMessageId,
              source: "direct",
              soft: true,
              deletedAt: deletedAt.toISOString(),
              reason: "reconciled",
            },
          });
        }
      }
    } catch (err) {
      log.warn("DCM reconcile failed", {
        groupId: g.id,
        error: String(err).slice(0, 200),
      });
    }
  }
}

async function discoverAllGroups() {
  const accounts = await prisma.communicationAccount.findMany({
    where: { status: "ACTIVE" },
    include: { telegramSession: true },
  });

  // Must match the limit passed to getDialogs inside discoverGroups — only
  // prune memberships when we can confirm we saw every dialog (results < limit).
  const DISCOVERY_LIMIT = 200;

  for (const account of accounts) {
    const groups = await clientManager.discoverGroups(account.id);

    // Track the set of groupIds we confirmed via Telegram this pass — used
    // to detect memberships that have gone stale (bot was kicked, left, or
    // the chat was deleted). Prevents sending to groups the account is no
    // longer in (symptom: RPCError 400: PEER_ID_INVALID at send time).
    const currentGroupIds: string[] = [];

    for (const g of groups) {
      // Upsert group
      const upsertedGroup = await prisma.group.upsert({
        where: {
          workspaceId_platformGroupId: {
            workspaceId: account.workspaceId,
            platformGroupId: g.platformGroupId,
          },
        },
        create: {
          workspaceId: account.workspaceId,
          platformGroupId: g.platformGroupId,
          title: g.title,
          side: "UNASSIGNED",
          chatType: g.chatType,
        },
        update: {
          title: g.title,
          chatType: g.chatType,
        },
      });

      currentGroupIds.push(upsertedGroup.id);

      // Ensure account-group membership
      await prisma.accountGroupMembership
        .create({
          data: {
            accountId: account.id,
            groupId: upsertedGroup.id,
          },
        })
        .catch(() => {}); // Ignore duplicate
    }

    // Prune stale memberships: drop rows whose groupId isn't in the current
    // discovery result. Safety check: only prune when we saw fewer dialogs
    // than the limit, i.e. we got the full list. If we hit the limit we may
    // be missing pages and must not delete anything (would nuke legitimate
    // memberships for heavy users).
    if (groups.length < DISCOVERY_LIMIT) {
      const stale = await prisma.accountGroupMembership.deleteMany({
        where: {
          accountId: account.id,
          groupId: { notIn: currentGroupIds.length > 0 ? currentGroupIds : ["__no_match__"] },
        },
      });
      if (stale.count > 0) {
        log.info("Pruned stale account-group memberships", {
          accountId: account.id,
          count: stale.count,
          remainingGroups: currentGroupIds.length,
        });
      }
    }
  }
}

/**
 * 2026-05-21:TG 原生資料夾自動同步。
 *
 * 對每個 ACTIVE 帳號呼叫 clientManager.getDialogFilters,把結果 upsert 進
 * TgFolder 表(共用 upsertAccountFolders,跟 tg-folders API 手動同步同一套邏輯)。
 *
 * 呼叫時機:接在 discoverAllGroups 之後跑(見 safeDiscovery)— 因為資料夾
 * sync 要把 TG peer id 解析成 Switchboard Group.id,必須先 discovery 把新群組入庫,
 * folder 才對得上。每 5 分鐘一輪,員工在 TG 端改資料夾後最多 5 分鐘自動跟上。
 * 手動同步(tg-folders API POST)只作為緊急 / 即時 fallback。
 */
async function syncAllAccountFolders() {
  const accounts = await prisma.communicationAccount.findMany({
    where: { status: "ACTIVE" },
    select: { id: true, workspaceId: true },
  });
  for (const account of accounts) {
    try {
      const filters = await clientManager.getDialogFilters(account.id);
      const result = await upsertAccountFolders(
        prisma,
        account.workspaceId,
        account.id,
        filters,
      );
      if (result.upserted > 0 || result.removed > 0) {
        log.info("TG folders auto-synced", {
          accountId: account.id,
          upserted: result.upserted,
          removed: result.removed,
        });
      }
    } catch (err) {
      log.warn("TG folder auto-sync failed for account", {
        accountId: account.id,
        error: String(err).slice(0, 200),
      });
    }
  }
}

// (Stale review-queue lock cleanup removed with H3 — ReviewQueueItem
// table is gone in H4. Kept as a no-op so the periodic scheduler entry
// in main() doesn't blow up; safe to delete entirely later.)
async function cleanupStaleLocks() {
  /* no-op */
}

// ─── Retention cleanup (AuditLog / Session) ────────────────────
//
// Retention policies:
// - AuditLog: keep 90 days (configurable via AUDIT_LOG_RETENTION_DAYS env)
// - Session: delete expired sessions + their older-than-24h siblings
//
// Runs once per hour; additive safety measure to cap unbounded growth.
async function cleanupRetention() {
  const auditDays = parseInt(process.env.AUDIT_LOG_RETENTION_DAYS || "90", 10);
  const auditCutoff = new Date(Date.now() - auditDays * 24 * 60 * 60 * 1000);

  const [auditDel, sessionDel] = await Promise.all([
    prisma.auditLog.deleteMany({ where: { createdAt: { lt: auditCutoff } } }),
    prisma.session.deleteMany({ where: { expiresAt: { lt: new Date() } } }),
  ]);

  if (auditDel.count > 0 || sessionDel.count > 0) {
    log.info("Retention cleanup", {
      auditLogsDeleted: auditDel.count,
      expiredSessionsDeleted: sessionDel.count,
      auditRetentionDays: auditDays,
    });
  }
}


/**
 * 把 fromGroupId 的所有關聯轉移到 intoGroupId，最後把 fromGroupId 軟刪除。
 * 用於：群組升級為超級群組後合併新舊兩筆 row（platformGroupId 不同）。
 *
 * Bridge 內聯版本 — Next.js API 用 src/lib/groups/merge-group.ts 裡的對等實作
 * （因為 bridge 用自己的 PrismaClient instance）。
 */
async function mergeGroupInto(fromGroupId: string, intoGroupId: string) {
  if (fromGroupId === intoGroupId) return;
  await prisma.$transaction(async (tx) => {
    const fromMemberships = await tx.accountGroupMembership.findMany({
      where: { groupId: fromGroupId },
    });
    for (const m of fromMemberships) {
      const targetExists = await tx.accountGroupMembership.findUnique({
        where: { accountId_groupId: { accountId: m.accountId, groupId: intoGroupId } },
      });
      if (targetExists) {
        await tx.accountGroupMembership.delete({ where: { id: m.id } });
      } else {
        await tx.accountGroupMembership.update({
          where: { id: m.id },
          data: { groupId: intoGroupId },
        });
      }
    }

    // (PairingGroup + Message migration steps dropped in H4 — broker
     // tables are gone; only DCM rows need to follow the group merge.)

    await tx.directChatMessage.updateMany({
      where: { groupId: fromGroupId },
      data: { groupId: intoGroupId },
    });

    await tx.group.update({
      where: { id: fromGroupId },
      data: { isActive: false },
    });
  });
}

// ─── Supergroup Migration Handler ─────────────────────────────

/**
 * When Telegram migrates a basic group to a supergroup, the old chat ID
 * becomes invalid. This function detects the migration, updates the
 * Group record in the database with the new platformGroupId, and
 * notifies the app via SSE so operators see the change in real time.
 *
 * Called only on send failure — not as a periodic check.
 */
async function handleGroupMigration(
  oldChatId: string,
  newChatId: string,
  _accountId: string
): Promise<{ updated: boolean }> {
  try {
    // Find the group by old platformGroupId
    const group = await prisma.group.findFirst({
      where: { platformGroupId: oldChatId },
    });

    if (!group) {
      log.warn("Migration detected but group not found in DB", { oldChatId, newChatId });
      return { updated: false };
    }

    // 新 ID 已有 row（前次同步建立過超級群組那筆）→ 改做「合併」：
    //   把舊 row 的所有關聯轉到新 row，再把舊 row 軟刪除
    const existing = await prisma.group.findFirst({
      where: {
        workspaceId: group.workspaceId,
        platformGroupId: newChatId,
      },
    });

    if (existing) {
      log.info("Migration target group exists, merging old row into new", {
        oldChatId,
        newChatId,
        oldGroupId: group.id,
        newGroupId: existing.id,
      });
      await mergeGroupInto(group.id, existing.id);
      // 確保新 row 是 GROUP 而不是被誤分類的 CHANNEL（修舊資料）
      if (existing.chatType === "CHANNEL") {
        await prisma.group.update({
          where: { id: existing.id },
          data: { chatType: "GROUP" },
        });
      }
      await notifyApp({
        type: "group:migrated",
        workspaceId: group.workspaceId,
        data: {
          groupId: existing.id,
          groupTitle: existing.title,
          oldPlatformGroupId: oldChatId,
          newPlatformGroupId: newChatId,
          merged: true,
        },
      });
      return { updated: true };
    }

    // 沒有目標 row → 直接把舊 row 的 platformGroupId 換成新 ID
    await prisma.group.update({
      where: { id: group.id },
      data: { platformGroupId: newChatId },
    });

    log.info("Auto-migrated group to new supergroup ID", {
      groupId: group.id,
      groupTitle: group.title,
      oldChatId,
      newChatId,
    });

    // Notify the app via SSE so the UI reflects the change
    const workspaceId = group.workspaceId;
    await notifyApp({
      type: "group:migrated",
      workspaceId,
      data: {
        groupId: group.id,
        groupTitle: group.title,
        oldPlatformGroupId: oldChatId,
        newPlatformGroupId: newChatId,
      },
    });

    return { updated: true };
  } catch (error) {
    log.error("Failed to handle group migration", {
      oldChatId,
      newChatId,
      error: String(error),
    });
    return { updated: false };
  }
}

// ─── HTTP Server (for app ↔ bridge communication) ──────────────

const MAX_BODY_SIZE = 1024 * 1024; // 1MB limit

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_SIZE) {
        req.destroy();
        reject(new Error("Request body too large"));
        return;
      }
      body += chunk.toString();
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function startHttpServer() {
  const server = createServer(
    async (req: IncomingMessage, res: ServerResponse) => {
      // Health check (GET for content, HEAD for `wget --spider` style probes)
      if (req.url === "/health" && (req.method === "GET" || req.method === "HEAD")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(req.method === "HEAD" ? undefined : JSON.stringify({ status: "ok" }));
        return;
      }

      // Status (H3 fix: require auth)
      if (req.url === "/status" && req.method === "GET") {
        if (!verifySecret(req.headers.authorization)) {
          res.writeHead(401);
          res.end("Unauthorized");
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ clients: clientManager.getStatus() }));
        return;
      }

      // Send message (called by Next.js app)
      if (req.url === "/send" && req.method === "POST") {
        if (!verifySecret(req.headers.authorization)) {
          res.writeHead(401);
          res.end("Unauthorized");
          return;
        }

        try {
          const body = JSON.parse(await readBody(req));
          // 兼容兩種 client:舊版送 replyToMsgId,新版(direct-chat/send route)送 replyTo + quote。
          const {
            accountId,
            chatId,
            text,
            replyToMsgId,
            replyTo: replyToFromBody,
            quote,
            parseMode,
            senderId,
            skipArchive,
            scheduleDate,
            topicId,
          } = body;

          // M14 fix: validate input
          if (!accountId || typeof accountId !== "string") {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "accountId is required" }));
            return;
          }
          if (!chatId || typeof chatId !== "string") {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "chatId is required" }));
            return;
          }
          if (!text || typeof text !== "string" || text.length > 4096) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "text is required and must be under 4096 chars" }));
            return;
          }
          // 兩個 replyTo 來源都接受 — 新版用 `replyTo`,舊版用 `replyToMsgId`。
          const replyToCandidate =
            typeof replyToFromBody === "number"
              ? replyToFromBody
              : typeof replyToMsgId === "number"
                ? replyToMsgId
                : null;
          const replyTo =
            replyToCandidate != null && Number.isFinite(replyToCandidate) && replyToCandidate > 0
              ? replyToCandidate
              : undefined;
          // Quote-reply (2026-05-21):必須跟 replyTo 同時存在。
          const validQuote: { quoteText: string; quoteOffset: number } | null =
            replyTo != null &&
            quote &&
            typeof quote.quoteText === "string" &&
            quote.quoteText.length > 0
              ? {
                  quoteText: quote.quoteText,
                  quoteOffset:
                    typeof quote.quoteOffset === "number" && quote.quoteOffset >= 0
                      ? Math.floor(quote.quoteOffset)
                      : 0,
                }
              : null;
          const validParseMode =
            parseMode === "html" || parseMode === "markdown"
              ? (parseMode as "html" | "markdown")
              : null;
          const validScheduleDate =
            typeof scheduleDate === "number" && Number.isFinite(scheduleDate) && scheduleDate > 0
              ? scheduleDate
              : null;
          const validTopicId =
            typeof topicId === "number" && Number.isFinite(topicId) && topicId > 0
              ? Math.floor(topicId)
              : null;

          let result = await clientManager.sendMessage(
            accountId,
            chatId,
            text,
            replyTo,
            validParseMode,
            validScheduleDate,
            validQuote,
            validTopicId,
          );

          // Supergroup migration detection: if send failed, check if chat migrated
          if (!result.success && result.migratedToChatId) {
            const migrationResult = await handleGroupMigration(chatId, result.migratedToChatId, accountId);
            if (migrationResult.updated) {
              log.info("Retrying send with migrated chat ID", { oldChatId: chatId, newChatId: result.migratedToChatId });
              result = await clientManager.sendMessage(
                accountId,
                result.migratedToChatId,
                text,
                replyTo,
                validParseMode,
                validScheduleDate,
                validQuote,
                validTopicId,
              );
            }
          }

          // 發送成功 → 直接 archive 到 DirectChatMessage（OUTBOUND）。
          // 為什麼不仰賴 NewMessage event：GramJS 對「自己 client 透過 sendMessage 送出去的訊息」
          // 不會 fire NewMessage 給自己（避免迴圈）→ handleNewMessage 收不到。
          //
          // skipArchive=true 時跳過：呼叫端（如 direct-chat/send）已經自己寫了 DirectChatMessage row，
          // 重複 archive 會在 UI 出現雙倍訊息泡泡。forward-internal 等沒寫 row 的呼叫者就 archive。
          if (result.success && result.sentMessageId && !skipArchive) {
            try {
              const finalChatId = result.migratedToChatId ?? chatId;
              const accountInfo = await prisma.communicationAccount.findUnique({
                where: { id: accountId },
                select: { workspaceId: true, telegramUserId: true, displayName: true },
              });
              if (accountInfo?.workspaceId) {
                const group = await prisma.group.findUnique({
                  where: {
                    workspaceId_platformGroupId: {
                      workspaceId: accountInfo.workspaceId,
                      platformGroupId: finalChatId,
                    },
                  },
                  select: { id: true, chatType: true, tags: true, isHidden: true, notificationsMutedUntil: true },
                });
                if (group) {
                  const sentMsgIdStr = String(result.sentMessageId);
                  const existing = await prisma.directChatMessage.findFirst({
                    where: { groupId: group.id, platformMessageId: sentMsgIdStr },
                    select: { id: true },
                  });
                  if (!existing) {
                    const operatorId = typeof senderId === "string" ? senderId : null;
                    // 拿操作者 displayName 用於 SSE 即時格式（不然客戶端只看 SSE 會少（操作者）後綴）
                    let operatorName: string | null = null;
                    if (operatorId) {
                      const op = await prisma.user.findUnique({
                        where: { id: operatorId },
                        select: { displayName: true },
                      });
                      operatorName = op?.displayName ?? null;
                    }
                    // 跟 chat fetch / groups list 一致的「TG名(操作者)」格式
                    const tgName = accountInfo.displayName ?? null;
                    const formattedSender =
                      tgName && operatorName
                        ? `${tgName}(${operatorName})`
                        : (tgName ?? operatorName ?? "(系統)");

                    const archived = await prisma.directChatMessage.create({
                      data: {
                        workspaceId: accountInfo.workspaceId,
                        accountId,
                        groupId: group.id,
                        // senderId = 操作這個 send 動作的 Switchboard 使用者（如轉內部群的審核人員）。
                        // 直面對話的 send 端點直接寫 DB 不走這條，這裡專供透過 bridge /send 觸發者用。
                        senderId: operatorId,
                        senderPlatformId: accountInfo.telegramUserId ?? null,
                        senderDisplayName: accountInfo.displayName ?? null,
                        replyToPlatformId:
                          replyTo != null ? String(replyTo) : null,
                        direction: "OUTBOUND",
                        content: text,
                        messageType: "TEXT",
                        sentViaTelegram: true,
                        platformMessageId: sentMsgIdStr,
                      },
                      select: { id: true },
                    });
                    await notifyApp({
                      type: "chat:message",
                      workspaceId: accountInfo.workspaceId,
                      data: {
                        groupId: group.id,
                        messageId: archived.id,
                        platformMessageId: sentMsgIdStr,
                        replyToPlatformId:
                          replyTo != null ? String(replyTo) : null,
                        content: text.substring(0, 200),
                        senderName: formattedSender,
                        senderPlatformId: accountInfo.telegramUserId ?? null,
                        direction: "OUTBOUND",
                        messageType: "TEXT",
                        receivedAt: new Date().toISOString(),
                        chatType: group.chatType,
                        tags: group.tags ?? [],
                        isHidden: group.isHidden,
                        isMuted:
                          group.notificationsMutedUntil != null &&
                          group.notificationsMutedUntil > new Date(),
                      },
                    });
                  }
                }
              }
            } catch (archiveErr) {
              log.warn("post-send archive failed (non-fatal)", {
                error: String(archiveErr).slice(0, 200),
              });
            }
          }

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            success: result.success,
            ...(result.sentMessageId && { sentMessageId: result.sentMessageId }),
            ...(result.migratedToChatId && { migratedToChatId: result.migratedToChatId }),
            // Propagate the underlying Telegram error so the app can log it and
            // operators can see why a send failed (PEER_ID_INVALID, FLOOD_WAIT,
            // etc.) instead of a generic "bridge_reported_failure".
            ...(!result.success && result.error && { error: result.error }),
          }));
        } catch (error) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: String(error) }));
        }
        return;
      }

      // Send a file (native Telegram attachment) — called by Next.js app.
      // POST /send-file
      //   Content-Type: application/octet-stream
      //   X-Account-Id, X-Chat-Id, X-File-Name (URI-encoded), X-Mime-Type,
      //   X-Caption (URI-encoded, optional)
      //   body: raw file bytes
      //
      // Why streamed-bytes instead of "tell me where the file is on disk":
      // app + bridge are separate Railway containers and Railway volumes
      // are single-service. The bridge container can't see files written
      // by the app container's /api/upload. App layer reads the file from
      // its own volume and ships the bytes over our internal HTTP channel
      // (auth via INTERNAL_SECRET); bridge writes to /tmp, hands path to
      // GramJS sendFile, then unlinks.
      if (req.url === "/send-file" && req.method === "POST") {
        if (!verifySecret(req.headers.authorization)) {
          res.writeHead(401);
          res.end("Unauthorized");
          return;
        }

        const ctype = String(req.headers["content-type"] || "");
        if (!ctype.startsWith("application/octet-stream")) {
          res.writeHead(415, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            error: "Content-Type must be application/octet-stream (legacy JSON path-based mode removed)",
          }));
          return;
        }

        const accountId = String(req.headers["x-account-id"] || "");
        const chatId = String(req.headers["x-chat-id"] || "");
        const fileName = req.headers["x-file-name"]
          ? decodeURIComponent(String(req.headers["x-file-name"]))
          : "attachment.bin";
        const caption = req.headers["x-caption"]
          ? decodeURIComponent(String(req.headers["x-caption"]))
          : undefined;
        const topicId = req.headers["x-topic-id"] && Number.isFinite(Number(req.headers["x-topic-id"]))
          ? Math.floor(Number(req.headers["x-topic-id"]))
          : null;
        const voiceNote = String(req.headers["x-voice-note"] || "") === "1";
        const videoNote = String(req.headers["x-video-note"] || "") === "1";
        const supportsStreaming = String(req.headers["x-supports-streaming"] || "") === "1";
        const forceDocument = String(req.headers["x-force-document"] || "") === "1";
        if (!accountId || !chatId) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "X-Account-Id and X-Chat-Id headers required" }));
          return;
        }

        // 收 raw bytes
        const chunks: Buffer[] = [];
        let total = 0;
        const MAX_BYTES = 20 * 1024 * 1024; // mirror app upload cap
        try {
          for await (const c of req) {
            const buf = Buffer.isBuffer(c) ? c : Buffer.from(c);
            total += buf.length;
            if (total > MAX_BYTES) {
              res.writeHead(413, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "file too large (>20MB)" }));
              return;
            }
            chunks.push(buf);
          }
        } catch (err) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: `body read failed: ${String(err)}` }));
          return;
        }
        const buffer = Buffer.concat(chunks);

        // 寫到 bridge 自己的 /tmp,讓 GramJS sendFile 拿得到 path
        const tmpDir = path.join(process.env.MEDIA_UPLOAD_DIR || "./uploads", ".bridge-tmp");
        let tmpPath: string | null = null;
        try {
          await fs.mkdir(tmpDir, { recursive: true });
          // 保留原始副檔名讓 TG / GramJS 正確識別 mime;hex prefix 防衝突
          const ext = path.extname(fileName) || "";
          tmpPath = path.join(tmpDir, `${randomBytes(8).toString("hex")}${ext}`);
          await fs.writeFile(tmpPath, buffer);
          log.info("send-file dispatch", {
            accountId,
            chatId,
            bytes: buffer.length,
            fileName,
            hasCaption: !!caption,
          });
          const result = await clientManager.sendFile(accountId, chatId, tmpPath, caption, {
            voiceNote,
            videoNote,
            supportsStreaming,
            forceDocument,
            topicId,
          });
          log.info("send-file result", {
            accountId,
            success: result.success,
            sentMessageId: result.sentMessageId,
            error: result.error,
          });
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            success: result.success,
            ...(result.sentMessageId && { sentMessageId: result.sentMessageId }),
            ...(!result.success && result.error && { error: result.error }),
          }));
        } catch (error) {
          log.error("send-file dispatch failed", { error: String(error) });
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: String(error) }));
        } finally {
          // 即時清掉 tmp,失敗也別留下垃圾
          if (tmpPath) {
            await fs.unlink(tmpPath).catch(() => {});
          }
        }
        return;
      }

      // Send native Telegram payloads: poll/contact/location/dice/story reference.
      if (req.url === "/send-native" && req.method === "POST") {
        if (!verifySecret(req.headers.authorization)) {
          res.writeHead(401);
          res.end("Unauthorized");
          return;
        }
        try {
          const body = JSON.parse(await readBody(req));
          const { accountId, chatId, native, replyTo, topicId, scheduleDate } = body as {
            accountId?: string;
            chatId?: string;
            native?: NativeOutboundPayload;
            replyTo?: number;
            topicId?: number;
            scheduleDate?: number;
          };
          if (!accountId || !chatId) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "accountId, chatId, native are required" }));
            return;
          }
          const normalizedNative = normalizeNativeOutboundPayload(native);
          if (!normalizedNative) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "native payload is invalid" }));
            return;
          }
          const result = await clientManager.sendNative(accountId, chatId, normalizedNative, {
            replyToMsgId: replyTo,
            topicId,
            scheduleDate,
          });
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(result));
        } catch (error) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: String(error) }));
        }
        return;
      }

      // Reverse Telegram management operations: message/dialog pins, folders, channel basics.
      if (req.url === "/telegram-admin-action" && req.method === "POST") {
        if (!verifySecret(req.headers.authorization)) {
          res.writeHead(401);
          res.end("Unauthorized");
          return;
        }
        try {
          const body = JSON.parse(await readBody(req));
          const { accountId, action } = body as { accountId?: string; action?: TelegramAdminAction };
          if (!accountId) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "accountId and action are required" }));
            return;
          }
          const normalizedAction = normalizeTelegramAdminAction(action);
          if (!normalizedAction) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "admin action is invalid" }));
            return;
          }
          const result = await clientManager.applyTelegramAdminAction(accountId, normalizedAction);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(result));
        } catch (error) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: String(error) }));
        }
        return;
      }

      if ((req.url === "/calls" || req.url === "/secret-chats") && req.method === "POST") {
        if (!verifySecret(req.headers.authorization)) {
          res.writeHead(401);
          res.end("Unauthorized");
          return;
        }
        const result = clientManager.getUnsupportedNativeCapability(req.url === "/calls" ? "calls" : "secret-chats");
        res.writeHead(501, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result));
        return;
      }

      // QA-only: inject a synthetic "incoming message" into the pipeline.
      // Bypasses bridge's isOutgoing filter so the same QA account can
      // simulate BOTH the sender AND the broker — we can't ask the user
      // to have a second TG phone just for tests. Disabled unless
      // ENABLE_QA_INJECT=1 is set on the bridge (kept off in prod).
      //
      // Body: { pairingId, chatId, senderName, senderPlatformId, text }
      if (req.url === "/test-inject-message" && req.method === "POST") {
        if (process.env.ENABLE_QA_INJECT !== "1") {
          res.writeHead(403);
          res.end(JSON.stringify({ error: "QA inject disabled" }));
          return;
        }
        if (!verifySecret(req.headers.authorization)) {
          res.writeHead(401);
          res.end("Unauthorized");
          return;
        }
        try {
          const body = JSON.parse(await readBody(req));
          const {
            chatId,
            senderName,
            senderPlatformId,
            text,
            replyToMessageId,
          } = body;
          if (!chatId || !senderName || !text) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "missing fields" }));
            return;
          }
          // Find an active account that's a member of this chat so we have
          // a valid accountId to tag the synthetic message with. Match the
          // designated-listener selection in the real message handler so the
          // injection survives the dedupe check (prefer isListeningAccount,
          // tie-break by accountId ASC — mirrors the pipeline at line ~219).
          const group = await prisma.group.findFirst({
            where: { platformGroupId: String(chatId) },
            include: {
              accountMemberships: {
                where: { account: { status: "ACTIVE" } },
                orderBy: [
                  { isListeningAccount: "desc" },
                  { accountId: "asc" },
                ],
                take: 1,
                select: { accountId: true },
              },
            },
          });
          if (!group || group.accountMemberships.length === 0) {
            res.writeHead(404, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({ error: "no active account in that chat" }),
            );
            return;
          }
          const accountId = group.accountMemberships[0].accountId;

          // Invoke the same callback the real handler does. isOutgoing=false
          // so the pipeline processes it as a customer-sent message.
          const syntheticId = Date.now() * 1000 + Math.floor(Math.random() * 1000);
          const handler = clientManager["onMessage"] as
            | ((p: Record<string, unknown>) => Promise<void>)
            | null;
          if (!handler) {
            res.writeHead(500);
            res.end(JSON.stringify({ error: "pipeline handler not set" }));
            return;
          }
          // senderId is passed straight through as bigint/number by the
          // real NewMessage handler; downstream Prisma stringifies it when
          // writing. For the synthetic path we pre-stringify here so the
          // DB schema (String) validation doesn't fail.
          await handler({
            accountId,
            chatId: String(chatId),
            chatTitle: group.title,
            senderId: String(senderPlatformId ?? 99999999),
            senderName: String(senderName),
            messageId: syntheticId,
            text: String(text),
            replyToMessageId:
              replyToMessageId != null ? Number(replyToMessageId) : null,
            date: new Date(),
            isOutgoing: false,
            messageType: "TEXT" as const,
          });
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: true, syntheticId }));
        } catch (error) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: String(error) }));
        }
        return;
      }

      // Edit a previously-sent message (QA / test flows use this).
      // Body: { accountId, chatId, messageId, newText }
      if (req.url === "/edit-message" && req.method === "POST") {
        if (!verifySecret(req.headers.authorization)) {
          res.writeHead(401);
          res.end("Unauthorized");
          return;
        }
        try {
          const body = JSON.parse(await readBody(req));
          const { accountId, chatId, messageId, newText } = body;
          if (!accountId || !chatId || messageId == null || !newText) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "missing fields" }));
            return;
          }
          const result = await clientManager.editMessage(
            accountId,
            String(chatId),
            Number(messageId),
            String(newText),
          );
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(result));
        } catch (error) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: String(error) }));
        }
        return;
      }

      // 對 TG 訊息加 emoji reaction（或清掉 reaction）
      // Body: { accountId, chatId, messageId, emoji }；emoji=null 表示清除
      // 從 TG 補抓某個對話的歷史訊息進 DirectChatMessage。
      // 用途：剛綁帳號 / 帳號重新連線 / 之前停用過的對話現在想看舊訊息。
      // Body: { accountId, chatId, limit? }；limit 上限 500，預設 100。
      if (req.url === "/backfill-history" && req.method === "POST") {
        if (!verifySecret(req.headers.authorization)) {
          res.writeHead(401);
          res.end("Unauthorized");
          return;
        }
        try {
          const body = JSON.parse(await readBody(req));
          const { accountId, chatId, limit = 100 } = body;
          if (!accountId || !chatId) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "missing fields" }));
            return;
          }
          const workspaceId = clientManager.getWorkspaceId(accountId);
          if (!workspaceId) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "account not bound to workspace" }));
            return;
          }
          // 確認 group 在 DB 有對應 row（補抓前必須先 register / opt-in）
          const group = await prisma.group.findUnique({
            where: { workspaceId_platformGroupId: { workspaceId, platformGroupId: String(chatId) } },
            select: { id: true, chatType: true },
          });
          if (!group) {
            res.writeHead(404, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "group not registered" }));
            return;
          }

          const history = await clientManager.fetchHistory(accountId, String(chatId), Number(limit));
          if (!history) {
            res.writeHead(502, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "TG fetch failed (account not connected or timeout)" }));
            return;
          }

          // 一筆一筆 upsert（用 platformMessageId dedupe），媒體一起入庫
          //
          // 重要：用 `createMany` 而不是 `create`，原因是
          //   `create` 內部用 RETURNING * — 如果 Railway DB 還沒跑 0009
          //   migration（reactions 欄位不存在），整個 query 會直接炸。
          //   `createMany` 不用 RETURNING，只回 { count }，所以對 schema lag
          //   有韌性。每筆獨立 try/catch — 一筆爛訊息不會殺掉整個補抓。
          let inserted = 0;
          let skipped = 0;
          let patched = 0;
          let mediaStored = 0;
          let failed = 0;
          let lastFailureSample: string | null = null;
          for (const m of history) {
            const platformMessageId = String(m.messageId);
            const existing = await prisma.directChatMessage.findFirst({
              where: { groupId: group.id, platformMessageId },
              select: { id: true },
            });
            if (existing) {
              skipped++;
              // 2026-05-21 修:在「訊息按鈕 / entities」功能上線前就存進來的舊訊息,
              // replyMarkup / entities / groupedId 都是 null。re-backfill 時順手把這些
              // TG-parity 欄位補到既有 row,讓歷史 bot 按鈕、文字格式能顯示出來。
              // 只在 TG 抓回的版本確實有內容時才寫(不會把既有資料清成 null)。
              try {
                const patch: Prisma.DirectChatMessageUpdateInput = {};
                if (m.replyMarkup) {
                  patch.replyMarkup = m.replyMarkup as Prisma.InputJsonValue;
                }
                if (m.entities) {
                  patch.entities = m.entities as Prisma.InputJsonValue;
                }
                if (m.groupedId) patch.groupedId = m.groupedId;
                if (Object.keys(patch).length > 0) {
                  await prisma.directChatMessage.update({
                    where: { id: existing.id },
                    data: patch,
                  });
                  patched++;
                }
              } catch (patchErr) {
                log.warn("Backfill parity-field patch failed (non-fatal)", {
                  platformMessageId,
                  error: String(patchErr).slice(0, 200),
                });
              }
              continue;
            }
            // 過濾「完全空白」訊息：沒文字 + 沒媒體 → 跳過
            const hasText = m.text && m.text.trim().length > 0;
            const hasMediaBuffer = !!m.mediaInfo?.buffer;
            if (!hasText && !hasMediaBuffer) {
              skipped++;
              continue;
            }

            // 媒體：先存進 MediaFile（如果有 buffer），拿到 mediaUrl 給 DCM 用
            let mediaUrl: string | null = null;
            if (hasMediaBuffer && m.mediaInfo) {
              try {
                const result = await MediaFileManager.storeFromTelegram(
                  m.mediaInfo.buffer!,
                  m.mediaInfo.fileName || "file",
                  m.mediaInfo.mimeType || "application/octet-stream",
                  workspaceId,
                );
                mediaUrl = result.url;
                mediaStored++;
              } catch (mediaErr) {
                log.warn("Backfill media storage failed (non-fatal)", {
                  platformMessageId,
                  error: String(mediaErr).slice(0, 200),
                });
                // 媒體存失敗 → 仍寫入 DCM，但 mediaUrl=null（caller UI
                // 看不到圖但至少有時間軸 + 文字 caption 如果有的話）
              }
            }

            try {
              const result = await prisma.directChatMessage.createMany({
                data: [
                  {
                    workspaceId,
                    accountId,
                    groupId: group.id,
                    senderId: null,
                    senderPlatformId: m.fromMe ? null : m.senderId,
                    senderDisplayName: m.fromMe ? null : m.senderName,
                    replyToPlatformId:
                      m.replyToMessageId != null ? String(m.replyToMessageId) : null,
                    direction: m.fromMe ? "OUTBOUND" : "INBOUND",
                    content: m.text || "", // schema 不允許 null，空白用 ""
                    messageType: m.messageType,
                    mediaUrl,
                    mediaType: m.mediaInfo?.mimeType ?? null,
                    mediaFileName: m.mediaInfo?.fileName ?? null,
                    // 補抓歷史:bytes-less 媒體(LOCATION/CONTACT/POLL)也要帶上 metadata
                    mediaMetadata: m.metadata ?? Prisma.JsonNull,
                    forwardedFrom: (m.forwardedFrom ?? Prisma.JsonNull) as Prisma.InputJsonValue,
                    topicId: m.topicId ?? null,
                    viewCount: m.viewCount ?? null,
                    quoteText: m.quoteText ?? null,
                    // 2026-05-21 TG parity:Message entities + Album grouped_id + 訊息按鈕
                    entities: (m.entities ?? Prisma.JsonNull) as Prisma.InputJsonValue,
                    groupedId: m.groupedId ?? null,
                    replyMarkup: (m.replyMarkup ?? Prisma.JsonNull) as Prisma.InputJsonValue,
                    sentViaTelegram: m.fromMe,
                    platformMessageId,
                    createdAt: m.date,
                  },
                ],
              });
              if (result.count > 0) inserted++;
              else failed++;
            } catch (rowErr) {
              failed++;
              const err = rowErr as { code?: string; message?: string; meta?: unknown };
              const sample = `${err.code ?? "ERR"}: ${(err.message ?? String(rowErr)).slice(0, 300)}`;
              if (!lastFailureSample) lastFailureSample = sample;
              log.warn("Backfill row insert failed", {
                platformMessageId,
                code: err.code,
                message: (err.message ?? String(rowErr)).slice(0, 200),
                meta: err.meta,
              });
            }
          }
          // 補抓完不發 SSE 個別事件（量太大會洗版）— 前端若需要更新就重 fetch 一次
          log.info("Backfill history complete", {
            workspaceId,
            groupId: group.id,
            inserted,
            skipped,
            patched,
            mediaStored,
            failed,
            total: history.length,
            firstFailure: lastFailureSample,
          });
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              success: true,
              inserted,
              skipped,
              patched,
              mediaStored,
              failed,
              total: history.length,
              ...(lastFailureSample ? { firstFailure: lastFailureSample } : {}),
            }),
          );
        } catch (error) {
          // 把 Prisma error code / meta 一起回去 — 200 chars 不夠看出根因
          const err = error as { code?: string; message?: string; meta?: unknown };
          const detail = {
            code: err.code,
            message: (err.message ?? String(error)).slice(0, 800),
            meta: err.meta,
          };
          log.error("Backfill handler crashed", detail);
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: detail.message, code: detail.code, meta: detail.meta }));
        }
        return;
      }

      if (req.url === "/send-reaction" && req.method === "POST") {
        if (!verifySecret(req.headers.authorization)) {
          res.writeHead(401);
          res.end("Unauthorized");
          return;
        }
        try {
          const body = JSON.parse(await readBody(req));
          const { accountId, chatId, messageId, emoji } = body;
          if (!accountId || !chatId || messageId == null) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "missing fields" }));
            return;
          }
          const result = await clientManager.sendReaction(
            accountId,
            String(chatId),
            Number(messageId),
            typeof emoji === "string" && emoji.length > 0 ? emoji : null,
          );
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(result));
        } catch (error) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: String(error) }));
        }
        return;
      }

      // Delete messages (QA / test flows use this).
      // Body: { accountId, chatId, messageIds: number[] }
      if (req.url === "/delete-messages" && req.method === "POST") {
        if (!verifySecret(req.headers.authorization)) {
          res.writeHead(401);
          res.end("Unauthorized");
          return;
        }
        try {
          const body = JSON.parse(await readBody(req));
          const { accountId, chatId, messageIds } = body;
          if (!accountId || !chatId || !Array.isArray(messageIds)) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "missing fields" }));
            return;
          }
          const result = await clientManager.deleteMessages(
            accountId,
            String(chatId),
            messageIds.map(Number),
          );
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(result));
        } catch (error) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: String(error) }));
        }
        return;
      }

      // P2 2026-05-20: 抓 TG 原生資料夾 (DialogFilter)。
      // body: { accountId } / 回 { filters: [{tgFilterId, title, emoticon, peerIds}] }
      if (req.url === "/get-dialog-filters" && req.method === "POST") {
        if (!verifySecret(req.headers.authorization)) {
          res.writeHead(401);
          res.end("Unauthorized");
          return;
        }
        try {
          const body = JSON.parse(await readBody(req));
          const { accountId } = body;
          if (!accountId) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "missing accountId" }));
            return;
          }
          const filters = await clientManager.getDialogFilters(accountId);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ filters }));
        } catch (error) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: String(error) }));
        }
        return;
      }

      // P2 2026-05-20: 列出 group / channel 的成員清單。
      // body: { accountId, chatId, limit? } / 回 { participants: [{platformUserId, displayName}] }
      if (req.url === "/list-participants" && req.method === "POST") {
        if (!verifySecret(req.headers.authorization)) {
          res.writeHead(401);
          res.end("Unauthorized");
          return;
        }
        try {
          const body = JSON.parse(await readBody(req));
          const { accountId, chatId, limit } = body;
          if (!accountId || !chatId) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "missing fields" }));
            return;
          }
          const participants = await clientManager.listGroupParticipants(
            accountId,
            String(chatId),
            typeof limit === "number" ? limit : 200,
          );
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ participants }));
        } catch (error) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: String(error) }));
        }
        return;
      }

      // P2 2026-05-20: 列出某則訊息的反應者清單。
      // body: { accountId, chatId, messageId } / 回 { reactions: [{platformUserId, firstName, lastName, username, emoji, date}] }
      if (req.url === "/get-reaction-list" && req.method === "POST") {
        if (!verifySecret(req.headers.authorization)) {
          res.writeHead(401);
          res.end("Unauthorized");
          return;
        }
        try {
          const body = JSON.parse(await readBody(req));
          const { accountId, chatId, messageId } = body;
          if (!accountId || !chatId || messageId == null) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "missing fields" }));
            return;
          }
          const reactions = await clientManager.getReactionList(
            accountId,
            String(chatId),
            Number(messageId),
          );
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ reactions }));
        } catch (error) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: String(error) }));
        }
        return;
      }

      // P1 2026-05-20: 抓 group / channel 的釘選訊息 id。
      // body: { accountId, chatId } / 回 { pinnedMessageId: string | null, error? }
      if (req.url === "/get-pinned-message" && req.method === "POST") {
        if (!verifySecret(req.headers.authorization)) {
          res.writeHead(401);
          res.end("Unauthorized");
          return;
        }
        try {
          const body = JSON.parse(await readBody(req));
          const { accountId, chatId } = body;
          if (!accountId || !chatId) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "missing fields" }));
            return;
          }
          const result = await clientManager.getPinnedMessageId(
            accountId,
            String(chatId),
          );
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(result));
        } catch (error) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: String(error) }));
        }
        return;
      }

      // 2026-05-21 TG Business Phase B:Pull server-side quick replies。
      // body: { accountId }
      // 回 { shortcuts: [{ shortcutId, shortcut, topMessageId, count }], error? }
      if (req.url === "/tg-business/quick-replies" && req.method === "POST") {
        if (!verifySecret(req.headers.authorization)) {
          res.writeHead(401);
          res.end("Unauthorized");
          return;
        }
        try {
          const body = JSON.parse(await readBody(req));
          const { accountId } = body;
          if (!accountId) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "accountId is required" }));
            return;
          }
          const result = await clientManager.getQuickReplies(accountId);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(result));
        } catch (error) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: String(error) }));
        }
        return;
      }

      // 2026-05-21 TG Business Phase B:Push away / greeting / work-hours。
      // body 三選一:
      //   { accountId, kind: "away" | "greeting", text: string | null }
      //   { accountId, kind: "work-hours", hours: [{startMinute,endMinute}] | null, utcOffsetMinutes }
      if (req.url === "/tg-business/profile" && req.method === "POST") {
        if (!verifySecret(req.headers.authorization)) {
          res.writeHead(401);
          res.end("Unauthorized");
          return;
        }
        try {
          const body = JSON.parse(await readBody(req));
          const { accountId, kind } = body;
          if (!accountId || !kind) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "accountId, kind required" }));
            return;
          }
          let result: { ok: boolean; error?: string };
          if (kind === "away") {
            result = await clientManager.updateBusinessAwayMessage(
              accountId,
              typeof body.text === "string" ? body.text : null,
            );
          } else if (kind === "greeting") {
            result = await clientManager.updateBusinessGreetingMessage(
              accountId,
              typeof body.text === "string" ? body.text : null,
            );
          } else if (kind === "work-hours") {
            result = await clientManager.updateBusinessWorkHours(
              accountId,
              Array.isArray(body.hours) ? body.hours : null,
              typeof body.utcOffsetMinutes === "number" ? body.utcOffsetMinutes : null,
            );
          } else {
            result = { ok: false, error: `unknown kind: ${kind}` };
          }
          res.writeHead(result.ok ? 200 : 502, { "Content-Type": "application/json" });
          res.end(JSON.stringify(result));
        } catch (error) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: String(error) }));
        }
        return;
      }

      // 2026-05-21 二線:Pull TG pinned dialogs。
      // body: { accountId }
      // 回 { pinnedChatIds: string[], error? }
      if (req.url === "/sync-pinned-dialogs" && req.method === "POST") {
        if (!verifySecret(req.headers.authorization)) {
          res.writeHead(401);
          res.end("Unauthorized");
          return;
        }
        try {
          const body = JSON.parse(await readBody(req));
          const { accountId } = body;
          if (!accountId) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "accountId is required" }));
            return;
          }
          const result = await clientManager.getPinnedDialogIds(accountId);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(result));
        } catch (error) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: String(error) }));
        }
        return;
      }

      // 2026-05-21 訊息按鈕:點 callback 按鈕 → GetBotCallbackAnswer。
      // body: { accountId, chatId, platformMessageId, data(base64) }
      // 回 { ok, message?, alert?, url?, error? }
      if (req.url === "/click-button" && req.method === "POST") {
        if (!verifySecret(req.headers.authorization)) {
          res.writeHead(401);
          res.end("Unauthorized");
          return;
        }
        try {
          const body = JSON.parse(await readBody(req));
          const { accountId, chatId, platformMessageId, data } = body;
          if (!accountId || !chatId || platformMessageId == null || typeof data !== "string") {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "missing fields" }));
            return;
          }
          const pmid = Number(platformMessageId);
          if (!Number.isFinite(pmid) || pmid <= 0) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "platformMessageId must be positive number" }));
            return;
          }
          const result = await clientManager.clickCallbackButton(
            accountId,
            String(chatId),
            pmid,
            data,
          );
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(result));
        } catch (error) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: String(error) }));
        }
        return;
      }

      // 2026-05-21 Wave 1:contacts 操作(封鎖 / 解除封鎖 / 加聯絡人)。
      // body: { accountId, chatId, action, firstName? } → { success, error? }
      if (req.url === "/contact-action" && req.method === "POST") {
        if (!verifySecret(req.headers.authorization)) {
          res.writeHead(401);
          res.end("Unauthorized");
          return;
        }
        try {
          const body = JSON.parse(await readBody(req));
          const { accountId, chatId, action, firstName } = body;
          if (!accountId || !chatId || !action) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({ error: "missing accountId, chatId or action" }),
            );
            return;
          }
          const result = await clientManager.contactAction(
            accountId,
            String(chatId),
            action,
            typeof firstName === "string" ? firstName : undefined,
          );
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(result));
        } catch (error) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: String(error) }));
        }
        return;
      }

      // 2026-05-21 Batch 4:account.getAuthorizations(帳號的已登入裝置列表)。
      // body: { accountId } → { authorizations: [...], error? }
      if (req.url === "/get-authorizations" && req.method === "POST") {
        if (!verifySecret(req.headers.authorization)) {
          res.writeHead(401);
          res.end("Unauthorized");
          return;
        }
        try {
          const body = JSON.parse(await readBody(req));
          const { accountId } = body;
          if (!accountId) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "missing accountId" }));
            return;
          }
          const result = await clientManager.getAuthorizations(accountId);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(result));
        } catch (error) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: String(error) }));
        }
        return;
      }

      // 2026-05-21 Batch 4:account.resetAuthorization(遠端登出某裝置)。
      // body: { accountId, hash } → { success, error? }
      if (req.url === "/reset-authorization" && req.method === "POST") {
        if (!verifySecret(req.headers.authorization)) {
          res.writeHead(401);
          res.end("Unauthorized");
          return;
        }
        try {
          const body = JSON.parse(await readBody(req));
          const { accountId, hash } = body;
          if (!accountId || !hash) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "missing accountId or hash" }));
            return;
          }
          const result = await clientManager.resetAuthorization(
            accountId,
            String(hash),
          );
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(result));
        } catch (error) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: String(error) }));
        }
        return;
      }

      // 2026-05-21 TG parity:GetMessageReadParticipants(小群已讀名單)。
      // body: { accountId, chatId, platformMessageId }
      // 回 { readBy: string[], error? }
      if (req.url === "/get-read-participants" && req.method === "POST") {
        if (!verifySecret(req.headers.authorization)) {
          res.writeHead(401);
          res.end("Unauthorized");
          return;
        }
        try {
          const body = JSON.parse(await readBody(req));
          const { accountId, chatId, platformMessageId } = body;
          if (!accountId || !chatId || platformMessageId == null) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "missing fields" }));
            return;
          }
          const pmid = Number(platformMessageId);
          if (!Number.isFinite(pmid) || pmid <= 0) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "platformMessageId must be positive number" }));
            return;
          }
          const result = await clientManager.getMessageReadParticipants(
            accountId,
            String(chatId),
            pmid,
          );
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(result));
        } catch (error) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: String(error) }));
        }
        return;
      }

      // 2026-05-21 TG parity:Native TG translation。
      // body: { accountId, chatId, platformMessageId, toLang }
      // 回 { text, entities?, error? } — caller(/messages/[id]/translate API)
      // 負責把結果 cache 進 ConversationMessageTranslation。
      if (req.url === "/translate" && req.method === "POST") {
        if (!verifySecret(req.headers.authorization)) {
          res.writeHead(401);
          res.end("Unauthorized");
          return;
        }
        try {
          const body = JSON.parse(await readBody(req));
          const { accountId, chatId, platformMessageId, toLang } = body;
          if (
            !accountId ||
            !chatId ||
            platformMessageId == null ||
            !toLang ||
            typeof toLang !== "string"
          ) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "missing fields" }));
            return;
          }
          const pmid = Number(platformMessageId);
          if (!Number.isFinite(pmid) || pmid <= 0) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "platformMessageId must be positive number" }));
            return;
          }
          const result = await clientManager.translateMessage(
            accountId,
            String(chatId),
            pmid,
            toLang,
          );
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(result));
        } catch (error) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: String(error) }));
        }
        return;
      }

      // P1 2026-05-20: 轉發訊息到另一個對話。
      // body: { accountId, fromChatId, messageIds[], toChatId }
      // 回 { success, sentMessageIds[] }(轉發後在 target chat 的新訊息 id)。
      if (req.url === "/forward-messages" && req.method === "POST") {
        if (!verifySecret(req.headers.authorization)) {
          res.writeHead(401);
          res.end("Unauthorized");
          return;
        }
        try {
          const body = JSON.parse(await readBody(req));
          const { accountId, fromChatId, messageIds, toChatId } = body;
          if (
            !accountId ||
            !fromChatId ||
            !toChatId ||
            !Array.isArray(messageIds) ||
            messageIds.length === 0
          ) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "missing fields" }));
            return;
          }
          const result = await clientManager.forwardMessages(
            accountId,
            String(fromChatId),
            messageIds.map(Number),
            String(toChatId),
          );
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(result));
        } catch (error) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: String(error) }));
        }
        return;
      }

      // Reconnect account
      if (req.url === "/reconnect" && req.method === "POST") {
        if (!verifySecret(req.headers.authorization)) {
          res.writeHead(401);
          res.end("Unauthorized");
          return;
        }

        try {
          const body = JSON.parse(await readBody(req));
          await clientManager.startOne(body.accountId);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: true }));
        } catch (error) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: String(error) }));
        }
        return;
      }

      // Stop account (called when account deleted from UI)
      // Cleanly disconnects the GramJS client + frees the slot for other accounts
      if (req.url === "/stop-account" && req.method === "POST") {
        if (!verifySecret(req.headers.authorization)) {
          res.writeHead(401);
          res.end("Unauthorized");
          return;
        }
        try {
          const body = JSON.parse(await readBody(req));
          await clientManager.stopOne(body.accountId);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: true }));
        } catch (error) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: String(error) }));
        }
        return;
      }

      // Discover groups
      if (req.url === "/discover" && req.method === "POST") {
        if (!verifySecret(req.headers.authorization)) {
          res.writeHead(401);
          res.end("Unauthorized");
          return;
        }

        await discoverAllGroups();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true }));
        return;
      }

      // Preview-only discovery: returns NEW groups not yet in DB (no auto-register)
      if (req.url === "/discover-preview" && req.method === "POST") {
        if (!verifySecret(req.headers.authorization)) {
          res.writeHead(401);
          res.end("Unauthorized");
          return;
        }

        try {
          const accounts = await prisma.communicationAccount.findMany({
            where: { status: "ACTIVE" },
            include: { telegramSession: true },
          });

          const allDiscovered: Array<{
            platformGroupId: string;
            title: string;
            chatType: string;
            accountId: string;
            accountName: string;
            isNew: boolean;
            isReactivatable: boolean;  // 群組存在但被軟刪除，需要重新啟用
            // 目前是否啟用監聽（給 UI 判斷預設勾選 / 顯示「監聽中」狀態用）
            isCurrentlyListening: boolean;
            // 規格 2026-05-06:同步 dialog 預設勾選用。
            //   - wasPreviouslyPaired:此 group 在 DB 裡有 PairingGroup ref
            //     (含已停用的配對) → 用來決定 re-add 帳號時自動重連舊配對。
            //   - wasPreviouslyHidden:explicit isHidden=true → 用來把使用者
            //     之前刻意隱藏的群組從預設勾選裡剔除。
            wasPreviouslyPaired: boolean;
            wasPreviouslyHidden: boolean;
          }> = [];

          // 收集每個帳號的執行錯誤（不讓單一帳號失敗拖垮整批）
          const accountErrors: Array<{ accountId: string; accountName: string; error: string }> = [];

          for (const account of accounts) {
            try {
              const groups = await clientManager.discoverGroups(account.id);
              for (const g of groups) {
                const existing = await prisma.group.findUnique({
                  where: {
                    workspaceId_platformGroupId: {
                      workspaceId: account.workspaceId,
                      platformGroupId: g.platformGroupId,
                    },
                  },
                });
                // (Pairing-history check removed with H3 — no Pairing
                // table any more. wasPreviouslyPaired is now permanently
                // false; UI uses isReactivatable / wasPreviouslyHidden
                // alone for the default-checked set.)
                allDiscovered.push({
                  platformGroupId: g.platformGroupId,
                  title: g.title,
                  chatType: g.chatType,
                  accountId: account.id,
                  accountName: account.displayName ||
                    [account.telegramFirstName, account.telegramLastName].filter(Boolean).join(" ") ||
                    account.phoneNumber ||
                    "(未命名)",
                  isNew: !existing,
                  isReactivatable: !!existing && !existing.isActive,
                  isCurrentlyListening: !!existing && existing.isActive,
                  wasPreviouslyPaired: false,
                  wasPreviouslyHidden: !!existing && existing.isHidden,
                });
              }
            } catch (err) {
              accountErrors.push({
                accountId: account.id,
                accountName: account.displayName ||
                  [account.telegramFirstName, account.telegramLastName].filter(Boolean).join(" ") ||
                  "(未命名)",
                error: err instanceof Error ? err.message : String(err),
              });
            }
          }

          // ── 同名 dedupe：合併「超級群組升級」造成的重複群組
          // 主因：TG 把「升級前的 GROUP」+「升級後的 CHANNEL/supergroup」都吐回來，
          // 兩筆指向同一個物理群組。前端勾選時應該只看到一筆。
          //
          // 重要：dedupe key 加上 chatType — 不同類型不應該合併。私訊跟群組
          // 即使同名（罕見但會發生：使用者群組名稱跟某個聯絡人重名）也是兩個獨立
          // 對話，UI 必須各自顯示讓使用者選。
          //   優先順序：
          //     (1) -100 開頭（supergroup）優先
          //     (2) 同類別則 isReactivatable=false 優先（=有對應的 active row）
          //     (3) 仍同則照原順序
          //
          // 把 PRIVATE 排除在 dedupe 之外（私訊永遠單獨，不需要合併）。
          const byKey = new Map<string, typeof allDiscovered>();
          const privatesUnchanged: typeof allDiscovered = [];
          for (const g of allDiscovered) {
            if (g.chatType === "PRIVATE") {
              privatesUnchanged.push(g);
              continue;
            }
            // 對群組 / 頻道才做 dedupe；key 含 chatType 防止 GROUP / CHANNEL 互吞
            const key = `${g.accountId}|${g.title}|GROUPLIKE`;
            const list = byKey.get(key) ?? [];
            list.push(g);
            byKey.set(key, list);
          }
          const dedupedGroups: typeof allDiscovered = [...privatesUnchanged];
          for (const list of byKey.values()) {
            if (list.length === 1) {
              dedupedGroups.push(list[0]);
              continue;
            }
            const sorted = [...list].sort((a, b) => {
              const aIs100 = a.platformGroupId.startsWith("-100");
              const bIs100 = b.platformGroupId.startsWith("-100");
              if (aIs100 !== bIs100) return aIs100 ? -1 : 1;
              if (a.isReactivatable !== b.isReactivatable)
                return a.isReactivatable ? 1 : -1;
              return 0;
            });
            // 合併群組類：把保留的那筆強制標 chatType=GROUP（避免「升級前的 GROUP」+
            // 「升級後的 supergroup-as-CHANNEL」兩種解讀並存導致 icon 顯示成頻道）
            const keep = sorted[0];
            dedupedGroups.push({ ...keep, chatType: "GROUP" });
          }

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            success: accountErrors.length === 0,
            groups: dedupedGroups,
            newCount: dedupedGroups.filter((g) => g.isNew).length,
            totalCount: dedupedGroups.length,
            errors: accountErrors,  // 帶回每個失敗帳號的原因，前端可細部呈現
          }));
        } catch (error) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: String(error) }));
        }
        return;
      }

      // 查 TG 用戶 profile：透過任一個 active 帳號 client 呼叫 getEntity，
      // 拿到 username / bio / 名稱。給「點擊使用者名稱彈窗」功能用。
      if (req.url === "/user-info" && req.method === "POST") {
        if (!verifySecret(req.headers.authorization)) {
          res.writeHead(401);
          res.end("Unauthorized");
          return;
        }
        try {
          const body = JSON.parse(await readBody(req));
          const platformUserId: string | undefined = body.platformUserId;
          const workspaceId: string | undefined = body.workspaceId;
          if (!platformUserId || !workspaceId) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "platformUserId and workspaceId required" }));
            return;
          }
          // 找此 workspace 全部已連線的帳號 — info 取第一個成功的，
          // commonChats 則需要每個帳號各別查（不同帳號跟同一個 user 的共同群不一樣）
          const accounts = await prisma.communicationAccount.findMany({
            where: { workspaceId, status: "ACTIVE" },
            select: { id: true },
          });
          let info: Awaited<ReturnType<typeof clientManager.getUserInfo>> = null;
          const commonChatsByAccount: Record<string, Array<{ chatId: string; title: string }>> = {};
          for (const a of accounts) {
            try {
              if (!info) {
                info = await clientManager.getUserInfo(a.id, platformUserId);
              }
              const cc = await clientManager.getCommonChats(a.id, platformUserId);
              if (cc) commonChatsByAccount[a.id] = cc;
            } catch {
              // 換下一個帳號試
            }
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ info, commonChatsByAccount }));
        } catch (err) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: String(err).slice(0, 200) }));
        }
        return;
      }

      // 查詢單一帳號的 client 連線狀態（前端可 poll，等到 connected 才同步）
      if (req.url?.startsWith("/account-status/") && req.method === "GET") {
        if (!verifySecret(req.headers.authorization)) {
          res.writeHead(401);
          res.end("Unauthorized");
          return;
        }
        const accountId = req.url.split("/account-status/")[1];
        if (!accountId) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "missing accountId" }));
          return;
        }
        const status = clientManager.getAccountStatus(accountId);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ accountId, status }));
        return;
      }

      // 2026-05-22 Sticker sets: list account's saved sticker sets.
      // GET /sticker-sets/:accountId
      // 回 { sets: [{id, accessHash, title, shortName, count}] }
      if (req.url?.startsWith("/sticker-sets/") && req.method === "GET") {
        if (!verifySecret(req.headers.authorization)) {
          res.writeHead(401);
          res.end("Unauthorized");
          return;
        }
        const parts = req.url.split("/");
        // /sticker-sets/:accountId        → parts = ["","sticker-sets",accountId]
        // /sticker-sets/:accountId/:setId → parts = ["","sticker-sets",accountId,setId]
        const accountId = parts[2];
        const setId = parts[3];
        if (!accountId) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "missing accountId" }));
          return;
        }
        try {
          if (setId) {
            // GET /sticker-sets/:accountId/:setId?accessHash=yyy
            const qs = req.url.includes("?") ? req.url.split("?")[1] : "";
            const accessHash = new URLSearchParams(qs).get("accessHash") ?? "";
            if (!accessHash) {
              res.writeHead(400, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "missing accessHash query param" }));
              return;
            }
            const stickers = await clientManager.getStickerSetStickers(accountId, setId, accessHash);
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ stickers }));
          } else {
            // GET /sticker-sets/:accountId
            const sets = await clientManager.getStickerSets(accountId);
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ sets }));
          }
        } catch (error) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: String(error) }));
        }
        return;
      }

      // 2026-05-22 Sticker thumb proxy: download sticker bytes for display.
      // body: { accountId, docId, accessHash, fileReference }
      // 回: image/webp bytes (or 404 JSON)
      if (req.url === "/download-sticker-thumb" && req.method === "POST") {
        if (!verifySecret(req.headers.authorization)) {
          res.writeHead(401);
          res.end("Unauthorized");
          return;
        }
        try {
          const body = JSON.parse(await readBody(req));
          const { accountId, docId, accessHash, fileReference } = body;
          if (!accountId || !docId || !accessHash || !fileReference) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "missing fields" }));
            return;
          }
          const buf = await clientManager.downloadStickerMedia(
            String(accountId),
            String(docId),
            String(accessHash),
            String(fileReference),
          );
          if (!buf) {
            res.writeHead(404, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "not found" }));
            return;
          }
          res.writeHead(200, {
            "Content-Type": "image/webp",
            "Cache-Control": "public,max-age=31536000,immutable",
          });
          res.end(buf);
        } catch (error) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: String(error) }));
        }
        return;
      }

      // 2026-05-22 Send sticker: send an existing TG sticker document to a chat.
      // body: { accountId, chatId, docId, accessHash, fileReference }
      // 回 { success, sentMessageId? }
      if (req.url === "/send-sticker" && req.method === "POST") {
        if (!verifySecret(req.headers.authorization)) {
          res.writeHead(401);
          res.end("Unauthorized");
          return;
        }
        try {
          const body = JSON.parse(await readBody(req));
          const { accountId, chatId, docId, accessHash, fileReference } = body;
          if (!accountId || !chatId || !docId || !accessHash || !fileReference) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "missing fields" }));
            return;
          }
          const result = await clientManager.sendStickerDocument(
            String(accountId),
            String(chatId),
            String(docId),
            String(accessHash),
            String(fileReference),
          );
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(result));
        } catch (error) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: String(error) }));
        }
        return;
      }

      res.writeHead(404);
      res.end();
    }
  );

  server.listen(BRIDGE_PORT, () => {
    log.info("HTTP server listening", { port: BRIDGE_PORT });
  });

  return server;
}

// ─── Main ──────────────────────────────────────────────────────

async function main() {
  log.info("Starting Telegram Bridge Worker...");

  // Verify database connectivity before starting anything else
  try {
    await prisma.$queryRaw`SELECT 1`;
    log.info("Database connection verified");
  } catch (e) {
    log.error("Database not ready", { error: String(e) });
    process.exit(1);
  }

  // 跨 instance 互斥鎖:阻擋兩個 bridge 同時連 Telegram 撞 AUTH_KEY_DUPLICATED。
  // Railway rolling deploy 期間,新 bridge 會在這裡 hang 住等舊 bridge
  // graceful shutdown 釋放鎖,順序自然變成「舊→新」交接。
  let bridgeLock: SingletonLock;
  try {
    bridgeLock = await acquireBridgeLock(process.env.DATABASE_URL!);
  } catch (e) {
    log.error("Failed to acquire bridge singleton lock", { error: String(e) });
    process.exit(1);
  }

  // Connect all active accounts
  await clientManager.loadAllAccounts();

  // Initial group discovery
  await discoverAllGroups();

  // Periodic tasks
  // H5 fix: wrap periodic tasks in error boundary
  const safeLockCleanup = async () => {
    try { await cleanupStaleLocks(); } catch (e) { log.error("Lock cleanup failed", { error: String(e) }); }
  };
  const safeDiscovery = async () => {
    try { await discoverAllGroups(); } catch (e) { log.error("Group discovery failed", { error: String(e) }); }
    // 2026-05-21:群組 discovery 完成後緊接著自動同步 TG 原生資料夾。
    // 順序刻意 — 資料夾 sync 要靠 discovery 先把新群組入庫才解析得到 Group.id。
    try { await syncAllAccountFolders(); } catch (e) { log.error("TG folder sync failed", { error: String(e) }); }
  };
  const safeRetention = async () => {
    try { await cleanupRetention(); } catch (e) { log.error("Retention cleanup failed", { error: String(e) }); }
  };
  const lockCleanupInterval = setInterval(safeLockCleanup, 60 * 1000);
  const discoveryInterval = setInterval(safeDiscovery, 5 * 60 * 1000);
  // Run retention cleanup once at boot (fast, bounded) then hourly.
  safeRetention();
  const retentionInterval = setInterval(safeRetention, 60 * 60 * 1000);
  // Avatar cache + GC: runs every 2 minutes with a small batch. Non-critical;
  // swallow errors so the bridge doesn't fall over if Telegram is slow.
  const safeAvatarFetch = async () => {
    // 順序刻意:先 enumerate group participants 把 candidates 寫進
    // SenderAvatar(refreshedAt=null),fetchMissingSenderAvatars 緊接著
    // 撈那些 candidates 抓 photo,同 tick 完成「成員有 row → row 有 photo」
    // 兩個動作。
    try {
      await enumerateGroupParticipants();
    } catch (e) {
      log.error("Group participant enumeration failed", { error: String(e) });
    }
    try {
      await fetchMissingSenderAvatars();
    } catch (e) {
      log.error("Avatar fetch failed", { error: String(e) });
    }
    try {
      await fetchMissingGroupAvatars();
    } catch (e) {
      log.error("Group avatar fetch failed", { error: String(e) });
    }
    try {
      await gcOrphanAvatars();
    } catch (e) {
      log.error("Avatar GC failed", { error: String(e) });
    }
  };
  safeAvatarFetch();
  const avatarInterval = setInterval(safeAvatarFetch, 60 * 1000);
  // Delete reconciliation: TG's UpdateDeleteMessages is unreliable for
  // basic groups. Every 5 minutes we cross-check recent DB messages with
  // what Telegram says is live and mark missing ones as deleted.
  const safeReconcile = async () => {
    try { await reconcileDeletions(); } catch (e) { log.error("Delete reconcile failed", { error: String(e) }); }
  };
  const reconcileInterval = setInterval(safeReconcile, 5 * 60 * 1000);

  // 2026-05-21 pg-boss background jobs(optional)— 並行於既有 setInterval。
  // 載入失敗 / 套件沒裝 / PGBOSS_DISABLED → 靜默 skip,既有 setInterval 不受影響。
  // 第一個示範 job:cleanup-pending-auth-sessions(hourly)。
  void (async () => {
    const { initJobs } = await import("../src/lib/jobs/index.js").catch(() => ({
      initJobs: null as null | (() => Promise<unknown>),
    }));
    if (initJobs) {
      try {
        await initJobs();
      } catch (err) {
        log.warn("pg-boss init from bridge failed (non-fatal)", {
          err: String(err).slice(0, 200),
        });
      }
    }
  })();

  // Start HTTP server
  const server = startHttpServer();

  // Start connection health monitoring
  clientManager.startHealthCheck();

  log.info("Bridge worker is running");

  // Graceful shutdown — 順序刻意安排為:
  //   1. 停 server / 排程 / health check —— 不再接新工作
  //   2. **斷 GramJS** —— 讓 Telegram server-side 的 auth_key 標記 idle
  //   3. **等 ~1.5 秒** —— 給 Telegram 收到 disconnect 並更新 server-side 狀態
  //   4. **釋放 advisory lock** —— 這時新 bridge 才會被允許開始連 TG;若把
  //      順序顛倒(先放鎖再斷 TG),新 bridge 會立刻 reconnect 撞舊
  //      auth_key,AUTH_KEY_DUPLICATED 又重來一次。
  //   5. 等訊息隊列清空(允許短超時),disconnect prisma,exit
  let isShuttingDown = false;
  const shutdown = async () => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    log.info("Shutting down bridge worker...");

    clearInterval(lockCleanupInterval);
    clearInterval(discoveryInterval);
    clearInterval(retentionInterval);
    clearInterval(avatarInterval);
    clearInterval(reconcileInterval);

    // Stop accepting new connections
    server.close();

    // 整體不超過 30s 的硬截止 — Railway 的 SIGKILL 也差不多這個量級。
    const drainTimeout = setTimeout(() => {
      log.error("Shutdown timeout exceeded (30s), forcing exit");
      process.exit(1);
    }, 30000);

    try {
      // (0) 收 background jobs(pg-boss)— 跑到一半的 job 等 graceful timeout 結束
      try {
        const { shutdownJobs } = await import("../src/lib/jobs/index.js").catch(
          () => ({ shutdownJobs: null as null | (() => Promise<void>) }),
        );
        if (shutdownJobs) await shutdownJobs();
      } catch (err) {
        log.warn("pg-boss shutdown error (non-fatal)", {
          err: String(err).slice(0, 200),
        });
      }

      // (1) 停 health check + 斷 GramJS,釋放 auth_keys
      clientManager.stopHealthCheck();
      await clientManager.stopAll();

      // (2) 等 Telegram server-side 接收到 disconnect。經驗值 ~1s 夠用,
      //     抓 1.5s 留 headroom。
      await new Promise((r) => setTimeout(r, 1500));

      // (3) 釋放 advisory lock — 新 bridge 在這之後才會解除 hang 並
      //     開始連 Telegram。
      await bridgeLock.release();

      // (4) Per-pairing message queue removed with H3; nothing to drain
      //     on shutdown.

      // (5) Prisma 收尾
      await prisma.$disconnect();
    } catch (error) {
      log.error("Error during shutdown", { error: String(error) });
    }

    clearTimeout(drainTimeout);
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

process.on("unhandledRejection", (reason) => {
  log.error("Unhandled rejection", { reason: reason instanceof Error ? reason.stack : String(reason) });
  process.exit(1);
});
process.on("uncaughtException", (error) => {
  log.error("Uncaught exception", { error: error.stack || String(error) });
  process.exit(1);
});

main().catch((error) => {
  log.error("Fatal error", { error: String(error) });
  process.exit(1);
});
