import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireAuth } from "@/lib/auth/middleware";
import { hashPassword, verifyPassword } from "@/lib/auth/passwords";
import { logAudit } from "@/lib/audit/logger";

// POST /api/auth/change-password
export async function POST(request: Request) {
  const auth = await requireAuth();
  if (auth instanceof NextResponse) return auth;

  let body: { currentPassword?: string; newPassword?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "無效的請求內容" },
      { status: 400 }
    );
  }

  const { currentPassword, newPassword } = body;

  if (!currentPassword || !newPassword) {
    return NextResponse.json(
      { error: "請輸入目前密碼與新密碼" },
      { status: 400 }
    );
  }

  if (
    typeof newPassword !== "string" ||
    newPassword.length < 8 ||
    newPassword.length > 200
  ) {
    return NextResponse.json(
      { error: "新密碼長度須介於 8 至 200 字元" },
      { status: 400 }
    );
  }

  const user = await prisma.user.findUnique({
    where: { id: auth.userId },
    select: { id: true, passwordHash: true },
  });

  if (!user) {
    return NextResponse.json({ error: "找不到使用者" }, { status: 404 });
  }

  const valid = await verifyPassword(currentPassword, user.passwordHash);
  if (!valid) {
    return NextResponse.json(
      { error: "目前密碼不正確" },
      { status: 400 }
    );
  }

  const newHash = await hashPassword(newPassword);
  await prisma.user.update({
    where: { id: auth.userId },
    data: { passwordHash: newHash },
  });

  // Audit log — attach to first active workspace if available
  try {
    const membership = await prisma.workspaceMembership.findFirst({
      where: { userId: auth.userId, isActive: true },
      select: { workspaceId: true },
    });
    if (membership) {
      await logAudit({
        workspaceId: membership.workspaceId,
        userId: auth.userId,
        action: "password.changed",
        entityType: "User",
        entityId: auth.userId,
        ipAddress:
          request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
          undefined,
      });
    }
  } catch {
    // never block response on audit failure
  }

  return NextResponse.json({ success: true });
}
