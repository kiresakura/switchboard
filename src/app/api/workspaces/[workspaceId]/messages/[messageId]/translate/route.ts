import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireWorkspaceMember } from "@/lib/auth/middleware";
import { resolveVisibleAccountIds } from "@/lib/account-visibility";
import { logger } from "@/lib/logger";

const log = logger("Translate");

type RouteParams = {
  params: Promise<{ workspaceId: string; messageId: string }>;
};

const BRIDGE_URL = process.env.BRIDGE_URL || `http://localhost:${process.env.BRIDGE_PORT || 3001}`;
const INTERNAL_SECRET = process.env.INTERNAL_SECRET;

/**
 * 2026-05-21 TG parity:Native TG translation (`messages.TranslateText`) + cache。
 *
 * GET /api/workspaces/[ws]/messages/[messageId]/translate?lang=en
 *   ↳ 對指定 DCM 翻譯到 `lang` 並 cache 到 ConversationMessageTranslation。
 *     同 (messageId, lang) cache hit 直接回;cache miss 走 bridge `/translate`。
 *
 *   為什麼 GET 不是 POST:翻譯結果是函數的(同 lang 同訊息只有一個 translation),
 *   GET + cache header 邏輯一致。lang param 必填(zh-TW / zh-CN / en / ja 等)。
 *
 * 權限:呼叫者必須能看到此 DCM 所屬帳號(account-visibility)— 不然會 IDOR
 *       翻譯不歸他管的對話。
 */
export async function GET(req: Request, { params }: RouteParams) {
  const { workspaceId, messageId } = await params;
  const auth = await requireWorkspaceMember(workspaceId);
  if (auth instanceof NextResponse) return auth;

  const url = new URL(req.url);
  const toLang = url.searchParams.get("lang");
  if (!toLang || !/^[a-z]{2}(-[A-Z]{2,4})?$/i.test(toLang)) {
    return NextResponse.json(
      { error: "lang 為必填,合法格式 e.g. en / zh-TW / ja" },
      { status: 400 },
    );
  }

  // 找 DCM + 取必要欄位
  const dcm = await prisma.directChatMessage.findFirst({
    where: { id: messageId, workspaceId },
    select: {
      id: true,
      accountId: true,
      content: true,
      platformMessageId: true,
      group: { select: { platformGroupId: true } },
    },
  });
  if (!dcm) {
    return NextResponse.json({ error: "找不到訊息" }, { status: 404 });
  }

  // 可見性檢查 — 員工只能翻譯自己看得到的帳號的訊息。
  const visible = await resolveVisibleAccountIds({
    userId: auth.userId,
    workspaceId,
    isSystemAdmin: auth.isSystemAdmin,
    permissions: auth.permissions,
  });
  if (!visible.has(dcm.accountId)) {
    return NextResponse.json({ error: "無權翻譯此訊息" }, { status: 403 });
  }

  // 內容空 = 純媒體訊息 → 沒東西可翻
  if (!dcm.content || dcm.content.trim().length === 0) {
    return NextResponse.json(
      { error: "訊息內容為空,無法翻譯" },
      { status: 400 },
    );
  }

  // Cache hit?
  const cached = await prisma.conversationMessageTranslation.findUnique({
    where: { messageId_targetLang: { messageId: dcm.id, targetLang: toLang } },
    select: { translatedText: true, provider: true, createdAt: true },
  });
  if (cached) {
    return NextResponse.json({
      translatedText: cached.translatedText,
      provider: cached.provider,
      cached: true,
      cachedAt: cached.createdAt.toISOString(),
    });
  }

  // Cache miss — 呼叫 bridge(只能對 platformMessageId 有值的 DCM)。
  if (!dcm.platformMessageId || !dcm.group.platformGroupId) {
    return NextResponse.json(
      { error: "此訊息尚未與 Telegram 同步,無法使用 TG native 翻譯" },
      { status: 422 },
    );
  }
  if (!INTERNAL_SECRET) {
    return NextResponse.json({ error: "bridge 未設定 INTERNAL_SECRET" }, { status: 500 });
  }

  let translatedText: string | null = null;
  let provider = "tg-native";
  try {
    const bridgeRes = await fetch(`${BRIDGE_URL}/translate`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${INTERNAL_SECRET}`,
      },
      body: JSON.stringify({
        accountId: dcm.accountId,
        chatId: dcm.group.platformGroupId,
        platformMessageId: dcm.platformMessageId,
        toLang,
      }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!bridgeRes.ok) {
      const errBody = await bridgeRes.text().catch(() => "");
      log.warn("bridge /translate failed", {
        messageId: dcm.id,
        status: bridgeRes.status,
        body: errBody.slice(0, 200),
      });
      return NextResponse.json(
        { error: "翻譯服務暫時無法使用" },
        { status: 502 },
      );
    }
    const result = (await bridgeRes.json()) as {
      text?: string | null;
      error?: string;
    };
    if (result.error || !result.text) {
      return NextResponse.json(
        { error: result.error || "翻譯結果為空" },
        { status: 502 },
      );
    }
    translatedText = result.text;
  } catch (err) {
    log.warn("translate bridge call failed", {
      messageId: dcm.id,
      error: String(err).slice(0, 200),
    });
    return NextResponse.json(
      { error: "翻譯服務無法連線" },
      { status: 502 },
    );
  }

  // Cache 寫入 — best-effort,寫失敗也回 caller 翻譯結果。
  try {
    await prisma.conversationMessageTranslation.create({
      data: {
        messageId: dcm.id,
        targetLang: toLang,
        translatedText,
        provider,
      },
    });
  } catch (err) {
    log.warn("translation cache write failed (non-fatal)", {
      messageId: dcm.id,
      error: String(err).slice(0, 200),
    });
  }

  return NextResponse.json({
    translatedText,
    provider,
    cached: false,
  });
}
