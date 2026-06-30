import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import {
  requireWorkspaceMember,
  requireWorkspacePermission,
} from "@/lib/auth/middleware";

type RouteParams = { params: Promise<{ workspaceId: string }> };

export interface WorkspaceMenuConfig {
  showMute: boolean;
  showClear: boolean;
  showDelete: boolean;
}

export interface WorkspaceUiConfig {
  menuConfig: WorkspaceMenuConfig;
}

function parseUiConfig(raw: unknown): WorkspaceUiConfig {
  const obj =
    raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const mc =
    obj.menuConfig && typeof obj.menuConfig === "object"
      ? (obj.menuConfig as Record<string, unknown>)
      : {};
  return {
    menuConfig: {
      showMute: mc.showMute === true,
      showClear: mc.showClear === true,
      showDelete: mc.showDelete === true,
    },
  };
}

// GET /api/workspaces/:id/ui-config
// Any authenticated workspace member can read (needed by direct-chat to render menus).
export async function GET(_req: Request, { params }: RouteParams) {
  const { workspaceId } = await params;
  const auth = await requireWorkspaceMember(workspaceId);
  if (auth instanceof NextResponse) return auth;

  const ws = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { uiConfig: true },
  });
  if (!ws) return NextResponse.json({ error: "Not found" }, { status: 404 });

  return NextResponse.json({ uiConfig: parseUiConfig(ws.uiConfig) });
}

// PATCH /api/workspaces/:id/ui-config
// Only workspace admins (canEditWorkspaceSettings) or system admins may write.
export async function PATCH(req: Request, { params }: RouteParams) {
  const { workspaceId } = await params;
  const auth = await requireWorkspacePermission(workspaceId, "canEditWorkspaceSettings");
  if (auth instanceof NextResponse) return auth;

  const body = (await req.json()) as Partial<WorkspaceMenuConfig>;

  // Fetch current config and merge the patch.
  const ws = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { uiConfig: true },
  });
  if (!ws) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const current = parseUiConfig(ws.uiConfig).menuConfig;
  const updated: WorkspaceMenuConfig = {
    showMute: "showMute" in body ? !!body.showMute : current.showMute,
    showClear: "showClear" in body ? !!body.showClear : current.showClear,
    showDelete: "showDelete" in body ? !!body.showDelete : current.showDelete,
  };

  const newUiConfig: WorkspaceUiConfig = { menuConfig: updated };

  await prisma.workspace.update({
    where: { id: workspaceId },
    // Prisma accepts plain objects for Json fields; double-cast to satisfy strict types.
    data: { uiConfig: newUiConfig as unknown as Parameters<typeof prisma.workspace.update>[0]["data"]["uiConfig"] },
  });

  return NextResponse.json({ uiConfig: newUiConfig });
}
