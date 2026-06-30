import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireWorkspacePermission } from "@/lib/auth/middleware";
import { logAudit } from "@/lib/audit/logger";
import { logger } from "@/lib/logger";

const log = logger("Forward");

type RouteParams = { params: Promise<{ workspaceId: string }> };

const BRIDGE_URL = process.env.BRIDGE_URL || `http://localhost:${process.env.BRIDGE_PORT || 3001}`;
const INTERNAL_SECRET = process.env.INTERNAL_SECRET;

/**
 * P1 2026-05-20:轉發訊息到另一個對話。
 *
 * body: { fromGroupId, messageIds[], toGroupId }
 *
 * 流程:
 *   1) 驗證 fromGroup / toGroup 都在 workspace 內
 *   2) 撈出 messageIds 對應的 DCM,取 platformMessageId 跟「源頭 account」
 *   3) 該 account 必須同時在 toGroup 也有 membership(同一 GramJS client 才能
 *      forward — TG `messages.ForwardMessages` 要求 fromPeer 跟 toPeer 都能
 *      用同一個 session 解析)
 *   4) 呼叫 bridge /forward-messages
 *   5) 為每個轉發成功的訊息建立 DCM(direction=OUTBOUND, sentViaTelegram=true,
 *      content/mediaUrl 從原訊息複製),這樣轉發後 Switchboard UI 看得到歷史
 *
 * 失敗模式:
 *   - 找不到帳號同時在兩邊 → 409 「目前帳號池中沒有同時加入這兩個對話的帳號」
 *   - 部分訊息找不到 / 沒 platformMessageId → 過濾掉、log warning
 *   - bridge 失敗 → 透傳 error 給前端
 */
export async function POST(req: Request, { params }: RouteParams) {
  const { workspaceId } = await params;
  const auth = await requireWorkspacePermission(workspaceId, "canSendManualMessages");
  if (auth instanceof NextResponse) return auth;

  let body: {
    fromGroupId?: string;
    messageIds?: string[];
    toGroupId?: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "無效的請求內容" }, { status: 400 });
  }
  const { fromGroupId, messageIds, toGroupId } = body;

  if (!fromGroupId || !toGroupId || !Array.isArray(messageIds) || messageIds.length === 0) {
    return NextResponse.json(
      { error: "fromGroupId、toGroupId、messageIds 為必填" },
      { status: 400 }
    );
  }
  if (fromGroupId === toGroupId) {
    return NextResponse.json(
      { error: "來源跟目標不能是同一個對話" },
      { status: 400 }
    );
  }

  // 1) Group ownership 驗證
  const [fromGroup, toGroup] = await Promise.all([
    prisma.group.findFirst({
      where: { id: fromGroupId, workspaceId },
      select: {
        id: true,
        title: true,
        platformGroupId: true,
        accountMemberships: { select: { accountId: true } },
      },
    }),
    prisma.group.findFirst({
      where: { id: toGroupId, workspaceId },
      select: {
        id: true,
        title: true,
        platformGroupId: true,
        accountMemberships: { select: { accountId: true } },
      },
    }),
  ]);
  if (!fromGroup || !toGroup) {
    return NextResponse.json({ error: "找不到對話" }, { status: 404 });
  }

  // 2) 撈 DCM,過濾掉沒 platformMessageId 的(沒同步到 TG 的本地草稿不能轉)
  const dcms = await prisma.directChatMessage.findMany({
    where: {
      id: { in: messageIds },
      workspaceId,
      groupId: fromGroupId,
      platformMessageId: { not: null },
      isDeleted: false,
    },
    select: {
      id: true,
      accountId: true,
      platformMessageId: true,
      content: true,
      messageType: true,
      mediaUrl: true,
      mediaType: true,
      mediaFileName: true,
      mediaMetadata: true,
    },
  });
  if (dcms.length === 0) {
    return NextResponse.json(
      { error: "找不到可轉發的訊息(可能尚未同步到 Telegram 或已刪除)" },
      { status: 400 }
    );
  }

  // 3) 同時在 from / to 都有 membership 的 account。優先用「原訊息來源 account」
  //    若其在 toGroup 也有 membership;否則 fall back 到任何符合條件的 account。
  const toAccountIds = new Set(toGroup.accountMemberships.map((m) => m.accountId));
  const fromAccountIds = new Set(fromGroup.accountMemberships.map((m) => m.accountId));
  const sharedAccountIds = Array.from(fromAccountIds).filter((id) => toAccountIds.has(id));
  if (sharedAccountIds.length === 0) {
    return NextResponse.json(
      {
        error:
          "目前帳號池中沒有同時加入這兩個對話的帳號 — 請先讓有此權限的 Telegram 帳號加入目標對話",
      },
      { status: 409 }
    );
  }

  // 用第一筆 DCM 的 accountId 為首選;否則取 sharedAccountIds[0]
  const preferredAccountId = dcms[0]?.accountId;
  const forwardAccountId =
    preferredAccountId && sharedAccountIds.includes(preferredAccountId)
      ? preferredAccountId
      : sharedAccountIds[0];

  // 4) Bridge call
  const platformMessageIds = dcms
    .map((d) => d.platformMessageId)
    .filter((v): v is string => v != null);

  let bridgeResult: { success?: boolean; sentMessageIds?: string[]; error?: string };
  try {
    const bridgeRes = await fetch(`${BRIDGE_URL}/forward-messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${INTERNAL_SECRET || ""}`,
      },
      body: JSON.stringify({
        accountId: forwardAccountId,
        fromChatId: fromGroup.platformGroupId,
        messageIds: platformMessageIds,
        toChatId: toGroup.platformGroupId,
      }),
      signal: AbortSignal.timeout(30_000),
    });
    bridgeResult = await bridgeRes.json();
    if (!bridgeRes.ok || !bridgeResult.success) {
      log.warn("bridge /forward-messages failed", {
        status: bridgeRes.status,
        error: bridgeResult.error,
      });
      return NextResponse.json(
        { error: bridgeResult.error || "Telegram 轉發失敗" },
        { status: 502 }
      );
    }
  } catch (err) {
    log.error("bridge /forward-messages threw", { error: String(err) });
    return NextResponse.json(
      { error: "無法連線到訊息服務" },
      { status: 502 }
    );
  }

  // 5) 為轉發成功的訊息建立 DCM 紀錄。bridge 回的 sentMessageIds 對應到
  //    target chat 上新訊息的 TG id;順序跟我們送的 platformMessageIds 一致。
  const sentIds = bridgeResult.sentMessageIds ?? [];
  const createCount = Math.min(sentIds.length, dcms.length);
  for (let i = 0; i < createCount; i++) {
    const sourceDcm = dcms[i];
    const newPlatformMessageId = sentIds[i];
    try {
      await prisma.directChatMessage.create({
        data: {
          workspaceId,
          accountId: forwardAccountId,
          groupId: toGroupId,
          senderId: auth.userId,
          senderPlatformId: null,
          senderDisplayName: null,
          direction: "OUTBOUND",
          content: sourceDcm.content,
          messageType: sourceDcm.messageType,
          mediaUrl: sourceDcm.mediaUrl,
          mediaType: sourceDcm.mediaType,
          mediaFileName: sourceDcm.mediaFileName,
          mediaMetadata: sourceDcm.mediaMetadata ?? undefined,
          sentViaTelegram: true,
          platformMessageId: newPlatformMessageId,
        },
      });
    } catch (err) {
      // 寫 DCM 失敗不致命 — TG 那邊已經送出,UI 之後重 fetch 會抓到
      log.warn("forward archive DCM failed (non-fatal)", {
        sourceDcmId: sourceDcm.id,
        error: String(err).slice(0, 200),
      });
    }
  }

  await logAudit({
    workspaceId,
    userId: auth.userId,
    action: "message.forward",
    entityType: "DirectChatMessage",
    entityId: dcms[0]?.id ?? "",
    details: {
      fromGroupId,
      fromGroupTitle: fromGroup.title,
      toGroupId,
      toGroupTitle: toGroup.title,
      count: createCount,
      accountId: forwardAccountId,
    },
  });

  return NextResponse.json({
    success: true,
    forwardedCount: createCount,
  });
}
