import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireWorkspaceMember } from "@/lib/auth/middleware";
import { logger } from "@/lib/logger";

const log = logger("BackfillHistory");

const BRIDGE_URL =
  process.env.BRIDGE_URL || `http://localhost:${process.env.BRIDGE_PORT || 3001}`;
const INTERNAL_SECRET = process.env.INTERNAL_SECRET;

type RouteParams = {
  params: Promise<{ workspaceId: string; groupId: string }>;
};

/**
 * POST /api/workspaces/:wsId/groups/:groupId/backfill { limit? }
 *
 * 從 TG 補抓最近 N 則歷史訊息進 DirectChatMessage（dedupe by platformMessageId）。
 * 用途：剛綁帳號 / 之前停用過監聽 / 看不到舊對話 → 一鍵把 TG 上的訊息拉進 Switchboard。
 *
 * 限制：
 *   - 只抓純文字訊息（媒體 / sticker 之後再說）
 *   - limit 上限 500、預設 100
 *   - 必須有任一個 ACTIVE TG 帳號 + 該帳號在這個 group 裡 — 否則 bridge 抓不到
 */
export async function POST(req: Request, { params }: RouteParams) {
  const { workspaceId, groupId } = await params;
  // 補抓只是把 TG 既有歷史同步進 DB（idempotent），任何 workspace member
  // 都能觸發 — 不需要管理員權限。員工自動觸發 / 手動補抓皆走此路徑。
  const auth = await requireWorkspaceMember(workspaceId);
  if (auth instanceof NextResponse) return auth;

  let body: { limit?: number };
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  const limit = Math.min(Math.max(Number(body.limit) || 100, 1), 500);

  // 找 group + 在這個群裡的 active 帳號
  const group = await prisma.group.findFirst({
    where: { id: groupId, workspaceId },
    select: {
      id: true,
      title: true,
      platformGroupId: true,
      accountMemberships: {
        where: { account: { status: "ACTIVE" } },
        select: { account: { select: { id: true, displayName: true } } },
        take: 1,
      },
    },
  });
  if (!group || !group.platformGroupId) {
    return NextResponse.json({ error: "找不到群組" }, { status: 404 });
  }
  const account = group.accountMemberships[0]?.account;
  if (!account) {
    // 帳號未連線是「可預期的業務狀態」,不是伺服器/閘道故障。回 200 +
    // success:false,讓自動背景補抓靜默(不污染 console),手動補抓由
    // body.success 顯示提示。
    return NextResponse.json({
      success: false,
      inserted: 0,
      error: "此群組目前沒有 ACTIVE Telegram 帳號可用，請先連線一個帳號再補抓",
    });
  }

  try {
    const bridgeRes = await fetch(`${BRIDGE_URL}/backfill-history`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${INTERNAL_SECRET || ""}`,
      },
      body: JSON.stringify({
        accountId: account.id,
        chatId: group.platformGroupId,
        limit,
      }),
      // 補抓 500 則 + dedupe lookup × 500 → 給寬一點 timeout
      signal: AbortSignal.timeout(60_000),
    });
    if (!bridgeRes.ok) {
      const errBody = await bridgeRes.text().catch(() => "");
      log.warn("bridge /backfill-history failed", {
        status: bridgeRes.status,
        body: errBody.slice(0, 500),
      });
      // bridge 已經回傳結構化 JSON（含 code/meta）— 嘗試 parse，
      // parse 失敗才退回 raw text 截斷。
      let detail: string = errBody.slice(0, 200);
      try {
        const parsed = JSON.parse(errBody) as { error?: string; code?: string };
        if (parsed.error) {
          detail = parsed.code ? `[${parsed.code}] ${parsed.error}` : parsed.error;
        }
      } catch {}
      // bridge 的 4xx = 可預期的請求/帳號/狀態問題（帳號未綁、chat 不存在、
      // TG 端拒絕…），不是閘道故障。回 200 + success:false,讓自動背景補抓
      // 靜默、不污染 console;手動補抓由 body.success 顯示。只有 bridge 5xx
      // 才視為真正的 upstream 故障 → 502。
      if (bridgeRes.status >= 400 && bridgeRes.status < 500) {
        return NextResponse.json({
          success: false,
          inserted: 0,
          error: `補抓失敗：${detail}`,
        });
      }
      return NextResponse.json(
        { error: `Bridge 回應失敗（${bridgeRes.status}）：${detail}` },
        { status: 502 },
      );
    }
    const result = (await bridgeRes.json()) as {
      success?: boolean;
      inserted?: number;
      skipped?: number;
      mediaStored?: number;
      failed?: number;
      total?: number;
      firstFailure?: string;
      error?: string;
    };
    if (!result.success) {
      // bridge 連到了但回報補抓未成功 — 同屬可預期業務結果,非閘道故障。
      return NextResponse.json({
        success: false,
        inserted: 0,
        error: result.error || "補抓失敗",
      });
    }
    return NextResponse.json({
      success: true,
      inserted: result.inserted ?? 0,
      skipped: result.skipped ?? 0,
      mediaStored: result.mediaStored ?? 0,
      failed: result.failed ?? 0,
      total: result.total ?? 0,
      ...(result.firstFailure ? { firstFailure: result.firstFailure } : {}),
      accountUsed: account.displayName,
    });
  } catch (err) {
    log.error("backfill request to bridge failed", { error: String(err) });
    return NextResponse.json(
      { error: "Bridge 不可達 — 稍後再試" },
      { status: 503 },
    );
  }
}
