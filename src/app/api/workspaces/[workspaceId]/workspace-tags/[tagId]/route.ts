import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireWorkspaceMember } from "@/lib/auth/middleware";
import { logAudit } from "@/lib/audit/logger";

type RouteParams = {
  params: Promise<{ workspaceId: string; tagId: string }>;
};

const HEX = /^#[0-9a-fA-F]{6}$/;

/**
 * PATCH / DELETE 個別 WorkspaceTag —— 兩者都需 canEditWorkspaceSettings。
 *
 * 刪除只移除「詞彙」本身;已套用此字串的 Group.tags / Customer.tags 不會被動到
 * (那些是自由字串,與 WorkspaceTag 解耦)。
 */

export async function PATCH(req: Request, { params }: RouteParams) {
  const { workspaceId, tagId } = await params;
  const auth = await requireWorkspaceMember(workspaceId);
  if (auth instanceof NextResponse) return auth;
  if (!auth.isSystemAdmin && !auth.permissions.canEditWorkspaceSettings) {
    return NextResponse.json({ error: "無權管理工作區標籤" }, { status: 403 });
  }

  const existing = await prisma.workspaceTag.findFirst({
    where: { id: tagId, workspaceId },
  });
  if (!existing) {
    return NextResponse.json({ error: "找不到標籤" }, { status: 404 });
  }

  let body: { name?: string; color?: string | null; sortOrder?: number };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "無效的請求內容" }, { status: 400 });
  }

  const data: Partial<{ name: string; color: string | null; sortOrder: number }> =
    {};

  if (body.name != null) {
    const name = String(body.name).trim();
    if (!name || name.length > 32) {
      return NextResponse.json(
        { error: "標籤名稱為必填且 ≤ 32 字元" },
        { status: 400 },
      );
    }
    if (name !== existing.name) {
      const dup = await prisma.workspaceTag.findFirst({
        where: { workspaceId, name, id: { not: tagId } },
        select: { id: true },
      });
      if (dup) {
        return NextResponse.json({ error: "已存在同名標籤" }, { status: 409 });
      }
    }
    data.name = name;
  }
  if (body.color !== undefined) {
    data.color =
      typeof body.color === "string" && HEX.test(body.color) ? body.color : null;
  }
  if (typeof body.sortOrder === "number") data.sortOrder = body.sortOrder;

  if (Object.keys(data).length === 0) {
    return NextResponse.json({ error: "沒有可更新的欄位" }, { status: 400 });
  }

  const updated = await prisma.workspaceTag.update({
    where: { id: tagId },
    data,
  });

  await logAudit({
    workspaceId,
    userId: auth.userId,
    action: "workspace_tag.update",
    entityType: "WorkspaceTag",
    entityId: tagId,
    details: { changedKeys: Object.keys(data) },
  });

  return NextResponse.json({ success: true, tag: updated });
}

export async function DELETE(_req: Request, { params }: RouteParams) {
  const { workspaceId, tagId } = await params;
  const auth = await requireWorkspaceMember(workspaceId);
  if (auth instanceof NextResponse) return auth;
  if (!auth.isSystemAdmin && !auth.permissions.canEditWorkspaceSettings) {
    return NextResponse.json({ error: "無權管理工作區標籤" }, { status: 403 });
  }

  const existing = await prisma.workspaceTag.findFirst({
    where: { id: tagId, workspaceId },
  });
  if (!existing) {
    return NextResponse.json({ error: "找不到標籤" }, { status: 404 });
  }

  await prisma.workspaceTag.delete({ where: { id: tagId } });

  await logAudit({
    workspaceId,
    userId: auth.userId,
    action: "workspace_tag.delete",
    entityType: "WorkspaceTag",
    entityId: tagId,
    details: { name: existing.name },
  });

  return NextResponse.json({ success: true });
}
