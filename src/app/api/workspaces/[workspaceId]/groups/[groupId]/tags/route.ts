import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireWorkspacePermission } from "@/lib/auth/middleware";
import { resolveVisibleAccountIds } from "@/lib/account-visibility";
import { logAudit } from "@/lib/audit/logger";
import { normalizeConversationTags } from "@/lib/conversation/tags";
import { eventBus } from "@/lib/realtime/event-bus";

type RouteParams = {
  params: Promise<{ workspaceId: string; groupId: string }>;
};

/**
 * 2026-05-21 — 對話標籤(套用在 Group.tags 的自由字串)。
 *
 * GET   /api/workspaces/:ws/groups/:groupId/tags  → { tags: string[] }
 * PATCH /api/workspaces/:ws/groups/:groupId/tags  body { tags: string[] } → { tags }
 *
 * 跟「標籤管理」頁(WorkspaceTag 詞彙表)的差別:那頁管「可選的詞彙」,這裡把
 * 標籤實際套到某個對話。對話標籤是自由字串,不強制一定要在詞彙表內。
 * 權限用 canDirectMessage —— 能處理對話的員工就能替對話貼標籤;並做可見性檢查。
 */

export async function GET(_req: Request, { params }: RouteParams) {
  const { workspaceId, groupId } = await params;
  const auth = await requireWorkspacePermission(workspaceId, "canDirectMessage");
  if (auth instanceof NextResponse) return auth;

  const visible = await resolveVisibleAccountIds({
    userId: auth.userId,
    workspaceId,
    isSystemAdmin: auth.isSystemAdmin,
    permissions: auth.permissions,
  });
  const group = await prisma.group.findFirst({
    where: {
      id: groupId,
      workspaceId,
      ...(visible.size > 0
        ? {
            accountMemberships: {
              some: { accountId: { in: Array.from(visible) } },
            },
          }
        : { id: "__never_match__" }),
    },
    select: { tags: true },
  });
  if (!group) {
    return NextResponse.json({ error: "找不到對話" }, { status: 404 });
  }
  return NextResponse.json({ tags: group.tags });
}

export async function PATCH(req: Request, { params }: RouteParams) {
  const { workspaceId, groupId } = await params;
  const auth = await requireWorkspacePermission(workspaceId, "canDirectMessage");
  if (auth instanceof NextResponse) return auth;

  let body: { tags?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "無效的請求內容" }, { status: 400 });
  }
  let tags: string[];
  try {
    tags = normalizeConversationTags(body.tags);
  } catch {
    return NextResponse.json({ error: "tags 必須是字串陣列" }, { status: 400 });
  }

  const visible = await resolveVisibleAccountIds({
    userId: auth.userId,
    workspaceId,
    isSystemAdmin: auth.isSystemAdmin,
    permissions: auth.permissions,
  });
  const group = await prisma.group.findFirst({
    where: {
      id: groupId,
      workspaceId,
      ...(visible.size > 0
        ? {
            accountMemberships: {
              some: { accountId: { in: Array.from(visible) } },
            },
          }
        : { id: "__never_match__" }),
    },
    select: { id: true },
  });
  if (!group) {
    return NextResponse.json({ error: "找不到對話" }, { status: 404 });
  }

  const updated = await prisma.group.update({
    where: { id: group.id },
    data: { tags },
    select: { id: true, tags: true, updatedAt: true },
  });

  await logAudit({
    workspaceId,
    userId: auth.userId,
    action: "conversation.tags_update",
    entityType: "Group",
    entityId: groupId,
    details: { count: tags.length },
  });

  eventBus.publish({
    type: "conversation:tags-updated",
    workspaceId,
    data: {
      groupId,
      tags: updated.tags,
      updatedAt: updated.updatedAt.toISOString(),
      group: {
        id: updated.id,
        tags: updated.tags,
        updatedAt: updated.updatedAt.toISOString(),
      },
      updatedBy: auth.userId,
    },
  });

  return NextResponse.json({
    tags: updated.tags,
    group: {
      id: updated.id,
      tags: updated.tags,
      updatedAt: updated.updatedAt.toISOString(),
    },
  });
}
