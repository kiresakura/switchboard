import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireWorkspacePermission } from "@/lib/auth/middleware";
import { logger } from "@/lib/logger";

const log = logger("AccountAuthorizations");

const BRIDGE_URL =
  process.env.BRIDGE_URL ||
  `http://localhost:${process.env.BRIDGE_PORT || 3001}`;
const INTERNAL_SECRET = process.env.INTERNAL_SECRET;

type RouteParams = {
  params: Promise<{ workspaceId: string; accountId: string }>;
};

/**
 * 2026-05-21 Batch 4 — 多裝置監測。
 *
 * GET    /api/workspaces/:ws/accounts/:accountId/authorizations
 *   → { authorizations: [...] }  此 TG 帳號目前登入的所有裝置 / session
 * DELETE /api/workspaces/:ws/accounts/:accountId/authorizations?hash=<hash>
 *   → { success }  遠端登出指定裝置
 *
 * 實際的 TG API 呼叫(account.getAuthorizations / resetAuthorization)在 bridge
 * worker 內,因為連線中的 GramJS client 由 bridge 持有。此路由只做 auth + 轉發。
 */

export async function GET(_req: Request, { params }: RouteParams) {
  const { workspaceId, accountId } = await params;
  const auth = await requireWorkspacePermission(
    workspaceId,
    "canManageCommunicationAccounts",
  );
  if (auth instanceof NextResponse) return auth;

  if (!INTERNAL_SECRET) {
    return NextResponse.json(
      { error: "bridge 未設定 INTERNAL_SECRET" },
      { status: 500 },
    );
  }

  const account = await prisma.communicationAccount.findFirst({
    where: { id: accountId, workspaceId, platform: "telegram" },
    select: { id: true },
  });
  if (!account) {
    return NextResponse.json({ error: "找不到此帳號" }, { status: 404 });
  }

  try {
    const bridgeRes = await fetch(`${BRIDGE_URL}/get-authorizations`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${INTERNAL_SECRET}`,
      },
      body: JSON.stringify({ accountId }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!bridgeRes.ok) {
      const errBody = await bridgeRes.text().catch(() => "");
      log.warn("bridge /get-authorizations failed", {
        accountId,
        status: bridgeRes.status,
        body: errBody.slice(0, 200),
      });
      return NextResponse.json(
        { error: "無法從 bridge 取得裝置列表" },
        { status: 502 },
      );
    }
    const result = (await bridgeRes.json()) as {
      authorizations?: unknown[];
      error?: string;
    };
    // bridge 回 error(例:帳號未連線)→ 200 帶 error,前端顯示提示而非當機。
    if (result.error) {
      return NextResponse.json({ authorizations: [], error: result.error });
    }
    return NextResponse.json({
      authorizations: Array.isArray(result.authorizations)
        ? result.authorizations
        : [],
    });
  } catch (err) {
    log.warn("get-authorizations bridge call failed", {
      accountId,
      error: String(err).slice(0, 200),
    });
    return NextResponse.json(
      { error: "bridge 無回應(可能未啟動)" },
      { status: 502 },
    );
  }
}

export async function DELETE(req: Request, { params }: RouteParams) {
  const { workspaceId, accountId } = await params;
  const auth = await requireWorkspacePermission(
    workspaceId,
    "canManageCommunicationAccounts",
  );
  if (auth instanceof NextResponse) return auth;

  if (!INTERNAL_SECRET) {
    return NextResponse.json(
      { error: "bridge 未設定 INTERNAL_SECRET" },
      { status: 500 },
    );
  }

  const hash = new URL(req.url).searchParams.get("hash");
  if (!hash) {
    return NextResponse.json({ error: "缺少 hash 參數" }, { status: 400 });
  }

  const account = await prisma.communicationAccount.findFirst({
    where: { id: accountId, workspaceId, platform: "telegram" },
    select: { id: true },
  });
  if (!account) {
    return NextResponse.json({ error: "找不到此帳號" }, { status: 404 });
  }

  try {
    const bridgeRes = await fetch(`${BRIDGE_URL}/reset-authorization`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${INTERNAL_SECRET}`,
      },
      body: JSON.stringify({ accountId, hash }),
      signal: AbortSignal.timeout(15_000),
    });
    const result = (await bridgeRes.json().catch(() => ({}))) as {
      success?: boolean;
      error?: string;
    };
    if (!bridgeRes.ok || result.error || result.success === false) {
      return NextResponse.json(
        { error: result.error || "登出該裝置失敗" },
        { status: bridgeRes.ok ? 400 : 502 },
      );
    }

    await prisma.auditLog.create({
      data: {
        workspaceId,
        userId: auth.userId,
        action: "RESET_TELEGRAM_AUTHORIZATION",
        entityType: "CommunicationAccount",
        entityId: accountId,
        details: { hash },
      },
    });

    return NextResponse.json({ success: true });
  } catch (err) {
    log.warn("reset-authorization bridge call failed", {
      accountId,
      error: String(err).slice(0, 200),
    });
    return NextResponse.json(
      { error: "bridge 無回應(可能未啟動)" },
      { status: 502 },
    );
  }
}
