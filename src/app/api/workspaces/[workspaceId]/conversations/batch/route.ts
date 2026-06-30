import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireWorkspaceMember } from "@/lib/auth/middleware";
import { resolveVisibleAccountIds } from "@/lib/account-visibility";
import { logAudit } from "@/lib/audit/logger";

type RouteParams = { params: Promise<{ workspaceId: string }> };

const MAX_BATCH = 200;

// PATCH /api/workspaces/:id/conversations/batch — 批量更新對話(目前支援釘選)。
// body: { groupIds: string[], pin: boolean }
export async function PATCH(req: Request, { params }: RouteParams) {
  const { workspaceId } = await params;
  const auth = await requireWorkspaceMember(workspaceId);
  if (auth instanceof NextResponse) return auth;
  const canManage =
    auth.isSystemAdmin ||
    auth.permissions.canDirectMessage ||
    auth.permissions.canModerateMessages ||
    auth.permissions.canManageGroupRegistry;
  if (!canManage) {
    return NextResponse.json({ error: "權限不足" }, { status: 403 });
  }

  let body: { groupIds?: unknown; pin?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "無效的請求內容" }, { status: 400 });
  }

  const groupIds = Array.isArray(body.groupIds)
    ? Array.from(new Set(body.groupIds.filter((x): x is string => typeof x === "string" && !!x)))
    : [];
  if (groupIds.length === 0) {
    return NextResponse.json({ error: "請至少選擇一個對話" }, { status: 400 });
  }
  if (groupIds.length > MAX_BATCH) {
    return NextResponse.json({ error: `一次最多處理 ${MAX_BATCH} 個對話` }, { status: 400 });
  }
  if (typeof body.pin !== "boolean") {
    return NextResponse.json({ error: "pin 必須是 boolean" }, { status: 400 });
  }
  const pin = body.pin;

  // 可見性閘門:只更新使用者看得到、且屬於此 workspace 的對話(避免 IDOR)。
  const visibleAccountIds = await resolveVisibleAccountIds({
    userId: auth.userId,
    workspaceId,
    isSystemAdmin: auth.isSystemAdmin,
    permissions: auth.permissions,
  });
  if (visibleAccountIds.size === 0) {
    return NextResponse.json({ success: true, updated: 0, pin });
  }

  const allowed = await prisma.group.findMany({
    where: {
      id: { in: groupIds },
      workspaceId,
      accountMemberships: { some: { accountId: { in: Array.from(visibleAccountIds) } } },
    },
    select: { id: true },
  });
  const allowedIds = allowed.map((g) => g.id);
  if (allowedIds.length === 0) {
    return NextResponse.json({ success: true, updated: 0, pin });
  }

  // 同批同一 timestamp:排序時並列(server-side sort 依 pinnedAt DESC)。
  await prisma.group.updateMany({
    where: { id: { in: allowedIds } },
    data: { conversationPinnedAt: pin ? new Date() : null },
  });

  await logAudit({
    workspaceId,
    userId: auth.userId,
    action: "conversation.batch_pin",
    entityType: "GroupConversation",
    entityId: allowedIds[0],
    details: { pin, count: allowedIds.length, groupIds: allowedIds },
  });

  return NextResponse.json({ success: true, updated: allowedIds.length, pin });
}
