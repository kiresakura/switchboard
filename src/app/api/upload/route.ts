import { NextResponse } from "next/server";
import { MediaFileManager } from "@/lib/media/file-manager.server";
import { requireWorkspaceMember } from "@/lib/auth/middleware";
import { createRateLimiter } from "@/lib/rate-limit";
import { logger } from "@/lib/logger";

const log = logger("Upload");

// Per-user upload limiter — guards against accidental flood / disk DoS.
// 30 uploads / minute is well above interactive use but stops scripted abuse.
const uploadLimiter = createRateLimiter({ max: 30, windowMs: 60_000 });

// POST /api/upload - Upload media file
export async function POST(req: Request) {
  try {
    const url = new URL(req.url);
    const workspaceId = url.searchParams.get('workspaceId');

    if (!workspaceId) {
      return NextResponse.json(
        { error: "workspaceId 參數必需" },
        { status: 400 }
      );
    }

    // Check workspace access
    const auth = await requireWorkspaceMember(workspaceId);
    if (auth instanceof NextResponse) return auth;

    if (!uploadLimiter.consume(`${workspaceId}:${auth.userId}`)) {
      return NextResponse.json(
        { error: "上傳次數過於頻繁，請稍後再試" },
        { status: 429 }
      );
    }

    // Parse multipart form data — req.formData() throws if content-type
    // isn't multipart or form-urlencoded, so catch that as a 400.
    let formData: FormData;
    try {
      formData = await req.formData();
    } catch {
      return NextResponse.json(
        { error: "請使用 multipart/form-data 格式上傳檔案" },
        { status: 400 }
      );
    }
    const file = formData.get('file') as File;

    if (!file) {
      return NextResponse.json(
        { error: "未找到檔案" },
        { status: 400 }
      );
    }

    // Check file size before buffering (C8 fix: prevent OOM)
    // Aligned with file-manager limits (20MB allows overhead for encoding)
    const MAX_UPLOAD_SIZE = 20 * 1024 * 1024; // 20MB
    if (file.size > MAX_UPLOAD_SIZE) {
      return NextResponse.json(
        { error: `檔案大小超過限制 (最大 ${MAX_UPLOAD_SIZE / 1024 / 1024}MB)` },
        { status: 413 }
      );
    }

    // Store file using server-side MediaFileManager
    const result = await MediaFileManager.storeFile(file, workspaceId);

    return NextResponse.json({
      success: true,
      file: {
        id: result.id,
        url: result.url,
        name: result.originalName,
        size: result.size,
        type: result.mimeType
      }
    });

  } catch (error) {
    log.error("upload failed", { error: String(error) });

    const errorMessage = error instanceof Error ? error.message : "上傳失敗";

    return NextResponse.json(
      { error: errorMessage },
      { status: 500 }
    );
  }
}