import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireWorkspaceMember, type WorkspaceContext } from "@/lib/auth/middleware";
import { resolveVisibleAccountIds } from "@/lib/account-visibility";
import { logAudit } from "@/lib/audit/logger";
import { DEFAULT_SLA_CONFIG, isConversationOverdue, normalizeSlaConfig } from "@/lib/conversation/sla";

const SLA_CONFIG_KEY = "slaConfig";

type RouteParams = { params: Promise<{ workspaceId: string }> };

type UiConfigObject = Record<string, unknown>;

function asUiConfig(raw: unknown): UiConfigObject {
  return raw && typeof raw === "object" && !Array.isArray(raw)
    ? { ...(raw as UiConfigObject) }
    : {};
}

function canManageSla(auth: Awaited<ReturnType<typeof requireWorkspaceMember>>) {
  if (auth instanceof NextResponse) return false;
  return (
    auth.isSystemAdmin ||
    auth.permissions.canEditWorkspaceSettings ||
    auth.permissions.canManageGroupRegistry ||
    auth.permissions.canSuperviseTeam
  );
}

async function computeOverdueConversations({
  workspaceId,
  userId,
  isSystemAdmin,
  permissions,
  enabled,
  responseMinutes,
}: {
  workspaceId: string;
  userId: string;
  isSystemAdmin: boolean;
  permissions: WorkspaceContext["permissions"];
  enabled: boolean;
  responseMinutes: number;
}) {
  if (!enabled) return [];

  const visibleAccountIds = await resolveVisibleAccountIds({
    userId,
    workspaceId,
    isSystemAdmin,
    permissions,
  });
  if (visibleAccountIds.size === 0) return [];

  const groups = await prisma.group.findMany({
    where: {
      workspaceId,
      isActive: true,
      isHidden: false,
      conversationStatus: { not: "CLOSED" },
      accountMemberships: {
        some: { accountId: { in: Array.from(visibleAccountIds) } },
      },
    },
    select: {
      id: true,
      title: true,
      chatType: true,
      conversationStatus: true,
      notificationsMutedUntil: true,
      conversationOwner: { select: { id: true, displayName: true, username: true } },
      directChatMessages: {
        where: { direction: { in: ["INBOUND", "OUTBOUND"] } },
        orderBy: { createdAt: "desc" },
        take: 20,
        select: { direction: true, createdAt: true },
      },
    },
    orderBy: { updatedAt: "desc" },
    take: 200,
  });

  const now = new Date();
  return groups
    .map((group) => {
      const lastInbound = group.directChatMessages.find((m) => m.direction === "INBOUND")?.createdAt ?? null;
      const lastOutbound = group.directChatMessages.find((m) => m.direction === "OUTBOUND")?.createdAt ?? null;
      if (
        !isConversationOverdue({
          enabled,
          responseMinutes,
          now,
          lastInboundAt: lastInbound,
          lastOutboundAt: lastOutbound,
          mutedUntil: group.notificationsMutedUntil,
          status: group.conversationStatus,
        })
      ) {
        return null;
      }
      const dueAt = lastInbound
        ? new Date(lastInbound.getTime() + responseMinutes * 60 * 1000).toISOString()
        : null;
      return {
        id: group.id,
        title: group.title,
        kind: group.chatType === "PRIVATE" ? "DIRECT" : "GROUP",
        conversationStatus: group.conversationStatus,
        conversationOwner: group.conversationOwner,
        lastInboundAt: lastInbound?.toISOString() ?? null,
        lastOutboundAt: lastOutbound?.toISOString() ?? null,
        dueAt,
      };
    })
    .filter((item): item is NonNullable<typeof item> => item != null)
    .sort((a, b) => String(a.dueAt).localeCompare(String(b.dueAt)))
    .slice(0, 50);
}

export async function GET(_req: Request, { params }: RouteParams) {
  const { workspaceId } = await params;
  const auth = await requireWorkspaceMember(workspaceId);
  if (auth instanceof NextResponse) return auth;

  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { uiConfig: true },
  });
  if (!workspace) return NextResponse.json({ error: "找不到工作區" }, { status: 404 });

  const uiConfig = asUiConfig(workspace.uiConfig);
  const config = normalizeSlaConfig(uiConfig[SLA_CONFIG_KEY], DEFAULT_SLA_CONFIG);
  const overdueConversations = await computeOverdueConversations({
    workspaceId,
    userId: auth.userId,
    isSystemAdmin: auth.isSystemAdmin,
    permissions: auth.permissions,
    ...config,
  });

  return NextResponse.json({ slaConfig: config, overdueConversations });
}

export async function PATCH(req: Request, { params }: RouteParams) {
  const { workspaceId } = await params;
  const auth = await requireWorkspaceMember(workspaceId);
  if (auth instanceof NextResponse) return auth;
  if (!canManageSla(auth)) {
    return NextResponse.json({ error: "權限不足" }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "無效的請求內容" }, { status: 400 });
  }

  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { uiConfig: true },
  });
  if (!workspace) return NextResponse.json({ error: "找不到工作區" }, { status: 404 });

  let config;
  try {
    config = normalizeSlaConfig(body, normalizeSlaConfig(asUiConfig(workspace.uiConfig)[SLA_CONFIG_KEY], DEFAULT_SLA_CONFIG));
  } catch (error) {
    const message = error instanceof RangeError ? "回覆 SLA 必須介於 1 到 10080 分鐘" : "SLA 設定格式錯誤";
    return NextResponse.json({ error: message }, { status: 400 });
  }

  const nextUiConfig = { ...asUiConfig(workspace.uiConfig), [SLA_CONFIG_KEY]: config };
  await prisma.workspace.update({
    where: { id: workspaceId },
    data: { uiConfig: nextUiConfig as unknown as Parameters<typeof prisma.workspace.update>[0]["data"]["uiConfig"] },
  });

  await logAudit({
    workspaceId,
    userId: auth.userId,
    action: "sla_settings.update",
    entityType: "Workspace",
    entityId: workspaceId,
    details: config,
  });

  return NextResponse.json({ slaConfig: config });
}
