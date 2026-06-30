import { NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";
import { prisma } from "@/lib/db";
import { requireWorkspaceMember } from "@/lib/auth/middleware";

type RouteParams = {
  params: Promise<{ workspaceId: string; platformGroupId: string }>;
};

// GET /api/workspaces/:id/group-avatars/:platformGroupId
// Streams the cached Telegram group photo. 404 when we've never cached one
// or the group is confirmed to have no photo (avatarPath=null). Frontend
// falls back to the initial-circle on 404.
//
// Cache is populated by the bridge worker's fetchMissingGroupAvatars pass
// (runs every 2 minutes, 7-day TTL per group).
export async function GET(_req: Request, { params }: RouteParams) {
  const { workspaceId, platformGroupId } = await params;
  const auth = await requireWorkspaceMember(workspaceId);
  if (auth instanceof NextResponse) return auth;

  const group = await prisma.group.findUnique({
    where: {
      workspaceId_platformGroupId: { workspaceId, platformGroupId },
    },
    select: { avatarPath: true, avatarMimeType: true },
  });

  if (!group || !group.avatarPath) {
    return new NextResponse(null, { status: 404 });
  }

  // Defense in depth: the stored path must resolve inside the uploads dir.
  const uploadRoot = path.resolve(process.env.MEDIA_UPLOAD_DIR || "./uploads");
  const abs = path.resolve(group.avatarPath);
  if (!abs.startsWith(uploadRoot)) {
    return new NextResponse(null, { status: 404 });
  }

  try {
    const bytes = await fs.readFile(abs);
    return new NextResponse(new Uint8Array(bytes), {
      status: 200,
      headers: {
        "Content-Type": group.avatarMimeType || "image/jpeg",
        // Short browser cache — the bridge refreshes on a 7-day cycle so
        // updates take at most an hour to propagate.
        "Cache-Control": "private, max-age=3600",
      },
    });
  } catch {
    return new NextResponse(null, { status: 404 });
  }
}
