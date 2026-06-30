import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireWorkspacePermission } from "@/lib/auth/middleware";
import { logAudit } from "@/lib/audit/logger";

type RouteParams = {
  params: Promise<{ workspaceId: string; accountId: string }>;
};

// PATCH /api/workspaces/:id/accounts/:aid
export async function PATCH(req: Request, { params }: RouteParams) {
  const { workspaceId, accountId } = await params;
  const auth = await requireWorkspacePermission(workspaceId, "canManageCommunicationAccounts");
  if (auth instanceof NextResponse) return auth;

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "無效的請求內容" }, { status: 400 });
  }

  // H3 fix: validate account status enum
  const VALID_STATUSES = ["PENDING_AUTH", "ACTIVE", "DISCONNECTED", "AUTH_ERROR", "DISABLED"];
  if (body.status !== undefined && !VALID_STATUSES.includes(body.status as string)) {
    return NextResponse.json(
      { error: `無效的帳號狀態（必須為：${VALID_STATUSES.join(" / ")}）` },
      { status: 400 }
    );
  }

  let account;
  try {
    account = await prisma.communicationAccount.update({
      where: { id: accountId, workspaceId },
      data: {
        ...(body.displayName !== undefined && { displayName: body.displayName as string }),
        ...(body.status !== undefined && { status: body.status as "PENDING_AUTH" | "ACTIVE" | "DISCONNECTED" | "AUTH_ERROR" | "DISABLED" }),
      },
    });
  } catch {
    return NextResponse.json({ error: "找不到帳號" }, { status: 404 });
  }

  await logAudit({
    workspaceId,
    userId: auth.userId,
    action: "account.update",
    entityType: "CommunicationAccount",
    entityId: accountId,
    details: body,
  });

  return NextResponse.json({ account });
}

// DELETE /api/workspaces/:id/accounts/:aid
export async function DELETE(_req: Request, { params }: RouteParams) {
  const { workspaceId, accountId } = await params;
  const auth = await requireWorkspacePermission(workspaceId, "canManageCommunicationAccounts");
  if (auth instanceof NextResponse) return auth;

  // 1) 找出「只有這個帳號在監聽」的群組（孤兒群組）
  //    這些群組刪掉帳號後就失去資料來源，UI 應該把它們隱藏（保留歷史訊息與配對紀錄）
  //    用兩步驟查：先找這帳號的所有 group，再排除其他帳號也有監聽的
  const accountMemberships = await prisma.accountGroupMembership.findMany({
    where: { accountId },
    select: { groupId: true },
  });
  const groupIds = accountMemberships.map((m) => m.groupId);

  const orphanedGroups: Array<{ id: string }> = [];
  for (const gid of groupIds) {
    const otherCount = await prisma.accountGroupMembership.count({
      where: { groupId: gid, accountId: { not: accountId } },
    });
    if (otherCount === 0) {
      orphanedGroups.push({ id: gid });
    }
  }

  // (Pairing-deactivate cascade dropped in H4 — no Pairing table any more.)
  let deletedAccount = false;
  try {
    await prisma.$transaction([
      prisma.group.updateMany({
        where: { id: { in: orphanedGroups.map((g) => g.id) } },
        data: { isActive: false },
      }),
      prisma.communicationAccount.delete({
        where: { id: accountId, workspaceId },
      }),
    ]);
    deletedAccount = true;
  } catch {
    return NextResponse.json({ error: "找不到帳號" }, { status: 404 });
  }

  // 3) 通知 bridge 斷開此帳號的 GramJS client（fire-and-forget；bridge 沒回應不影響使用者）
  if (deletedAccount) {
    const bridgeUrl =
      process.env.BRIDGE_URL ||
      `http://localhost:${process.env.BRIDGE_PORT || 3001}`;
    fetch(`${bridgeUrl}/stop-account`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.INTERNAL_SECRET ?? ""}`,
      },
      body: JSON.stringify({ accountId }),
      signal: AbortSignal.timeout(5000),
    }).catch(() => {
      // bridge 不可用是非致命，帳號 DB 已刪除即可
    });
  }

  await logAudit({
    workspaceId,
    userId: auth.userId,
    action: "account.delete",
    entityType: "CommunicationAccount",
    entityId: accountId,
    details: { orphanedGroupCount: orphanedGroups.length },
  });

  return NextResponse.json({
    success: true,
    orphanedGroupCount: orphanedGroups.length,
  });
}
