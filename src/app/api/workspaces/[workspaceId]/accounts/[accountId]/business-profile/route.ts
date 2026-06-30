import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireWorkspacePermission } from "@/lib/auth/middleware";
import { resolveVisibleAccountIds } from "@/lib/account-visibility";
import { logAudit } from "@/lib/audit/logger";
import { logger } from "@/lib/logger";

const log = logger("BusinessProfile");

type RouteParams = {
  params: Promise<{ workspaceId: string; accountId: string }>;
};

const BRIDGE_URL = process.env.BRIDGE_URL || `http://localhost:${process.env.BRIDGE_PORT || 3001}`;
const INTERNAL_SECRET = process.env.INTERNAL_SECRET;

/**
 * 2026-05-21 TG Business Phase B(round 4):BusinessProfile per-account CRUD。
 *
 * GET    /api/workspaces/[ws]/accounts/[acc]/business-profile
 * PATCH  body: { awayMessage?, greetingMessage?, workHours?, workHoursUtcOffset?, isEnabled? }
 *
 * 設計:
 *   - 一個 CommunicationAccount 一筆 row(unique on accountId)
 *   - PATCH 立刻持久化 Switchboard;同時 best-effort push 到 TG(透過 bridge endpoints)
 *   - TG push 失敗(非 Premium / 帳號離線 / network)→ Switchboard 還是存,UI 顯示「未同步」狀態
 *   - 推到 TG 成功才更新 lastSyncedAt
 *
 * 權限:呼叫者必須能看到此 account(account-visibility);改 business 設定也是
 * 該 account 的所有人 / supervisor / admin 才有權,這裡共享 canDelegateAccounts
 * 跟 canManageCommunicationAccounts(任一即可)。
 */
export async function GET(_req: Request, { params }: RouteParams) {
  const { workspaceId, accountId } = await params;
  const auth = await requireWorkspacePermission(workspaceId);
  if (auth instanceof NextResponse) return auth;

  const visible = await resolveVisibleAccountIds({
    userId: auth.userId,
    workspaceId,
    isSystemAdmin: auth.isSystemAdmin,
    permissions: auth.permissions,
  });
  if (!visible.has(accountId)) {
    return NextResponse.json({ error: "無權查看此帳號" }, { status: 403 });
  }

  const account = await prisma.communicationAccount.findFirst({
    where: { id: accountId, workspaceId },
    select: { id: true, businessProfile: true },
  });
  if (!account) {
    return NextResponse.json({ error: "找不到帳號" }, { status: 404 });
  }
  return NextResponse.json({ profile: account.businessProfile });
}

export async function PATCH(req: Request, { params }: RouteParams) {
  const { workspaceId, accountId } = await params;
  const auth = await requireWorkspacePermission(workspaceId);
  if (auth instanceof NextResponse) return auth;

  // 需要 canManageCommunicationAccounts 或 admin;一般員工不該改別人的 Business 設定。
  if (
    !auth.isSystemAdmin &&
    !auth.permissions.canManageCommunicationAccounts &&
    !auth.permissions.canDelegateAccounts
  ) {
    return NextResponse.json({ error: "權限不足" }, { status: 403 });
  }

  let body: {
    awayMessage?: string | null;
    awayMessageSchedule?: "always" | "outside_work_hours" | "manual" | null;
    greetingMessage?: string | null;
    greetingInactivityDays?: number | null;
    workHours?: Array<{ startMinute: number; endMinute: number }> | null;
    workHoursUtcOffset?: number | null;
    isEnabled?: boolean;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "無效的請求內容" }, { status: 400 });
  }

  const account = await prisma.communicationAccount.findFirst({
    where: { id: accountId, workspaceId },
    select: { id: true, status: true },
  });
  if (!account) {
    return NextResponse.json({ error: "找不到帳號" }, { status: 404 });
  }

  // Upsert profile
  const updated = await prisma.businessProfile.upsert({
    where: { accountId },
    create: {
      accountId,
      awayMessage: body.awayMessage ?? null,
      awayMessageSchedule: body.awayMessageSchedule ?? "outside_work_hours",
      greetingMessage: body.greetingMessage ?? null,
      greetingInactivityDays: body.greetingInactivityDays ?? 7,
      workHours: body.workHours ? JSON.parse(JSON.stringify(body.workHours)) : null,
      workHoursUtcOffset: body.workHoursUtcOffset ?? null,
      isEnabled: body.isEnabled ?? true,
    },
    update: {
      ...(body.awayMessage !== undefined ? { awayMessage: body.awayMessage } : {}),
      ...(body.awayMessageSchedule !== undefined
        ? { awayMessageSchedule: body.awayMessageSchedule }
        : {}),
      ...(body.greetingMessage !== undefined
        ? { greetingMessage: body.greetingMessage }
        : {}),
      ...(body.greetingInactivityDays !== undefined
        ? { greetingInactivityDays: body.greetingInactivityDays }
        : {}),
      ...(body.workHours !== undefined
        ? { workHours: body.workHours ? JSON.parse(JSON.stringify(body.workHours)) : null }
        : {}),
      ...(body.workHoursUtcOffset !== undefined
        ? { workHoursUtcOffset: body.workHoursUtcOffset }
        : {}),
      ...(body.isEnabled !== undefined ? { isEnabled: body.isEnabled } : {}),
    },
  });

  // Best-effort push 到 TG(只在 isEnabled + ACTIVE 時推)
  let syncedAt: Date | null = null;
  if (
    updated.isEnabled &&
    account.status === "ACTIVE" &&
    INTERNAL_SECRET
  ) {
    const pushes: Array<{ kind: string; payload: Record<string, unknown> }> = [];
    if (body.awayMessage !== undefined) {
      pushes.push({ kind: "away", payload: { text: body.awayMessage } });
    }
    if (body.greetingMessage !== undefined) {
      pushes.push({ kind: "greeting", payload: { text: body.greetingMessage } });
    }
    if (body.workHours !== undefined) {
      pushes.push({
        kind: "work-hours",
        payload: {
          hours: body.workHours,
          utcOffsetMinutes: body.workHoursUtcOffset ?? 480,
        },
      });
    }
    let allOk = true;
    for (const p of pushes) {
      try {
        const r = await fetch(`${BRIDGE_URL}/tg-business/profile`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${INTERNAL_SECRET}`,
          },
          body: JSON.stringify({ accountId, kind: p.kind, ...p.payload }),
          signal: AbortSignal.timeout(15_000),
        });
        if (!r.ok) {
          allOk = false;
          const errBody = await r.text().catch(() => "");
          log.warn("bridge /tg-business/profile rejected", {
            accountId,
            kind: p.kind,
            status: r.status,
            body: errBody.slice(0, 200),
          });
        }
      } catch (err) {
        allOk = false;
        log.warn("bridge /tg-business/profile call failed", {
          accountId,
          kind: p.kind,
          err: String(err).slice(0, 200),
        });
      }
    }
    if (allOk && pushes.length > 0) {
      syncedAt = new Date();
      await prisma.businessProfile.update({
        where: { accountId },
        data: { lastSyncedAt: syncedAt },
      });
    }
  }

  await logAudit({
    workspaceId,
    userId: auth.userId,
    action: "business_profile.update",
    entityType: "BusinessProfile",
    entityId: updated.id,
    details: {
      accountId,
      changedKeys: Object.keys(body),
      tgSynced: !!syncedAt,
    },
  });

  return NextResponse.json({
    profile: { ...updated, lastSyncedAt: syncedAt ?? updated.lastSyncedAt },
    tgSynced: !!syncedAt,
  });
}
