import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireWorkspacePermission } from "@/lib/auth/middleware";
import { resolveVisibleAccountIds } from "@/lib/account-visibility";
import { logAudit } from "@/lib/audit/logger";
import { eventBus } from "@/lib/realtime/event-bus";

type RouteParams = { params: Promise<{ workspaceId: string }> };

const MAX_BATCH = 200;

// PATCH /api/workspaces/:id/direct-chat/messages/pin
// 釘選 / 取消釘選對話視窗裡的訊息(單則或批量合一)。
// body: { messageIds: string[], pin: boolean }
//
// 釘選是 Switchboard 內部標記(寫 DirectChatMessage.pinnedAt),不同步回 Telegram —
// 客服用來把對話裡的重要訊息釘到視窗頂端,可釘多則、可批量。任何訊息(含客戶
// INBOUND)都可釘,所以權限只要 canDirectMessage(看得到對話的人)。
export async function PATCH(req: Request, { params }: RouteParams) {
  const { workspaceId } = await params;
  const auth = await requireWorkspacePermission(workspaceId, "canDirectMessage");
  if (auth instanceof NextResponse) return auth;

  let body: { messageIds?: unknown; pin?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "無效的請求內容" }, { status: 400 });
  }

  const messageIds = Array.isArray(body.messageIds)
    ? Array.from(new Set(body.messageIds.filter((x): x is string => typeof x === "string" && !!x)))
    : [];
  if (messageIds.length === 0) {
    return NextResponse.json({ error: "請至少選擇一則訊息" }, { status: 400 });
  }
  if (messageIds.length > MAX_BATCH) {
    return NextResponse.json({ error: `一次最多處理 ${MAX_BATCH} 則訊息` }, { status: 400 });
  }
  if (typeof body.pin !== "boolean") {
    return NextResponse.json({ error: "pin 必須是 boolean" }, { status: 400 });
  }
  const pin = body.pin;

  // 可見性閘門:只動使用者看得到的對話的訊息(避免 IDOR)。
  const visibleAccountIds = await resolveVisibleAccountIds({
    userId: auth.userId,
    workspaceId,
    isSystemAdmin: auth.isSystemAdmin,
    permissions: auth.permissions,
  });
  if (visibleAccountIds.size === 0) {
    return NextResponse.json({ success: true, updated: 0, pinned: pin });
  }

  const msgs = await prisma.directChatMessage.findMany({
    where: {
      id: { in: messageIds },
      workspaceId,
      group: {
        accountMemberships: { some: { accountId: { in: Array.from(visibleAccountIds) } } },
      },
    },
    select: { id: true, groupId: true },
  });
  if (msgs.length === 0) {
    return NextResponse.json({ success: true, updated: 0, pinned: pin });
  }
  const allowedIds = msgs.map((m) => m.id);
  const pinnedAt = pin ? new Date() : null;

  await prisma.directChatMessage.updateMany({
    where: { id: { in: allowedIds } },
    data: { pinnedAt },
  });

  // 每個受影響對話發一次 SSE,讓正在看同一對話的同事即時更新釘選列。
  const byGroup = new Map<string, string[]>();
  for (const m of msgs) {
    const arr = byGroup.get(m.groupId) ?? [];
    arr.push(m.id);
    byGroup.set(m.groupId, arr);
  }
  for (const [groupId, ids] of byGroup) {
    eventBus.publish({
      type: "message:pinned",
      workspaceId,
      data: {
        groupId,
        messageIds: ids,
        pinned: pin,
        pinnedAt: pinnedAt ? pinnedAt.toISOString() : null,
      },
    });
  }

  await logAudit({
    workspaceId,
    userId: auth.userId,
    action: "direct_chat.message_pin",
    entityType: "DirectChatMessage",
    entityId: allowedIds[0],
    details: { pin, count: allowedIds.length, groupIds: Array.from(byGroup.keys()) },
  }).catch(() => {});

  return NextResponse.json({ success: true, updated: allowedIds.length, pinned: pin });
}
