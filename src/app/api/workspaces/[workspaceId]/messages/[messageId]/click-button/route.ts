import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireWorkspacePermission } from "@/lib/auth/middleware";
import { resolveVisibleAccountIds } from "@/lib/account-visibility";
import { logAudit } from "@/lib/audit/logger";
import { logger } from "@/lib/logger";

const log = logger("ClickButton");

type RouteParams = {
  params: Promise<{ workspaceId: string; messageId: string }>;
};

const BRIDGE_URL = process.env.BRIDGE_URL || `http://localhost:${process.env.BRIDGE_PORT || 3001}`;
const INTERNAL_SECRET = process.env.INTERNAL_SECRET;

/**
 * 2026-05-21 訊息按鈕:點 inline keyboard 的 callback 按鈕。
 *
 * POST /api/workspaces/[ws]/messages/[id]/click-button
 *   body: { data: string }  — base64 編碼的 callback bytes(從 DCM.replyMarkup 的
 *                              按鈕物件 .data 拿)
 *   ↳ { ok, message?, alert?, url?, error? } — bot 的 callback answer
 *
 * url 按鈕不會打這支 — 前端直接開連結。只有 callback 按鈕需要往 TG 送。
 *
 * 權限:呼叫者要能看到此 DCM 所屬帳號(account-visibility),
 * 且需要 canSendManualMessages(點按鈕 = 代表此帳號跟 bot 互動,是「操作」不是「看」)。
 */
export async function POST(req: Request, { params }: RouteParams) {
  const { workspaceId, messageId } = await params;
  const auth = await requireWorkspacePermission(workspaceId, "canSendManualMessages");
  if (auth instanceof NextResponse) return auth;

  let body: { data?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "無效的請求內容" }, { status: 400 });
  }
  const data = typeof body.data === "string" ? body.data : "";
  if (!data) {
    return NextResponse.json({ error: "data 為必填" }, { status: 400 });
  }

  const dcm = await prisma.directChatMessage.findFirst({
    where: { id: messageId, workspaceId },
    select: {
      id: true,
      accountId: true,
      platformMessageId: true,
      group: { select: { platformGroupId: true } },
    },
  });
  if (!dcm) {
    return NextResponse.json({ error: "找不到訊息" }, { status: 404 });
  }

  // 可見性 — 員工只能操作自己看得到的帳號。
  const visible = await resolveVisibleAccountIds({
    userId: auth.userId,
    workspaceId,
    isSystemAdmin: auth.isSystemAdmin,
    permissions: auth.permissions,
  });
  if (!visible.has(dcm.accountId)) {
    return NextResponse.json({ error: "無權操作此訊息" }, { status: 403 });
  }

  if (!dcm.platformMessageId || !dcm.group.platformGroupId) {
    return NextResponse.json(
      { error: "此訊息尚未與 Telegram 同步,無法點按鈕" },
      { status: 422 },
    );
  }
  if (!INTERNAL_SECRET) {
    return NextResponse.json({ error: "bridge 未設定 INTERNAL_SECRET" }, { status: 500 });
  }

  try {
    const bridgeRes = await fetch(`${BRIDGE_URL}/click-button`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${INTERNAL_SECRET}`,
      },
      body: JSON.stringify({
        accountId: dcm.accountId,
        chatId: dcm.group.platformGroupId,
        platformMessageId: dcm.platformMessageId,
        data,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!bridgeRes.ok) {
      const errBody = await bridgeRes.text().catch(() => "");
      log.warn("bridge /click-button failed", {
        messageId: dcm.id,
        status: bridgeRes.status,
        body: errBody.slice(0, 200),
      });
      return NextResponse.json(
        { error: "按鈕操作失敗" },
        { status: 502 },
      );
    }
    const result = (await bridgeRes.json()) as {
      ok?: boolean;
      message?: string;
      alert?: boolean;
      url?: string;
      error?: string;
    };
    if (!result.ok) {
      return NextResponse.json(
        { error: result.error || "按鈕操作失敗" },
        { status: 502 },
      );
    }

    await logAudit({
      workspaceId,
      userId: auth.userId,
      action: "message.click_button",
      entityType: "DirectMessage",
      entityId: dcm.id,
      details: { accountId: dcm.accountId },
    });

    return NextResponse.json({
      ok: true,
      message: result.message ?? null,
      alert: result.alert ?? false,
      url: result.url ?? null,
    });
  } catch (err) {
    log.warn("click-button bridge call failed", {
      messageId: dcm.id,
      error: String(err).slice(0, 200),
    });
    return NextResponse.json({ error: "bridge 連線失敗" }, { status: 502 });
  }
}
