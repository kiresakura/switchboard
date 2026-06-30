import { NextResponse } from "next/server";
import { requireWorkspaceMember } from "@/lib/auth/middleware";
import { logger } from "@/lib/logger";

const log = logger("StickerThumb");

const BRIDGE_URL = process.env.BRIDGE_URL || `http://localhost:${process.env.BRIDGE_PORT || 3001}`;
const INTERNAL_SECRET = process.env.INTERNAL_SECRET;

type RouteParams = {
  params: Promise<{ workspaceId: string }>;
};

/**
 * POST /api/workspaces/:wid/sticker-thumb
 *
 * Download a sticker thumbnail and stream it back to the browser.
 * Proxies to bridge POST /download-sticker-thumb.
 *
 * Body: { accountId, docId, accessHash, fileReference }
 * Returns: image/webp bytes with long-lived Cache-Control.
 *
 * Auth: any workspace member.
 */
export async function POST(req: Request, { params }: RouteParams) {
  const { workspaceId } = await params;
  const auth = await requireWorkspaceMember(workspaceId);
  if (auth instanceof NextResponse) return auth;

  let body: { accountId?: string; docId?: string; accessHash?: string; fileReference?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "無效的請求內容" }, { status: 400 });
  }

  const { accountId, docId, accessHash, fileReference } = body;
  if (!accountId || !docId || !accessHash || !fileReference) {
    return NextResponse.json({ error: "accountId, docId, accessHash, fileReference 為必填" }, { status: 400 });
  }

  if (!INTERNAL_SECRET) {
    return NextResponse.json({ error: "bridge 未設定 INTERNAL_SECRET" }, { status: 500 });
  }

  try {
    const bridgeRes = await fetch(`${BRIDGE_URL}/download-sticker-thumb`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${INTERNAL_SECRET}`,
      },
      body: JSON.stringify({ accountId, docId, accessHash, fileReference }),
      signal: AbortSignal.timeout(20_000),
    });

    if (bridgeRes.status === 404) {
      return NextResponse.json({ error: "sticker not found" }, { status: 404 });
    }
    if (!bridgeRes.ok) {
      const errBody = await bridgeRes.text().catch(() => "");
      log.warn("bridge /download-sticker-thumb failed", {
        docId,
        status: bridgeRes.status,
        body: errBody.slice(0, 200),
      });
      return NextResponse.json({ error: "sticker 下載失敗" }, { status: 502 });
    }

    const imgBytes = await bridgeRes.arrayBuffer();
    return new Response(imgBytes, {
      status: 200,
      headers: {
        "Content-Type": "image/webp",
        "Cache-Control": "public,max-age=31536000,immutable",
      },
    });
  } catch (err) {
    log.warn("sticker-thumb bridge call failed", { docId, error: String(err).slice(0, 200) });
    return NextResponse.json({ error: "bridge 連線失敗" }, { status: 502 });
  }
}
