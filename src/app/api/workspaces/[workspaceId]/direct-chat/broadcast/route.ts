/**
 * POST /api/workspaces/:id/direct-chat/broadcast
 *
 * Send (or schedule) the same message to multiple groups in one call.
 * Iterates through groupIds sequentially — same bridge /send path as the
 * single-group send, just loops. Returns a per-group result array so the
 * client can show partial success.
 *
 * Body:
 *   groupIds    string[]   — target group DB ids (must belong to workspace)
 *   accountId   string     — sending TG account
 *   content     string     — message text
 *   scheduleDate? string   — ISO 8601 future time (TG scheduled message)
 */
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireWorkspacePermission } from "@/lib/auth/middleware";
import { resolveVisibleAccountIds } from "@/lib/account-visibility";
import { logger } from "@/lib/logger";

const log = logger("Broadcast");

type RouteParams = { params: Promise<{ workspaceId: string }> };

const BRIDGE_URL =
  process.env.BRIDGE_URL || `http://localhost:${process.env.BRIDGE_PORT || 3001}`;
const INTERNAL_SECRET = process.env.INTERNAL_SECRET;

export async function POST(req: Request, { params }: RouteParams) {
  const { workspaceId } = await params;
  const auth = await requireWorkspacePermission(workspaceId, "canSendManualMessages");
  if (auth instanceof NextResponse) return auth;

  let body: {
    groupIds?: string[];
    accountId?: string;
    content?: string;
    scheduleDate?: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "無效的請求內容" }, { status: 400 });
  }

  const { groupIds, accountId, content, scheduleDate } = body;

  if (!groupIds || !Array.isArray(groupIds) || groupIds.length === 0) {
    return NextResponse.json({ error: "groupIds 必填且不可為空陣列" }, { status: 400 });
  }
  if (groupIds.length > 200) {
    return NextResponse.json({ error: "群發上限 200 個對話" }, { status: 400 });
  }
  if (!accountId) {
    return NextResponse.json({ error: "accountId 必填" }, { status: 400 });
  }
  if (!content || typeof content !== "string" || !content.trim()) {
    return NextResponse.json({ error: "content 必填且不可為空" }, { status: 400 });
  }
  if (content.length > 4096) {
    return NextResponse.json({ error: "訊息不可超過 4096 字元" }, { status: 400 });
  }

  // Resolve scheduleDate → Unix sec.
  let scheduleDateUnix: number | null = null;
  if (scheduleDate) {
    const d = new Date(scheduleDate);
    if (Number.isNaN(d.getTime())) {
      return NextResponse.json({ error: "scheduleDate 不是合法 ISO 時間" }, { status: 400 });
    }
    const diffSec = (d.getTime() - Date.now()) / 1000;
    if (diffSec < 10) {
      return NextResponse.json({ error: "排程時間至少要 10 秒之後" }, { status: 400 });
    }
    scheduleDateUnix = Math.floor(d.getTime() / 1000);
  }

  // Verify account.
  const account = await prisma.communicationAccount.findFirst({
    where: { id: accountId, workspaceId, status: "ACTIVE" },
  });
  if (!account) {
    return NextResponse.json({ error: "找不到帳號或該帳號未啟用" }, { status: 404 });
  }

  // Visibility check.
  const visible = await resolveVisibleAccountIds({
    userId: auth.userId,
    workspaceId,
    isSystemAdmin: auth.isSystemAdmin,
    permissions: auth.permissions,
  });
  if (!visible.has(accountId)) {
    return NextResponse.json({ error: "無權使用此帳號發送訊息" }, { status: 403 });
  }

  // Load all target groups in one query, filter to workspace + active + account membership.
  const groups = await prisma.group.findMany({
    where: {
      id: { in: groupIds },
      workspaceId,
      isActive: true,
      accountMemberships: { some: { accountId } },
    },
    select: { id: true, title: true, platformGroupId: true },
  });

  const validGroupMap = new Map(groups.map((g) => [g.id, g]));

  type BroadcastResult = {
    groupId: string;
    groupTitle: string;
    success: boolean;
    sent: boolean;
    messageId?: string;
    error?: string;
  };

  const results: BroadcastResult[] = [];

  for (const gid of groupIds) {
    const group = validGroupMap.get(gid);
    if (!group) {
      results.push({
        groupId: gid,
        groupTitle: gid,
        success: false,
        sent: false,
        error: "群組不存在或無權限",
      });
      continue;
    }

    let sent = false;
    let platformMessageId: string | null = null;
    let bridgeError: string | undefined;

    try {
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
          skipArchive: true,
          scheduleDate: scheduleDateUnix,
        }),
        signal: AbortSignal.timeout(15_000),
      });
      if (bridgeRes.ok) {
        const result = await bridgeRes.json();
        sent = result.success;
        if (result.sentMessageId) platformMessageId = String(result.sentMessageId);
      } else {
        bridgeError = `Bridge HTTP ${bridgeRes.status}`;
      }
    } catch (e) {
      bridgeError = e instanceof Error ? e.message : "網路錯誤";
      log.warn("broadcast bridge error", { groupId: gid, error: bridgeError });
    }

    // Persist to DB regardless of bridge success (keeps audit trail).
    let messageId: string | undefined;
    try {
      const dcm = await prisma.directChatMessage.create({
        data: {
          workspaceId,
          accountId,
          groupId: gid,
          senderId: auth.userId,
          content,
          sentViaTelegram: sent,
          platformMessageId,
          deliveredAt: sent ? new Date() : null,
        },
      });
      messageId = dcm.id;

      await prisma.group.update({
        where: { id: gid },
        data: {
          lastOutboundAt: dcm.createdAt,
          conversationStatus: "OPEN",
          conversationClosedAt: null,
        },
      }).catch(() => null);
    } catch (e) {
      log.error("broadcast db write failed", { groupId: gid, error: String(e) });
    }

    results.push({
      groupId: gid,
      groupTitle: group.title,
      success: !bridgeError,
      sent,
      messageId,
      ...(bridgeError ? { error: bridgeError } : {}),
    });
  }

  const successCount = results.filter((r) => r.success).length;
  const failCount = results.length - successCount;

  return NextResponse.json({
    total: groupIds.length,
    successCount,
    failCount,
    scheduled: scheduleDateUnix != null,
    results,
  });
}
