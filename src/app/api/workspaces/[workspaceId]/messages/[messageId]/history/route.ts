import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireWorkspaceMember } from "@/lib/auth/middleware";
import { resolveVisibleAccountIds } from "@/lib/account-visibility";

type RouteParams = {
  params: Promise<{ workspaceId: string; messageId: string }>;
};

/**
 * GET /api/workspaces/:wsId/messages/:messageId/history
 *
 * 訊息編輯 / 刪除歷程。
 *
 * 2026-05-21 重建:此 route 原本讀 broker Message 表,在 broker-strip
 * (commit 0aadbc0)被連帶刪掉 — 但 MessageHistoryDialog 仍在呼叫它,
 * 導致直面對話的「訊息歷程」對話框 404。
 *
 * 現以 DirectChatMessage + DirectChatMessageEditHistory 重建:
 *   - currentContent / editedAt / isDeleted / deletedAt 直接從 DCM 取
 *   - history[] 從 DirectChatMessageEditHistory 取(bridge 在每次 TG 端
 *     編輯訊息時會把舊內容塞一筆進去)
 *
 * 回傳 shape 跟 MessageHistoryDialog 期待的一致,前端不需要改。
 */
export async function GET(_req: Request, { params }: RouteParams) {
  const { workspaceId, messageId } = await params;
  const auth = await requireWorkspaceMember(workspaceId);
  if (auth instanceof NextResponse) return auth;

  const dcm = await prisma.directChatMessage.findFirst({
    where: { id: messageId, workspaceId },
    select: {
      id: true,
      accountId: true,
      content: true,
      editedAt: true,
      isDeleted: true,
      deletedAt: true,
      editHistory: {
        orderBy: { editedAt: "desc" },
        select: {
          id: true,
          previousContent: true,
          editedAt: true,
        },
      },
    },
  });

  if (!dcm) {
    return NextResponse.json({ error: "找不到訊息" }, { status: 404 });
  }

  // 可見性:員工只能看自己被指派 / 代理帳號的訊息編輯歷程(2026-05-21 review 補)。
  const visible = await resolveVisibleAccountIds({
    userId: auth.userId,
    workspaceId,
    isSystemAdmin: auth.isSystemAdmin,
    permissions: auth.permissions,
  });
  if (!visible.has(dcm.accountId)) {
    return NextResponse.json({ error: "無權查看此訊息歷程" }, { status: 403 });
  }

  return NextResponse.json({
    messageId: dcm.id,
    currentContent: dcm.content,
    editedAt: dcm.editedAt ? dcm.editedAt.toISOString() : null,
    isDeleted: dcm.isDeleted,
    deletedAt: dcm.deletedAt ? dcm.deletedAt.toISOString() : null,
    history: dcm.editHistory.map((h) => ({
      id: h.id,
      previousContent: h.previousContent,
      editedAt: h.editedAt.toISOString(),
    })),
  });
}
