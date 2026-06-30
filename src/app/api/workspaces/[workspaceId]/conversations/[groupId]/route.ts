import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireWorkspaceMember } from "@/lib/auth/middleware";
import { logAudit } from "@/lib/audit/logger";
import { resolveVisibleAccountIds } from "@/lib/account-visibility";


type RouteParams = { params: Promise<{ workspaceId: string; groupId: string }> };

type ConversationStatus = "OPEN" | "SNOOZED" | "CLOSED";

function canManageConversation(auth: Awaited<ReturnType<typeof requireWorkspaceMember>>) {
  if (auth instanceof NextResponse) return false;
  return (
    auth.isSystemAdmin ||
    auth.permissions.canDirectMessage ||
    auth.permissions.canModerateMessages ||
    auth.permissions.canManageGroupRegistry
  );
}

function canAssignConversationToMember(auth: Awaited<ReturnType<typeof requireWorkspaceMember>>) {
  if (auth instanceof NextResponse) return false;
  return (
    auth.isSystemAdmin ||
    auth.permissions.canManageGroupRegistry ||
    auth.permissions.canSuperviseTeam ||
    auth.permissions.canDelegateAccounts
  );
}

async function getComputedActivity(groupId: string) {
  const [lastInbound, lastOutbound] = await Promise.all([
    prisma.directChatMessage.findFirst({
      where: { groupId, direction: "INBOUND" },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    }),
    prisma.directChatMessage.findFirst({
      where: { groupId, direction: "OUTBOUND" },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    }),
  ]);

  return {
    lastInboundAt: lastInbound?.createdAt ?? null,
    lastOutboundAt: lastOutbound?.createdAt ?? null,
  };
}

export async function GET(_req: Request, { params }: RouteParams) {
  const { workspaceId, groupId } = await params;
  const auth = await requireWorkspaceMember(workspaceId);
  if (auth instanceof NextResponse) return auth;

  // 四層權限可見性檢查(Backend-first 2026-05-21):確保使用者能看到的帳號裡至少
  // 有一個是此對話的 listener — 否則 404,避免 IDOR(直接打網址也看不到)。
  const visibleAccountIds = await resolveVisibleAccountIds({
    userId: auth.userId,
    workspaceId,
    isSystemAdmin: auth.isSystemAdmin,
    permissions: auth.permissions,
  });

  const group = await prisma.group.findFirst({
    where: {
      id: groupId,
      workspaceId,
      ...(visibleAccountIds.size > 0
        ? {
            accountMemberships: {
              some: { accountId: { in: Array.from(visibleAccountIds) } },
            },
          }
        : { id: "__never_match__" }), // 沒帳號可見就直接撈不到任何東西
    },
    select: {
      id: true,
      title: true,
      chatType: true,
      tags: true,
      conversationStatus: true,
      conversationAssignedAt: true,
      conversationClosedAt: true,
      conversationPinnedAt: true,
      lastInboundAt: true,
      lastOutboundAt: true,
      conversationOwner: {
        select: {
          id: true,
          displayName: true,
          username: true,
        },
      },
    },
  });

  if (!group) {
    return NextResponse.json({ error: "找不到對話" }, { status: 404 });
  }

  const computed =
    group.lastInboundAt == null || group.lastOutboundAt == null
      ? await getComputedActivity(group.id)
      : null;

  return NextResponse.json({
    conversation: {
      ...group,
      kind: group.chatType === "PRIVATE" ? "DIRECT" : "GROUP",
      lastInboundAt: group.lastInboundAt ?? computed?.lastInboundAt ?? null,
      lastOutboundAt: group.lastOutboundAt ?? computed?.lastOutboundAt ?? null,
    },
  });
}

export async function PATCH(req: Request, { params }: RouteParams) {
  const { workspaceId, groupId } = await params;
  const auth = await requireWorkspaceMember(workspaceId);
  if (auth instanceof NextResponse) return auth;
  if (!canManageConversation(auth)) {
    return NextResponse.json({ error: "權限不足" }, { status: 403 });
  }

  let body: {
    ownerAction?: "claim_self" | "release" | "assign";
    ownerUserId?: string;
    status?: ConversationStatus;
    /** P1 釘選對話到頂:true = 立刻 pin(timestamp=now);false = 取消 pin。 */
    pin?: boolean;
    /**
     * P2 靜音通知:
     *   - "8h"   → 靜音 8 小時 (一個工作天的下半段)
     *   - "1d"   → 靜音 24 小時
     *   - "forever" → 永久靜音 (year 9999)
     *   - false → 取消靜音 (notificationsMutedUntil = null)
     */
    mute?: "8h" | "1d" | "forever" | false;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "無效的請求內容" }, { status: 400 });
  }

  const visibleAccountIds = await resolveVisibleAccountIds({
    userId: auth.userId,
    workspaceId,
    isSystemAdmin: auth.isSystemAdmin,
    permissions: auth.permissions,
  });

  const group = await prisma.group.findFirst({
    where: {
      id: groupId,
      workspaceId,
      ...(visibleAccountIds.size > 0
        ? {
            accountMemberships: {
              some: { accountId: { in: Array.from(visibleAccountIds) } },
            },
          }
        : { id: "__never_match__" }),
    },
    select: {
      id: true,
      title: true,
      conversationOwnerId: true,
      conversationStatus: true,
      conversationPinnedAt: true,
      tags: true,
      chatType: true,
    },
  });
  if (!group) {
    return NextResponse.json({ error: "找不到對話" }, { status: 404 });
  }

  const data: {
    conversationOwnerId?: string | null;
    conversationAssignedAt?: Date | null;
    conversationStatus?: ConversationStatus;
    conversationClosedAt?: Date | null;
    conversationPinnedAt?: Date | null;
    notificationsMutedUntil?: Date | null;
  } = {};
  const auditDetails: Record<string, unknown> = {
    groupId,
    groupTitle: group.title,
  };

  if (body.ownerAction === "claim_self") {
    data.conversationOwnerId = auth.userId;
    data.conversationAssignedAt = new Date();
    auditDetails.ownerAction = "claim_self";
  } else if (body.ownerAction === "release") {
    if (group.conversationOwnerId && group.conversationOwnerId !== auth.userId && !auth.isSystemAdmin) {
      return NextResponse.json({ error: "只能釋出自己持有的對話" }, { status: 403 });
    }
    data.conversationOwnerId = null;
    data.conversationAssignedAt = null;
    auditDetails.ownerAction = "release";
  } else if (body.ownerAction === "assign") {
    if (!canAssignConversationToMember(auth)) {
      return NextResponse.json({ error: "權限不足" }, { status: 403 });
    }
    if (!body.ownerUserId || typeof body.ownerUserId !== "string") {
      return NextResponse.json({ error: "ownerUserId 必須是有效使用者 ID" }, { status: 400 });
    }

    const target = await prisma.workspaceMembership.findFirst({
      where: {
        workspaceId,
        userId: body.ownerUserId,
        isActive: true,
        user: { isActive: true },
      },
      select: {
        userId: true,
        user: { select: { displayName: true, username: true } },
      },
    });
    if (!target) {
      return NextResponse.json({ error: "指派對象不在此工作區或已停用" }, { status: 400 });
    }

    data.conversationOwnerId = target.userId;
    data.conversationAssignedAt = new Date();
    auditDetails.ownerAction = "assign";
    auditDetails.ownerUserId = target.userId;
    auditDetails.ownerDisplayName = target.user.displayName;
  }

  if (body.status) {
    data.conversationStatus = body.status;
    data.conversationClosedAt = body.status === "CLOSED" ? new Date() : null;
    auditDetails.status = body.status;
  }

  if (body.pin !== undefined) {
    data.conversationPinnedAt = body.pin ? new Date() : null;
    auditDetails.pin = body.pin;
  }

  if (body.mute !== undefined) {
    if (body.mute === false) {
      data.notificationsMutedUntil = null;
    } else if (body.mute === "8h") {
      data.notificationsMutedUntil = new Date(Date.now() + 8 * 60 * 60 * 1000);
    } else if (body.mute === "1d") {
      data.notificationsMutedUntil = new Date(Date.now() + 24 * 60 * 60 * 1000);
    } else if (body.mute === "forever") {
      // year 9999 — 實質永久。給日後若想加「定期清理過期」cron 一個明確 sentinel
      data.notificationsMutedUntil = new Date("9999-12-31T23:59:59Z");
    }
    auditDetails.mute = body.mute;
  }

  const updated = await prisma.group.update({
    where: { id: group.id },
    data,
    select: {
      id: true,
      title: true,
      chatType: true,
      tags: true,
      conversationStatus: true,
      conversationAssignedAt: true,
      conversationClosedAt: true,
      conversationPinnedAt: true,
      notificationsMutedUntil: true,
      lastInboundAt: true,
      lastOutboundAt: true,
      conversationOwner: {
        select: {
          id: true,
          displayName: true,
          username: true,
        },
      },
    },
  });

  await logAudit({
    workspaceId,
    userId: auth.userId,
    action: "conversation.update",
    entityType: "GroupConversation",
    entityId: group.id,
    details: auditDetails,
  });

  return NextResponse.json({
    success: true,
    conversation: {
      ...updated,
      kind: updated.chatType === "PRIVATE" ? "DIRECT" : "GROUP",
    },
  });
}
