import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireWorkspaceMember } from "@/lib/auth/middleware";
import { logAudit } from "@/lib/audit/logger";

type RouteParams = { params: Promise<{ workspaceId: string }> };

/**
 * WorkspaceTag — 工作區標籤詞彙表的 CRUD(2026-05-21 Batch 3)。
 *
 * WorkspaceTag 是「標籤主資料」:工作區層級的一份共用標籤清單。對話 / 客戶身上
 * 套用的 tags 仍是自由字串陣列(Group.tags / Customer.tags)以保相容 —— 這個頁面
 * 管理的是「可選的詞彙」,不是直接改某個對話的標籤。
 *
 * GET  : 任何成員可讀(要套標籤就得先看得到有哪些詞彙)。
 * POST : 需 canEditWorkspaceSettings —— 標籤是共用詞彙,不讓每個人各加各的。
 */

const HEX = /^#[0-9a-fA-F]{6}$/;

export async function GET(_req: Request, { params }: RouteParams) {
  const { workspaceId } = await params;
  const auth = await requireWorkspaceMember(workspaceId);
  if (auth instanceof NextResponse) return auth;

  const tags = await prisma.workspaceTag.findMany({
    where: { workspaceId },
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    select: { id: true, name: true, color: true, sortOrder: true, createdAt: true },
  });

  return NextResponse.json({
    tags: tags.map((t) => ({
      id: t.id,
      name: t.name,
      color: t.color,
      sortOrder: t.sortOrder,
      createdAt: t.createdAt.toISOString(),
    })),
  });
}

export async function POST(req: Request, { params }: RouteParams) {
  const { workspaceId } = await params;
  const auth = await requireWorkspaceMember(workspaceId);
  if (auth instanceof NextResponse) return auth;
  if (!auth.isSystemAdmin && !auth.permissions.canEditWorkspaceSettings) {
    return NextResponse.json({ error: "無權管理工作區標籤" }, { status: 403 });
  }

  let body: { name?: string; color?: string | null; sortOrder?: number };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "無效的請求內容" }, { status: 400 });
  }

  const name = (body.name ?? "").trim();
  if (!name || name.length > 32) {
    return NextResponse.json(
      { error: "標籤名稱為必填且 ≤ 32 字元" },
      { status: 400 },
    );
  }
  const color =
    typeof body.color === "string" && HEX.test(body.color) ? body.color : null;

  // @@unique([workspaceId, name]) — 先查撞名給友善訊息
  const dup = await prisma.workspaceTag.findFirst({
    where: { workspaceId, name },
    select: { id: true },
  });
  if (dup) {
    return NextResponse.json({ error: "已存在同名標籤" }, { status: 409 });
  }

  const created = await prisma.workspaceTag.create({
    data: {
      workspaceId,
      name,
      color,
      sortOrder: typeof body.sortOrder === "number" ? body.sortOrder : 0,
    },
  });

  await logAudit({
    workspaceId,
    userId: auth.userId,
    action: "workspace_tag.create",
    entityType: "WorkspaceTag",
    entityId: created.id,
    details: { name, color },
  });

  return NextResponse.json({ success: true, tag: created });
}
