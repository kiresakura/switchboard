import { NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";
import { prisma } from "@/lib/db";
import { requireWorkspaceMember } from "@/lib/auth/middleware";

type RouteParams = { params: Promise<{ workspaceId: string; platformUserId: string }> };

// GET /api/workspaces/:id/avatars/:platformUserId
// Streams the cached Telegram profile photo bytes for a sender. Returns 404
// when we've never seen/cached one (frontend falls back to initials avatar).
// Cached server-side by SenderAvatar rows written by the bridge worker.
export async function GET(_req: Request, { params }: RouteParams) {
  const { workspaceId, platformUserId } = await params;
  const auth = await requireWorkspaceMember(workspaceId);
  if (auth instanceof NextResponse) return auth;

  const avatar = await prisma.senderAvatar.findUnique({
    where: {
      workspaceId_platformUserId: { workspaceId, platformUserId },
    },
    select: { mediaPath: true, mimeType: true },
  });

  if (!avatar || !avatar.mediaPath) {
    return new NextResponse(null, { status: 404 });
  }

  // Defense in depth: the stored path must resolve inside the uploads dir.
  const uploadRoot = path.resolve(process.env.MEDIA_UPLOAD_DIR || "./uploads");
  const abs = path.resolve(avatar.mediaPath);
  if (!abs.startsWith(uploadRoot)) {
    return new NextResponse(null, { status: 404 });
  }

  try {
    const bytes = await fs.readFile(abs);
    return new NextResponse(new Uint8Array(bytes), {
      status: 200,
      headers: {
        "Content-Type": avatar.mimeType || "image/jpeg",
        // Clients may cache aggressively — avatar content is addressed by
        // (workspace, platformUserId) and refreshed by the bridge worker on a
        // 7-day cycle. A short browser cache gives us free HTTP cache wins
        // without blocking new-photo propagation for too long.
        "Cache-Control": "private, max-age=3600",
      },
    });
  } catch {
    return new NextResponse(null, { status: 404 });
  }
}
