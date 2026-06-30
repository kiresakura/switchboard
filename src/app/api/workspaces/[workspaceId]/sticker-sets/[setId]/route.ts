import { NextResponse } from "next/server";
import { requireWorkspaceMember } from "@/lib/auth/middleware";
import { logger } from "@/lib/logger";

const log = logger("StickerSetStickers");

const BRIDGE_URL = process.env.BRIDGE_URL || `http://localhost:${process.env.BRIDGE_PORT || 3001}`;
const INTERNAL_SECRET = process.env.INTERNAL_SECRET;

type RouteParams = {
  params: Promise<{ workspaceId: string; setId: string }>;
};

/**
 * GET /api/workspaces/:wid/sticker-sets/:setId?accountId=xxx&accessHash=yyy
 *
 * List stickers inside a specific sticker set.
 * Proxies to bridge GET /sticker-sets/:accountId/:setId?accessHash=yyy.
 *
 * Auth: any workspace member.
 */
export async function GET(req: Request, { params }: RouteParams) {
  const { workspaceId, setId } = await params;
  const auth = await requireWorkspaceMember(workspaceId);
  if (auth instanceof NextResponse) return auth;

  const url = new URL(req.url);
  const accountId = url.searchParams.get("accountId");
  const accessHash = url.searchParams.get("accessHash");

  if (!accountId || !accessHash) {
    return NextResponse.json({ error: "accountId and accessHash are required" }, { status: 400 });
  }

  if (!INTERNAL_SECRET) {
    return NextResponse.json({ error: "bridge 未設定 INTERNAL_SECRET" }, { status: 500 });
  }

  try {
    const bridgeUrl = `${BRIDGE_URL}/sticker-sets/${encodeURIComponent(accountId)}/${encodeURIComponent(setId)}?accessHash=${encodeURIComponent(accessHash)}`;
    const bridgeRes = await fetch(bridgeUrl, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${INTERNAL_SECRET}`,
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!bridgeRes.ok) {
      const errBody = await bridgeRes.text().catch(() => "");
      log.warn("bridge /sticker-sets/:setId failed", {
        accountId,
        setId,
        status: bridgeRes.status,
        body: errBody.slice(0, 200),
      });
      return NextResponse.json({ error: "sticker set 內容取得失敗" }, { status: 502 });
    }
    const data = (await bridgeRes.json()) as { stickers: unknown[] };
    return NextResponse.json(data);
  } catch (err) {
    log.warn("sticker-set-stickers bridge call failed", {
      accountId,
      setId,
      error: String(err).slice(0, 200),
    });
    return NextResponse.json({ error: "bridge 連線失敗" }, { status: 502 });
  }
}
