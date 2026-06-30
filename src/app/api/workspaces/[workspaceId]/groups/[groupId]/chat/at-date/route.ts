import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireWorkspacePermission } from "@/lib/auth/middleware";
import { resolveVisibleAccountIds } from "@/lib/account-visibility";

type RouteParams = {
  params: Promise<{ workspaceId: string; groupId: string }>;
};

/**
 * 2026-05-21 Wave 1 — 跳到指定日期。
 *
 * GET /api/workspaces/:ws/groups/:groupId/chat/at-date?date=YYYY-MM-DD
 *   → { messageId: string | null, timestamp?: string }
 *
 * 回傳「該日期 00:00(含)起最早的一則訊息」的 DCM id。前端再用 loadUntilMatch
 * 把歷史往前載到該訊息並捲過去。日期晚於最後一則訊息 → messageId: null。
 */
export async function GET(req: Request, { params }: RouteParams) {
  const { workspaceId, groupId } = await params;
  const auth = await requireWorkspacePermission(workspaceId, "canDirectMessage");
  if (auth instanceof NextResponse) return auth;

  const dateStr = new URL(req.url).searchParams.get("date");
  if (!dateStr) {
    return NextResponse.json({ error: "缺少 date 參數" }, { status: 400 });
  }
  const date = new Date(`${dateStr}T00:00:00`);
  if (Number.isNaN(date.getTime())) {
    return NextResponse.json({ error: "date 格式無效" }, { status: 400 });
  }

  // 可見性檢查 — 員工只能對自己看得到的對話操作
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

  const msg = await prisma.directChatMessage.findFirst({
    where: {
      workspaceId,
      groupId,
      isDeleted: false,
      createdAt: { gte: date },
    },
    orderBy: { createdAt: "asc" },
    select: { id: true, createdAt: true },
  });

  if (!msg) {
    return NextResponse.json({ messageId: null });
  }
  return NextResponse.json({
    messageId: msg.id,
    timestamp: msg.createdAt.toISOString(),
  });
}
