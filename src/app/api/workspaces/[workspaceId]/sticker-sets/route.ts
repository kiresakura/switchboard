import { NextResponse } from "next/server";
import { requireWorkspaceMember } from "@/lib/auth/middleware";
import { logger } from "@/lib/logger";

const log = logger("StickerSets");

const BRIDGE_URL = process.env.BRIDGE_URL || `http://localhost:${process.env.BRIDGE_PORT || 3001}`;
const INTERNAL_SECRET = process.env.INTERNAL_SECRET;

type RouteParams = {
  params: Promise<{ workspaceId: string }>;
};

/**
 * GET /api/workspaces/:wid/sticker-sets?accountId=xxx
 *
 * List saved sticker sets for the given TG account.
 * Proxies to bridge GET /sticker-sets/:accountId.
 *
 * Auth: any workspace member.
 */
export async function GET(req: Request, { params }: RouteParams) {
  const { workspaceId } = await params;
  const auth = await requireWorkspaceMember(workspaceId);
  if (auth instanceof NextResponse) return auth;

  const url = new URL(req.url);
  const accountId = url.searchParams.get("accountId");
  if (!accountId) {
    return NextResponse.json({ error: "accountId is required" }, { status: 400 });
  }

  if (!INTERNAL_SECRET) {
    return NextResponse.json({ error: "bridge 未設定 INTERNAL_SECRET" }, { status: 500 });
  }

  try {
    const bridgeRes = await fetch(`${BRIDGE_URL}/sticker-sets/${encodeURIComponent(accountId)}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${INTERNAL_SECRET}`,
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!bridgeRes.ok) {
      const errBody = await bridgeRes.text().catch(() => "");
      log.warn("bridge /sticker-sets failed", {
        accountId,
        status: bridgeRes.status,
        body: errBody.slice(0, 200),
      });
      return NextResponse.json({ error: "sticker sets 取得失敗" }, { status: 502 });
    }
    const data = (await bridgeRes.json()) as { sets: unknown[] };
    return NextResponse.json(data);
  } catch (err) {
    log.warn("sticker-sets bridge call failed", { accountId, error: String(err).slice(0, 200) });
    return NextResponse.json({ error: "bridge 連線失敗" }, { status: 502 });
  }
}
