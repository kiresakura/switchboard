import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireWorkspacePermission } from "@/lib/auth/middleware";
import { logAudit } from "@/lib/audit/logger";
import { normalizeConversationTags } from "@/lib/conversation/tags";
import type { GroupCategory } from "@prisma/client";

type RouteParams = {
  params: Promise<{ workspaceId: string; groupId: string }>;
};

// PATCH /api/workspaces/:id/groups/:gid
export async function PATCH(req: Request, { params }: RouteParams) {
  const { workspaceId, groupId } = await params;
  const auth = await requireWorkspacePermission(workspaceId, "canManageGroupRegistry");
  if (auth instanceof NextResponse) return auth;

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "無效的請求內容" }, { status: 400 });
  }
  const { side, notes, title, customerName, isHidden, tags, listening } =
    body as {
      side?: string;
      notes?: string;
      title?: string;
      customerName?: string | null;
      isHidden?: boolean;
      tags?: string[];
      /**
       * Coarse listen toggle: true → set isListeningAccount=true on every
       * active AccountGroupMembership of this group; false → set them all
       * to false. Used by the「已忽略」tab's「重新監聽」button: from the
       * user's POV they're saying "this conversation should (not) flow into
       * the system again" — they don't care which specific account listens.
       * No-op when no active memberships exist.
       */
      listening?: boolean;
    };

  const VALID_SIDES: GroupCategory[] = ["CUSTOMER", "INTERNAL", "UNASSIGNED"];

  // Validate group side enum
  if (side !== undefined && !VALID_SIDES.includes(side as GroupCategory)) {
    return NextResponse.json(
      { error: "無效的群組類別（side 必須為 CUSTOMER / INTERNAL / UNASSIGNED）" },
      { status: 400 }
    );
  }

  let normalizedTags: string[] | undefined;
  if (tags !== undefined) {
    try {
      normalizedTags = normalizeConversationTags(tags);
    } catch {
      return NextResponse.json({ error: "tags 必須是字串陣列" }, { status: 400 });
    }
  }

  // M5 fix: verify entity is active before updating
  const existing = await prisma.group.findFirst({
    where: { id: groupId, workspaceId, isActive: true },
  });
  if (!existing) {
    return NextResponse.json({ error: "找不到群組或群組未啟用" }, { status: 404 });
  }

  // (H4 移除「配對引用」防呆 — 沒有 Pairing 表了。直面對話模式下,
  // 群組是否隱藏只看 UI 決定;訊息存留與否由 DCM 軟刪/封存獨立處理。)

  let group;
  try {
    group = await prisma.group.update({
      where: { id: groupId, workspaceId },
      data: {
        ...(side !== undefined && { side: side as GroupCategory }),
        ...(notes !== undefined && { notes }),
        ...(title !== undefined && { title }),
        ...(customerName !== undefined && { customerName }),
        ...(isHidden !== undefined && { isHidden }),
        ...(tags !== undefined && { tags: normalizedTags }),
      },
    });
  } catch {
    return NextResponse.json({ error: "找不到群組" }, { status: 404 });
  }

  // Coarse listen toggle — explicit `listening` 參數仍保留(讓內部呼叫
  // 端可以單獨控);此外「隱藏」現在會 cascade 把 listening 設成同步狀態:
  //   isHidden=true  → listening=false  (訊息不再送進系統,前端不出通知)
  //   isHidden=false → listening=true   (取消隱藏 = 重新監聽)
  // 規格 2026-05-05:把以前「停止監聽」獨立按鈕收掉,合併成「隱藏」一個動作。
  let effectiveListening: boolean | undefined = listening;
  if (isHidden !== undefined && existing.isHidden !== isHidden && listening === undefined) {
    effectiveListening = !isHidden;
  }
  let listeningChanged = 0;
  if (effectiveListening !== undefined) {
    const updated = await prisma.accountGroupMembership.updateMany({
      where: { groupId, account: { status: "ACTIVE" } },
      data: { isListeningAccount: effectiveListening },
    });
    listeningChanged = updated.count;
  }

  await logAudit({
    workspaceId,
    userId: auth.userId,
    action: "group.update",
    entityType: "Group",
    entityId: groupId,
    details: {
      side,
      notes,
      isHidden,
      ...(listening !== undefined && { listening, listeningChanged }),
    },
  });

  return NextResponse.json({ group, listeningChanged });
}

// DELETE /api/workspaces/:id/groups/:gid — soft-delete if conversation history
// exists (DCM rows), hard-delete otherwise. (H4: pairing-reference check
// removed — no Pairing table any more; chat history becomes the "has data"
// signal instead.)
export async function DELETE(_req: Request, { params }: RouteParams) {
  const { workspaceId, groupId } = await params;
  const auth = await requireWorkspacePermission(workspaceId, "canManageGroupRegistry");
  if (auth instanceof NextResponse) return auth;

  const existing = await prisma.group.findFirst({
    where: { id: groupId, workspaceId },
  });
  if (!existing) {
    return NextResponse.json({ error: "找不到此群組" }, { status: 404 });
  }

  // 對話歷史存在 = soft-delete(保留 DCM 給主管回看)
  const dcmCount = await prisma.directChatMessage.count({
    where: { workspaceId, groupId },
  });

  if (dcmCount > 0) {
    await prisma.group.update({
      where: { id: groupId },
      data: { isActive: false, isHidden: true },
    });

    await logAudit({
      workspaceId,
      userId: auth.userId,
      action: "group.deactivate",
      entityType: "Group",
      entityId: groupId,
      details: { reason: "has_chat_history", dcmCount, title: existing.title },
    });

    return NextResponse.json({
      success: true,
      method: "deactivated",
      message: `此群組有 ${dcmCount} 則對話歷史,已停用而非刪除`,
    });
  }

  // Hard-delete: no chat history, safe to remove
  await prisma.accountGroupMembership.deleteMany({ where: { groupId } });
  await prisma.group.delete({ where: { id: groupId } });

  await logAudit({
    workspaceId,
    userId: auth.userId,
    action: "group.delete",
    entityType: "Group",
    entityId: groupId,
    details: { title: existing.title },
  });

  return NextResponse.json({ success: true, method: "deleted" });
}
