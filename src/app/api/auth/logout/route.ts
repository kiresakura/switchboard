import { NextResponse } from "next/server";
import { deleteSession, getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { logAudit } from "@/lib/audit/logger";

export async function POST(request: Request) {
  // Capture session info before we delete it so we can audit the logout.
  try {
    const session = await getSession();
    if (session) {
      const ip =
        request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
        undefined;
      const userAgent = request.headers.get("user-agent") ?? undefined;
      const membership = await prisma.workspaceMembership.findFirst({
        where: { userId: session.userId, isActive: true },
        select: { workspaceId: true },
      });
      if (membership) {
        await logAudit({
          workspaceId: membership.workspaceId,
          userId: session.userId,
          action: "LOGOUT",
          entityType: "Session",
          entityId: session.id,
          details: { userAgent },
          ipAddress: ip,
        });
      }
    }
  } catch {
    // never block logout on audit failure
  }

  await deleteSession();
  const response = NextResponse.json({ success: true });
  response.cookies.set("switchboard_session", "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: "/",
    maxAge: 0,
  });
  return response;
}
