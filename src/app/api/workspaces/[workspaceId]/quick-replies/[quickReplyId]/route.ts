import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireWorkspaceMember } from "@/lib/auth/middleware";
import { logAudit } from "@/lib/audit/logger";

type RouteParams = {
  params: Promise<{ workspaceId: string; quickReplyId: string }>;
};

const VALID_SCOPES = ["PRIVATE", "TEAM", "WORKSPACE"] as const;
type Scope = (typeof VALID_SCOPES)[number];

/**
 * PATCH / DELETE 個別 QuickReply。
 *
 * 編輯 / 刪除權限:
 *   - owner 本人  → 都可以
 *   - admin       → 都可以(canManageWorkspaceSettings)
 *   - 其他人      → 不可以(即使是 WORKSPACE scope 看得到的)
 *
 * 沒給管理者「集體裁判」權,是怕「我的 SOP 草稿」被別人改掉。
 * 真的要批改別人的內容,複製一份新建,不在這層 layer。
 */

async function findOwned(workspaceId: string, quickReplyId: string) {
  return prisma.quickReply.findFirst({
    where: { id: quickReplyId, workspaceId },
  });
}

export async function PATCH(req: Request, { params }: RouteParams) {
  const { workspaceId, quickReplyId } = await params;
  const auth = await requireWorkspaceMember(workspaceId);
  if (auth instanceof NextResponse) return auth;

  const existing = await findOwned(workspaceId, quickReplyId);
  if (!existing) {
    return NextResponse.json({ error: "找不到快選回覆" }, { status: 404 });
  }
  const isOwner = existing.ownerUserId === auth.userId;
  const isAdmin = auth.isSystemAdmin || auth.permissions.canEditWorkspaceSettings;
  if (!isOwner && !isAdmin) {
    return NextResponse.json({ error: "無權編輯此快選回覆" }, { status: 403 });
  }

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

  const data: Partial<{
    shortcut: string;
    title: string;
    body: string;
    scope: Scope;
    tags: string[];
    sortOrder: number;
  }> = {};

  if (body.shortcut != null) {
    const s = String(body.shortcut).trim();
    if (!s || /\s/.test(s) || s.length > 32) {
      return NextResponse.json(
        { error: "shortcut 必填,不含空白且 <= 32 字元" },
        { status: 400 },
      );
    }
    data.shortcut = s;
  }
  if (body.title != null) {
    const t = String(body.title).trim();
    if (!t || t.length > 64) {
      return NextResponse.json({ error: "title <= 64 字元" }, { status: 400 });
    }
    data.title = t;
  }
  if (body.body != null) {
    if (typeof body.body !== "string" || body.body.length === 0 || body.body.length > 4096) {
      return NextResponse.json({ error: "body 必填且 <= 4096 字元" }, { status: 400 });
    }
    data.body = body.body;
  }
  if (body.scope && VALID_SCOPES.includes(body.scope)) data.scope = body.scope;
  if (Array.isArray(body.tags)) {
    data.tags = body.tags.filter((t) => typeof t === "string").slice(0, 20);
  }
  if (typeof body.sortOrder === "number") data.sortOrder = body.sortOrder;

  if (Object.keys(data).length === 0) {
    return NextResponse.json({ error: "沒有可更新的欄位" }, { status: 400 });
  }

  const updated = await prisma.quickReply.update({
    where: { id: quickReplyId },
    data,
  });

  await logAudit({
    workspaceId,
    userId: auth.userId,
    action: "quick_reply.update",
    entityType: "QuickReply",
    entityId: quickReplyId,
    details: { changedKeys: Object.keys(data) },
  });

  return NextResponse.json({ success: true, quickReply: updated });
}

export async function DELETE(_req: Request, { params }: RouteParams) {
  const { workspaceId, quickReplyId } = await params;
  const auth = await requireWorkspaceMember(workspaceId);
  if (auth instanceof NextResponse) return auth;

  const existing = await findOwned(workspaceId, quickReplyId);
  if (!existing) {
    return NextResponse.json({ error: "找不到快選回覆" }, { status: 404 });
  }
  const isOwner = existing.ownerUserId === auth.userId;
  const isAdmin = auth.isSystemAdmin || auth.permissions.canEditWorkspaceSettings;
  if (!isOwner && !isAdmin) {
    return NextResponse.json({ error: "無權刪除此快選回覆" }, { status: 403 });
  }

  await prisma.quickReply.delete({ where: { id: quickReplyId } });

  await logAudit({
    workspaceId,
    userId: auth.userId,
    action: "quick_reply.delete",
    entityType: "QuickReply",
    entityId: quickReplyId,
    details: {
      shortcut: existing.shortcut,
      scope: existing.scope,
      ownerUserId: existing.ownerUserId,
    },
  });

  return NextResponse.json({ success: true });
}
