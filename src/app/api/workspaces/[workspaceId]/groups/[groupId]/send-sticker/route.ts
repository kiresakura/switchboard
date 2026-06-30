import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireWorkspacePermission } from "@/lib/auth/middleware";
import { resolveVisibleAccountIds } from "@/lib/account-visibility";
import { logger } from "@/lib/logger";

const log = logger("SendSticker");

const BRIDGE_URL = process.env.BRIDGE_URL || `http://localhost:${process.env.BRIDGE_PORT || 3001}`;
const INTERNAL_SECRET = process.env.INTERNAL_SECRET;

type RouteParams = {
  params: Promise<{ workspaceId: string; groupId: string }>;
};

/**
 * POST /api/workspaces/:wid/groups/:gid/send-sticker
 *
 * Send a sticker document to the Telegram chat associated with this group.
 *
 * Body: { accountId, docId, accessHash, fileReference }
 *   accountId    — TG communication account to send from
 *   docId        — TG document id (from sticker-sets API)
 *   accessHash   — TG access_hash for the document
 *   fileReference — base64-encoded file_reference
 *
 * Returns: { success, sentMessageId? }
 *
 * Auth: canSendManualMessages + account must be visible to the caller.
 */
export async function POST(req: Request, { params }: RouteParams) {
  const { workspaceId, groupId } = await params;
  const auth = await requireWorkspacePermission(workspaceId, "canSendManualMessages");
  if (auth instanceof NextResponse) return auth;

  let body: { accountId?: string; docId?: string; accessHash?: string; fileReference?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "無效的請求內容" }, { status: 400 });
  }

  const { accountId, docId, accessHash, fileReference } = body;
  if (!accountId || !docId || !accessHash || !fileReference) {
    return NextResponse.json(
      { error: "accountId, docId, accessHash, fileReference 為必填" },
      { status: 400 },
    );
  }

  // Account visibility: employee may only use accounts they are assigned to / delegated.
  const visible = await resolveVisibleAccountIds({
    userId: auth.userId,
    workspaceId,
    isSystemAdmin: auth.isSystemAdmin,
    permissions: auth.permissions,
  });
  if (!visible.has(accountId)) {
    return NextResponse.json({ error: "無權使用此帳號" }, { status: 403 });
  }

  // Resolve the group and get its Telegram platformGroupId.
  const group = await prisma.group.findFirst({
    where: {
      id: groupId,
      workspaceId,
      accountMemberships: {
        some: { accountId },
      },
    },
    select: { platformGroupId: true },
  });
  if (!group) {
    return NextResponse.json({ error: "找不到群組" }, { status: 404 });
  }
  if (!group.platformGroupId) {
    return NextResponse.json(
      { error: "此群組尚未與 Telegram 同步" },
      { status: 422 },
    );
  }

  if (!INTERNAL_SECRET) {
    return NextResponse.json({ error: "bridge 未設定 INTERNAL_SECRET" }, { status: 500 });
  }

  try {
    const bridgeRes = await fetch(`${BRIDGE_URL}/send-sticker`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${INTERNAL_SECRET}`,
      },
      body: JSON.stringify({
        accountId,
        chatId: group.platformGroupId,
        docId,
        accessHash,
        fileReference,
      }),
      signal: AbortSignal.timeout(20_000),
    });

    if (!bridgeRes.ok) {
      const errBody = await bridgeRes.text().catch(() => "");
      log.warn("bridge /send-sticker failed", {
        groupId,
        accountId,
        status: bridgeRes.status,
        body: errBody.slice(0, 200),
      });
      return NextResponse.json({ error: "貼圖傳送失敗" }, { status: 502 });
    }

    const result = (await bridgeRes.json()) as {
      success: boolean;
      sentMessageId?: string;
      error?: string;
    };

    if (!result.success) {
      return NextResponse.json(
        { error: result.error ?? "貼圖傳送失敗" },
        { status: 502 },
      );
    }

    return NextResponse.json({
      success: true,
      sentMessageId: result.sentMessageId ?? null,
    });
  } catch (err) {
    log.warn("send-sticker bridge call failed", {
      groupId,
      accountId,
      error: String(err).slice(0, 200),
    });
    return NextResponse.json({ error: "bridge 連線失敗" }, { status: 502 });
  }
}
