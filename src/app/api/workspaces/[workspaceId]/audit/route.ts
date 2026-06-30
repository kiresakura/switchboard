import { NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { requireWorkspaceMember } from "@/lib/auth/middleware";

type RouteParams = { params: Promise<{ workspaceId: string }> };

// GET /api/workspaces/:id/audit
// Query params:
//   page        — pagination page (1-based, capped at 200)
//   limit       — page size (capped at 100)
//   entityType  — filter by AuditLog.entityType (exact match)
//   action      — filter by AuditLog.action (exact match, raw action code)
//   q           — search operator name (User.displayName or .username, substring, case-insensitive)
export async function GET(req: Request, { params }: RouteParams) {
  const { workspaceId } = await params;
  const auth = await requireWorkspaceMember(workspaceId);
  if (auth instanceof NextResponse) return auth;

  // Check audit log permissions
  const canViewAll = auth.permissions.canViewAllAuditLogs;
  const canViewOwn = auth.permissions.canViewOwnAuditLogs;

  if (!canViewAll && !canViewOwn) {
    return NextResponse.json({ error: "權限不足" }, { status: 403 });
  }

  const url = new URL(req.url);
  const page = Math.max(1, Math.min(parseInt(url.searchParams.get("page") || "1") || 1, 200));
  const limit = Math.max(1, Math.min(parseInt(url.searchParams.get("limit") || "50") || 50, 100));
  const entityType = url.searchParams.get("entityType");
  const action = url.searchParams.get("action");
  const q = url.searchParams.get("q")?.trim();

  const where: Prisma.AuditLogWhereInput = {
    workspaceId,
    ...(entityType ? { entityType } : {}),
    ...(action ? { action } : {}),
    // If user can only view own logs, force filter by their userId
    ...(!canViewAll && canViewOwn ? { userId: auth.userId } : {}),
    ...(q
      ? {
          user: {
            OR: [
              { displayName: { contains: q, mode: "insensitive" } },
              { username: { contains: q, mode: "insensitive" } },
            ],
          },
        }
      : {}),
  };

  const [logs, total] = await Promise.all([
    prisma.auditLog.findMany({
      where,
      include: {
        user: { select: { displayName: true, username: true } },
      },
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.auditLog.count({ where }),
  ]);

  return NextResponse.json({
    logs,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  });
}
