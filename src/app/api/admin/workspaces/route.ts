import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireSystemAdmin } from "@/lib/auth/middleware";

// GET /api/admin/workspaces - List ALL workspaces (admin sees all)
export async function GET() {
  const auth = await requireSystemAdmin();
  if (auth instanceof NextResponse) return auth;

  const workspaces = await prisma.workspace.findMany({
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      name: true,
      slug: true,
      isActive: true,
      createdAt: true,
      updatedAt: true,
      _count: {
        select: { memberships: { where: { isActive: true } } },
      },
    },
  });

  return NextResponse.json({
    workspaces: workspaces.map((w) => ({
      id: w.id,
      name: w.name,
      slug: w.slug,
      isActive: w.isActive,
      createdAt: w.createdAt,
      updatedAt: w.updatedAt,
      memberCount: w._count.memberships,
    })),
  });
}
