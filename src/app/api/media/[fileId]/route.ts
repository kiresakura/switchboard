import { NextResponse } from "next/server";
import sharp from "sharp";
import { MediaFileManager } from "@/lib/media/file-manager.server";
import { requireAuth, requireWorkspacePermission } from "@/lib/auth/middleware";
import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";

const log = logger("MediaApi");

// On-the-fly thumbnail sizes. Allowlisted so a caller can't spray unbounded
// distinct widths (each one is a fresh sharp resize + a new cache entry).
const RESIZE_WIDTHS = new Set([200, 400, 800]);
const RESIZABLE_MIME = new Set(["image/jpeg", "image/png", "image/webp"]);

const SAFE_MIME_TYPES = new Set([
  'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/bmp',
  'video/mp4', 'video/webm',
  'audio/mpeg', 'audio/ogg', 'audio/wav',
  'application/pdf',
  'text/plain',
]);

type RouteParams = {
  params: Promise<{ fileId: string }>;
};

// GET /api/media/:fileId - Serve media file with access control
export async function GET(req: Request, { params }: RouteParams) {
  const { fileId } = await params;
  
  try {
    // Get file metadata to check workspace
    const mediaFile = await prisma.mediaFile.findUnique({
      where: { id: fileId },
      include: { workspace: true }
    });

    if (!mediaFile) {
      return NextResponse.json(
        { error: "檔案不存在" },
        { status: 404 }
      );
    }

    // Check auth first
    const auth = await requireAuth();
    if (auth instanceof NextResponse) return auth;

    // Verify workspace membership (workspace isolation)
    if (mediaFile.workspaceId) {
      const membership = await prisma.workspaceMembership.findUnique({
        where: {
          userId_workspaceId: {
            userId: auth.userId,
            workspaceId: mediaFile.workspaceId,
          },
        },
      });
      if (!membership?.isActive && !auth.isSystemAdmin) {
        return NextResponse.json({ error: "存取被拒" }, { status: 403 });
      }
    }

    // Get file buffer
    const fileData = await MediaFileManager.getFile(fileId);
    if (!fileData) {
      return NextResponse.json(
        { error: "檔案讀取失敗" },
        { status: 500 }
      );
    }

    // Optional on-the-fly thumbnail — GET /api/media/<id>?w=200|400|800
    // resizes raster images with sharp and serves WebP. Width is
    // allowlisted; non-image / unknown widths fall through to the original.
    const widthParam = new URL(req.url).searchParams.get("w");
    const width = widthParam ? parseInt(widthParam, 10) : 0;
    if (
      width &&
      RESIZE_WIDTHS.has(width) &&
      RESIZABLE_MIME.has(fileData.record.mimeType)
    ) {
      try {
        const resized = await sharp(fileData.buffer)
          .resize({ width, withoutEnlargement: true })
          .webp({ quality: 80 })
          .toBuffer();
        const thumb = new NextResponse(
          new Blob([new Uint8Array(resized)], { type: "image/webp" }),
        );
        thumb.headers.set("Content-Type", "image/webp");
        thumb.headers.set("Content-Length", resized.length.toString());
        thumb.headers.set("Content-Disposition", "inline");
        thumb.headers.set("Cache-Control", "public, max-age=31536000, immutable");
        return thumb;
      } catch (err) {
        // Corrupt image / sharp failure → fall through to the original.
        log.warn("thumbnail resize failed, serving original", {
          fileId,
          error: String(err).slice(0, 120),
        });
      }
    }

    // MIME type sanitization: only allow safe types inline
    const safeMimeType = SAFE_MIME_TYPES.has(fileData.record.mimeType)
      ? fileData.record.mimeType
      : 'application/octet-stream';

    // Set appropriate headers — Buffer 在 Next.js 16 / React 19 下要包成 Blob 才被 NextResponse
    // 接受為 BodyInit；之前的 `as unknown as BodyInit` 會在 runtime 變空 body 導致 <img> 載入失敗
    const blob = new Blob([new Uint8Array(fileData.buffer)], { type: safeMimeType });
    const response = new NextResponse(blob);
    response.headers.set('Content-Type', safeMimeType);
    response.headers.set('Content-Length', fileData.record.size.toString());

    // Force download for non-safe MIME types
    if (!SAFE_MIME_TYPES.has(fileData.record.mimeType)) {
      response.headers.set(
        'Content-Disposition',
        `attachment; filename="${encodeURIComponent(fileData.record.originalName || 'download')}"`
      );
    } else {
      response.headers.set(
        'Content-Disposition',
        `inline; filename="${encodeURIComponent(fileData.record.originalName)}"`
      );
    }

    // Cache headers for images
    if (fileData.record.mimeType.startsWith('image/')) {
      response.headers.set('Cache-Control', 'public, max-age=31536000');
    }

    return response;

  } catch (error) {
    log.error("error serving file", { fileId, error: String(error) });
    return NextResponse.json(
      { error: "伺服器錯誤" },
      { status: 500 }
    );
  }
}

// DELETE /api/media/:fileId - Delete media file
export async function DELETE(req: Request, { params }: RouteParams) {
  const { fileId } = await params;

  try {
    // Get file metadata to check workspace
    const mediaFile = await prisma.mediaFile.findUnique({
      where: { id: fileId }
    });

    if (!mediaFile) {
      return NextResponse.json(
        { error: "檔案不存在" },
        { status: 404 }
      );
    }

    // Check workspace admin access
    const auth = await requireWorkspacePermission(mediaFile.workspaceId, "canEditWorkspaceSettings");
    if (auth instanceof NextResponse) return auth;

    // Delete file
    const success = await MediaFileManager.deleteFile(fileId);
    
    if (!success) {
      return NextResponse.json(
        { error: "檔案刪除失敗" },
        { status: 500 }
      );
    }

    return NextResponse.json({ success: true });

  } catch (error) {
    log.error("error deleting file", { fileId, error: String(error) });
    return NextResponse.json(
      { error: "伺服器錯誤" },
      { status: 500 }
    );
  }
}