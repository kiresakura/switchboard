import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireWorkspacePermission } from "@/lib/auth/middleware";
import { logAudit } from "@/lib/audit/logger";
import { eventBus } from "@/lib/realtime/event-bus";
import { logger } from "@/lib/logger";

const log = logger("DirectChatMessage");

type RouteParams = {
  params: Promise<{ workspaceId: string; messageId: string }>;
};

const BRIDGE_URL =
  process.env.BRIDGE_URL || `http://localhost:${process.env.BRIDGE_PORT || 3001}`;
const INTERNAL_SECRET = process.env.INTERNAL_SECRET;

const CONTENT_MAX = 8192;

/**
 * 編輯 / 刪除「Telegram 帳號」自己發出去的訊息。
 *
 * 為什麼需要：CS 同事可能用手機 TG App 直接傳了一句話到客戶群（或者透過
 * Switchboard UI 發送），事後想修改錯字 / 撤回。bridge 早就有 /edit-message 跟
 * /delete-messages，但 UI 一直沒包它們，於是「說錯話沒救」。這支端點把 UI
 * 的編輯 / 刪除動作 → bridge → TG 串起來，並同步維護 DirectChatMessage
 * 跟發 SSE 給其他在看同一條對話的同事。
 *
 * 限制：
 *   - 只能編輯 / 刪除 OUTBOUND（我方發出去的）訊息
 *   - 必須有 platformMessageId（沒成功送到 TG 的不能編輯）
 *   - 編輯只支援 TEXT 類型（TG 的 editMessage API 限制）
 *   - TG 端 48 小時內可編輯，超過會回錯誤（我們透傳）
 */

// PATCH /api/workspaces/:wsId/direct-chat/messages/:messageId
// Body: { content: string }
export async function PATCH(req: Request, { params }: RouteParams) {
  const { workspaceId, messageId } = await params;
  const auth = await requireWorkspacePermission(workspaceId, "canSendManualMessages");
  if (auth instanceof NextResponse) return auth;

  let body: { content?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "無效的請求內容" }, { status: 400 });
  }

  const newContent = body.content?.trim();
  if (!newContent) {
    return NextResponse.json({ error: "內容不可為空" }, { status: 400 });
  }
  if (newContent.length > CONTENT_MAX) {
    return NextResponse.json(
      { error: `內容過長（上限 ${CONTENT_MAX} 字）` },
      { status: 400 },
    );
  }

  // 注意：用 explicit select（而不是 include）— 因為 0009 的 reactions 欄位
  // 在 Railway 線上 DB 還沒套，include 會做 SELECT *（含 reactions）→ 直接 500。
  // 同樣的降級在 chat read API 已經做過。
  const msg = await prisma.directChatMessage.findFirst({
    where: { id: messageId, workspaceId },
    select: {
      id: true,
      direction: true,
      messageType: true,
      content: true,
      accountId: true,
      groupId: true,
      platformMessageId: true,
      group: { select: { platformGroupId: true } },
    },
  });
  if (!msg) {
    return NextResponse.json({ error: "找不到訊息" }, { status: 404 });
  }
  if (msg.direction !== "OUTBOUND") {
    return NextResponse.json(
      { error: "只能編輯客服自己發出的訊息" },
      { status: 403 },
    );
  }
  if (!msg.platformMessageId || !msg.group?.platformGroupId) {
    return NextResponse.json(
      { error: "此訊息尚未成功送出至 Telegram，無法編輯" },
      { status: 400 },
    );
  }
  if (msg.messageType !== "TEXT") {
    return NextResponse.json(
      { error: "Telegram 不支援編輯非文字訊息（只能刪除後重發）" },
      { status: 400 },
    );
  }
  if (msg.content === newContent) {
    return NextResponse.json({ message: msg, unchanged: true });
  }

  // 呼叫 bridge 把編輯送到 TG
  try {
    const bridgeRes = await fetch(`${BRIDGE_URL}/edit-message`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${INTERNAL_SECRET || ""}`,
      },
      body: JSON.stringify({
        accountId: msg.accountId,
        chatId: msg.group.platformGroupId,
        messageId: msg.platformMessageId,
        newText: newContent,
      }),
      // TG editMessage 一般 1-3s；給多一點 buffer 處理重連抖動
      signal: AbortSignal.timeout(15_000),
    });
    if (!bridgeRes.ok) {
      const errText = await bridgeRes.text().catch(() => "");
      log.warn("bridge edit-message failed", { status: bridgeRes.status, errText });
      return NextResponse.json(
        { error: errText || "Telegram 端編輯失敗（可能超過 48 小時編輯時限）" },
        { status: 502 },
      );
    }
    const bridgeData = await bridgeRes.json();
    if (bridgeData?.success === false) {
      return NextResponse.json(
        { error: bridgeData.error || "編輯失敗" },
        { status: 502 },
      );
    }
  } catch (err) {
    log.error("bridge unreachable for edit", { error: String(err) });
    return NextResponse.json(
      { error: "無法連接 Bridge 服務，請稍後再試" },
      { status: 502 },
    );
  }

  // 更新 DB row — 用 updateMany 而不是 update，避開 RETURNING * 帶到 reactions
  // 欄位（schema lag 期間會炸）。我們不需要回傳整列給前端，只需要新內容。
  // editedAt 是 0010 才加的欄位，用 raw SQL 補上以容忍 schema lag。
  const editedAt = new Date();

  // 先寫入編輯歷史（保留 PRE-update 的內容）— 0011 才有的表，schema lag
  // 期間 fail-soft；歷史掉了不該擋住主編輯。
  try {
    await prisma.$executeRaw`
      INSERT INTO "DirectChatMessageEditHistory"
        ("id", "dcmId", "previousContent", "editedAt")
      VALUES (${`dcmh_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`},
              ${messageId},
              ${msg.content},
              ${editedAt})
    `;
  } catch (histErr) {
    log.warn("DCM edit history insert failed (0011 not applied yet?)", {
      messageId,
      error: String(histErr).slice(0, 200),
    });
  }

  await prisma.directChatMessage.updateMany({
    where: { id: messageId, workspaceId },
    data: { content: newContent },
  });
  try {
    await prisma.$executeRaw`
      UPDATE "DirectChatMessage"
         SET "editedAt" = ${editedAt}
       WHERE "id" = ${messageId}
    `;
  } catch (rawErr) {
    log.warn("editedAt set failed (schema lag, 0010 not applied yet?)", {
      messageId,
      error: String(rawErr).slice(0, 200),
    });
  }
  const updated = { id: messageId, content: newContent, editedAt: editedAt.toISOString() };

  // 發 SSE 通知其他正在看的人
  eventBus.publish({
    type: "message:edited",
    workspaceId,
    data: {
      groupId: msg.groupId,
      messageId: msg.id,
      platformMessageId: msg.platformMessageId,
      content: newContent,
      source: "direct",
      editedAt: editedAt.toISOString(),
    },
  });

  await logAudit({
    workspaceId,
    userId: auth.userId,
    action: "direct_chat.message_edit",
    entityType: "DirectChatMessage",
    entityId: msg.id,
    details: {
      groupId: msg.groupId,
      oldContent: msg.content.slice(0, 200),
      newContent: newContent.slice(0, 200),
    },
  }).catch(() => {});

  return NextResponse.json({ message: updated });
}

// DELETE /api/workspaces/:wsId/direct-chat/messages/:messageId
export async function DELETE(_req: Request, { params }: RouteParams) {
  const { workspaceId, messageId } = await params;
  const auth = await requireWorkspacePermission(workspaceId, "canSendManualMessages");
  if (auth instanceof NextResponse) return auth;

  // 同 PATCH：explicit select 避開 reactions schema lag
  const msg = await prisma.directChatMessage.findFirst({
    where: { id: messageId, workspaceId },
    select: {
      id: true,
      direction: true,
      content: true,
      accountId: true,
      groupId: true,
      platformMessageId: true,
      group: { select: { platformGroupId: true } },
    },
  });
  if (!msg) {
    return NextResponse.json({ error: "找不到訊息" }, { status: 404 });
  }
  if (msg.direction !== "OUTBOUND") {
    return NextResponse.json(
      { error: "只能刪除客服自己發出的訊息" },
      { status: 403 },
    );
  }

  // 呼叫 bridge 把刪除送到 TG（如果這則訊息有送出去）
  if (msg.platformMessageId && msg.group?.platformGroupId) {
    try {
      const bridgeRes = await fetch(`${BRIDGE_URL}/delete-messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${INTERNAL_SECRET || ""}`,
        },
        body: JSON.stringify({
          accountId: msg.accountId,
          chatId: msg.group.platformGroupId,
          messageIds: [Number(msg.platformMessageId)],
        }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!bridgeRes.ok) {
        const errText = await bridgeRes.text().catch(() => "");
        log.warn("bridge delete-messages failed", {
          status: bridgeRes.status,
          errText,
        });
        // TG 端刪除失敗 → 仍繼續刪 DB row（操作者表達意圖了，不該卡住）
        // 但寫 audit 記下 TG 端失敗
        await logAudit({
          workspaceId,
          userId: auth.userId,
          action: "direct_chat.message_delete_tg_failed",
          entityType: "DirectChatMessage",
          entityId: msg.id,
          details: { reason: errText || `bridge_${bridgeRes.status}` },
        }).catch(() => {});
      }
    } catch (err) {
      log.warn("bridge unreachable for delete", { error: String(err) });
      // 同上，TG 端失敗不阻擋 Switchboard 端的刪除動作
    }
  }

  // 軟刪除：保留 row 給歷史記錄（spec 2026-04-30 — 刪了仍要看得到，淺色 +
  // 刪除線渲染）。raw SQL 因為 isDeleted/deletedAt 是 0010 才加的欄位，
  // schema lag 期間用 fail-soft；fallback 到原本的硬刪以免 UI 看到殘影。
  const deletedAt = new Date();
  let softDeleted = false;
  try {
    await prisma.$executeRaw`
      UPDATE "DirectChatMessage"
         SET "isDeleted" = true,
             "deletedAt" = ${deletedAt}
       WHERE "id" = ${messageId}
         AND "workspaceId" = ${workspaceId}
    `;
    softDeleted = true;
  } catch (rawErr) {
    log.warn("soft-delete column missing — falling back to hard delete", {
      messageId,
      error: String(rawErr).slice(0, 200),
    });
    await prisma.directChatMessage.deleteMany({
      where: { id: messageId, workspaceId },
    });
  }

  eventBus.publish({
    type: "message:deleted",
    workspaceId,
    data: {
      groupId: msg.groupId,
      messageId: msg.id,
      // soft=true 時前端應保留訊息只標 isDeleted；soft=false（schema lag 退回硬刪）
      // 前端把訊息從列表移除（跟 0010 套上前的舊行為一致）。
      soft: softDeleted,
      deletedAt: deletedAt.toISOString(),
      platformMessageId: msg.platformMessageId,
      source: "direct",
    },
  });

  await logAudit({
    workspaceId,
    userId: auth.userId,
    action: "direct_chat.message_delete",
    entityType: "DirectChatMessage",
    entityId: msg.id,
    details: {
      groupId: msg.groupId,
      content: msg.content.slice(0, 200),
    },
  }).catch(() => {});

  return NextResponse.json({ success: true });
}
