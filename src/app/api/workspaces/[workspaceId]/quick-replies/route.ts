import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireWorkspaceMember } from "@/lib/auth/middleware";
import { logAudit } from "@/lib/audit/logger";

type RouteParams = { params: Promise<{ workspaceId: string }> };

/**
 * 2026-05-21 TG parity — QuickReply Phase A(純 Switchboard 本地,未來 Phase B 才接 TG sync)。
 *
 * 範圍可見性規則:
 *   - PRIVATE:owner 本人才看得到/能改/能刪。
 *   - TEAM   :owner 所屬 Team 的成員可見;Team 沒設定 = 退化為 PRIVATE。
 *   - WORKSPACE:整個工作區 active member 可見。
 *
 * 為什麼不直接接 TG `messages.GetQuickReplies`:Phase A 先讓員工有本地 SOP 庫
 * (跨裝置以 Switchboard 為單一真相)。Phase B 再做 TG 雙向同步(messages.GetQuickReplies
 * 拉、EditQuickReplyShortcut 推)。要求 TG Premium 帳號才有 server-side shortcut,
 * 不是所有員工帳號都符合,所以 Switchboard local-first 是更穩的基底。
 *
 * GET    /api/workspaces/[ws]/quick-replies?scope=all|private|team|workspace
 * POST   /api/workspaces/[ws]/quick-replies  body: { shortcut, title, body, scope?, tags?, sortOrder? }
 */

const VALID_SCOPES = ["PRIVATE", "TEAM", "WORKSPACE"] as const;
type Scope = (typeof VALID_SCOPES)[number];

export async function GET(req: Request, { params }: RouteParams) {
  const { workspaceId } = await params;
  const auth = await requireWorkspaceMember(workspaceId);
  if (auth instanceof NextResponse) return auth;

  const url = new URL(req.url);
  const scopeFilter = url.searchParams.get("scope");

  // 找出此 user 所屬 Teams 的 member 集合(供 TEAM scope 過濾)
  const myTeamIds = (
    await prisma.teamMembership.findMany({
      where: { userId: auth.userId, team: { workspaceId } },
      select: { teamId: true },
    })
  ).map((m) => m.teamId);
  // owner 也算自己 team 的成員(supervisor 不一定加進 TeamMembership)
  const supervisedTeamIds = (
    await prisma.team.findMany({
      where: { workspaceId, supervisorUserId: auth.userId, isActive: true },
      select: { id: true },
    })
  ).map((t) => t.id);
  const visibleTeamIds = Array.from(new Set([...myTeamIds, ...supervisedTeamIds]));

  // 一個快速 owner→team 對照表 — 拿來判 TEAM scope 的「owner 跟我同 team」
  // 直接用 Prisma 的 OR 表達式比 in-app filter 簡單。
  const where = {
    workspaceId,
    OR: [
      // PRIVATE — 自己擁有
      { scope: "PRIVATE" as Scope, ownerUserId: auth.userId },
      // WORKSPACE — 全部成員可見
      { scope: "WORKSPACE" as Scope },
      // TEAM — owner 跟我至少同一個 team(以 TeamMembership join 看 owner 的 teams)
      visibleTeamIds.length > 0
        ? {
            scope: "TEAM" as Scope,
            owner: {
              teamMemberships: {
                some: { teamId: { in: visibleTeamIds } },
              },
            },
          }
        : { id: "__never_match__" }, // 沒 team → TEAM scope 看不到
    ],
    ...(scopeFilter && VALID_SCOPES.includes(scopeFilter as Scope)
      ? { scope: scopeFilter as Scope }
      : {}),
  };

  const replies = await prisma.quickReply.findMany({
    where,
    orderBy: [{ sortOrder: "asc" }, { shortcut: "asc" }],
    select: {
      id: true,
      shortcut: true,
      title: true,
      body: true,
      scope: true,
      tags: true,
      sortOrder: true,
      ownerUserId: true,
      owner: { select: { displayName: true } },
      createdAt: true,
      updatedAt: true,
    },
  });

  return NextResponse.json({
    quickReplies: replies.map((r) => ({
      id: r.id,
      shortcut: r.shortcut,
      title: r.title,
      body: r.body,
      scope: r.scope,
      tags: r.tags,
      sortOrder: r.sortOrder,
      ownerUserId: r.ownerUserId,
      ownerName: r.owner?.displayName ?? null,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    })),
  });
}

export async function POST(req: Request, { params }: RouteParams) {
  const { workspaceId } = await params;
  const auth = await requireWorkspaceMember(workspaceId);
  if (auth instanceof NextResponse) return auth;

  let body: {
    shortcut?: string;
    title?: string;
    body?: string;
    scope?: Scope;
    tags?: string[];
    sortOrder?: number;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "無效的請求內容" }, { status: 400 });
  }

  // shortcut 規格:1~32 字、不含空白。TG client 端的 / 觸發前綴在 UI 加,
  // schema 不存 /。title 32 內,body <= 4096(TG message 上限對齊)。
  const shortcut = (body.shortcut ?? "").trim();
  const title = (body.title ?? "").trim();
  const text = body.body ?? "";
  if (!shortcut || /\s/.test(shortcut) || shortcut.length > 32) {
    return NextResponse.json(
      { error: "shortcut 為必填,不含空白且 <= 32 字元" },
      { status: 400 },
    );
  }
  if (!title || title.length > 64) {
    return NextResponse.json({ error: "title 為必填且 <= 64 字元" }, { status: 400 });
  }
  if (!text || text.length > 4096) {
    return NextResponse.json({ error: "body 為必填且 <= 4096 字元" }, { status: 400 });
  }
  const scope: Scope =
    body.scope && VALID_SCOPES.includes(body.scope) ? body.scope : "PRIVATE";

  // PRIVATE / TEAM 必定要有 owner;WORKSPACE 也綁 owner(誰建的就誰擁有改/刪權限)
  const created = await prisma.quickReply.create({
    data: {
      workspaceId,
      ownerUserId: auth.userId,
      scope,
      shortcut,
      title,
      body: text,
      tags: Array.isArray(body.tags)
        ? body.tags.filter((t) => typeof t === "string").slice(0, 20)
        : [],
      sortOrder: typeof body.sortOrder === "number" ? body.sortOrder : 0,
    },
  });

  await logAudit({
    workspaceId,
    userId: auth.userId,
    action: "quick_reply.create",
    entityType: "QuickReply",
    entityId: created.id,
    details: { shortcut, scope, titleLen: title.length, bodyLen: text.length },
  });

  return NextResponse.json({ success: true, quickReply: created });
}
