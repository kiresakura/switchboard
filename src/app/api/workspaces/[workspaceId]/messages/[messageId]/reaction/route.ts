import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireWorkspacePermission } from "@/lib/auth/middleware";
import { logger } from "@/lib/logger";
import { resolveVisibleAccountIds } from "@/lib/account-visibility";

const log = logger("MessageReaction");

// 2026-05-21:移除這支 route 自己的 translateReactionError。
// bridge → clientManager.translateReactionError 已經把 raw TG error code 翻成
// 友善中文了;這層若再 errorMap[...] 查一次,因為收到的已是中文(不是 code)→
// 永遠 miss → fallback「Telegram 錯誤:<已翻好的中文>」造成雙重包裝
// (使用者看到「Telegram 錯誤:TG 端錯誤:MESSAGE_NOT_MODIFIED」)。
// 正解:bridge 給什麼就直接顯示什麼。

const BRIDGE_URL =
  process.env.BRIDGE_URL || `http://localhost:${process.env.BRIDGE_PORT || 3001}`;
const INTERNAL_SECRET = process.env.INTERNAL_SECRET;

type RouteParams = {
  params: Promise<{ workspaceId: string; messageId: string }>;
};

/**
 * POST /api/workspaces/:wsId/messages/:messageId/reaction
 *
 * 對 DirectChatMessage 上 emoji reaction（透過 bridge → TG 真正送過去）。
 * 目前只支援 DirectChatMessage（直面對話 / 內部群對話用）；走配對 pipeline 的
 * Message 表暫時不支援，因為 reaction 對「審核 / 轉發」流程沒明確語義。
 *
 * Body: { emoji: string | null }
 *   emoji = "👍" / "❤️" / ... → 設定 reaction
 *   emoji = null              → 清掉這個帳號對該訊息的 reaction
 *
 * Auth: 任何能發直面訊息的客服都可以加 reaction（同 canSendManualMessages）
 */
export async function POST(req: Request, { params }: RouteParams) {
  const { workspaceId, messageId } = await params;
  const auth = await requireWorkspacePermission(
    workspaceId,
    "canSendManualMessages",
  );
  if (auth instanceof NextResponse) return auth;

  let body: { emoji?: string | null };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "無效的請求內容" }, { status: 400 });
  }

  const emoji =
    typeof body.emoji === "string" && body.emoji.trim().length > 0
      ? body.emoji.trim()
      : null;

  // 找這筆 DirectChatMessage 對應的 TG message id + 帳號 + 群組
  const message = await prisma.directChatMessage.findFirst({
    where: { id: messageId, workspaceId },
    select: {
      id: true,
      platformMessageId: true,
      accountId: true,
      group: { select: { platformGroupId: true, isActive: true } },
    },
  });

  if (!message) {
    return NextResponse.json({ error: "找不到訊息" }, { status: 404 });
  }

  // 可見性:員工只能對自己被指派 / 代理帳號的訊息加反應(2026-05-21 review 補)。
  const visible = await resolveVisibleAccountIds({
    userId: auth.userId,
    workspaceId,
    isSystemAdmin: auth.isSystemAdmin,
    permissions: auth.permissions,
  });
  if (!visible.has(message.accountId)) {
    return NextResponse.json({ error: "無權對此訊息加反應" }, { status: 403 });
  }

  // 如果沒有 platformMessageId，只允許本地 reaction（不發送到 Telegram）
  // 這通常是部署前發送的舊訊息
  const isLocalOnly = !message.platformMessageId;

  if (isLocalOnly) {
    // 本地 only reaction - 只返回成功，讓前端做本地更新
    // 不保存到資料庫，因為沒有 platformMessageId 的訊息無法與 Telegram 同步
    return NextResponse.json({
      success: true,
      emoji,
      localOnly: true,
      warning: "此訊息無法同步到 Telegram（僅本地顯示）",
    });
  }

  if (!message.group?.platformGroupId) {
    return NextResponse.json({ error: "找不到對話的 TG ID" }, { status: 400 });
  }

  // platformMessageId 在這裡保證不是 null（因為 isLocalOnly 檢查）
  const platformMessageId = message.platformMessageId!;

  if (!INTERNAL_SECRET) {
    return NextResponse.json(
      { error: "bridge 未設定 INTERNAL_SECRET" },
      { status: 500 },
    );
  }

  // 透過 bridge 把 reaction 送到 TG
  try {
    const bridgeRes = await fetch(`${BRIDGE_URL}/send-reaction`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${INTERNAL_SECRET || ""}`,
      },
      body: JSON.stringify({
        accountId: message.accountId,
        chatId: message.group.platformGroupId,
        messageId: parseInt(platformMessageId, 10),
        emoji,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!bridgeRes.ok) {
      const errBody = await bridgeRes.text().catch(() => "");
      log.warn("bridge /send-reaction failed", {
        status: bridgeRes.status,
        body: errBody.slice(0, 200),
      });
      return NextResponse.json(
        { error: "Bridge 回應失敗" },
        { status: 502 },
      );
    }
    const result = (await bridgeRes.json()) as {
      success?: boolean;
      error?: string;
    };
    if (!result.success) {
      // bridge 回的 error 已是 clientManager.translateReactionError 翻好的友善中文,
      // 直接用 — 不再二次包裝。
      return NextResponse.json(
        { error: result.error || "Reaction 失敗" },
        { status: 502 },
      );
    }
    return NextResponse.json({ success: true, emoji });
  } catch (err) {
    log.error("reaction request to bridge failed", { error: String(err) });
    return NextResponse.json(
      { error: "Bridge 不可達 — 稍後再試" },
      { status: 503 },
    );
  }
}
