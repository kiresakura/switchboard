import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireWorkspaceMember } from "@/lib/auth/middleware";
import { logAudit } from "@/lib/audit/logger";
import { normalizeScheduleInput } from "@/lib/schedules/validation";

type RouteParams = {
  params: Promise<{ workspaceId: string; scheduleId: string }>;
};

const scheduleInclude = {
  quickReply: {
    select: { id: true, shortcut: true, title: true, scope: true },
  },
  createdBy: {
    select: { id: true, displayName: true },
  },
} as const;

function serializeSchedule(rule: {
  id: string;
  workspaceId: string;
  createdByUserId: string | null;
  quickReplyId: string | null;
  name: string;
  description: string | null;
  behaviorKind: string;
  recurrence: string;
  timezone: string;
  timeOfDay: string | null;
  daysOfWeek: number[];
  dayOfMonth: number | null;
  intervalEvery: number | null;
  intervalUnit: string | null;
  startsAt: Date | null;
  endsAt: Date | null;
  lastRunAt: Date | null;
  nextRunAt: Date | null;
  isActive: boolean;
  metadata: unknown;
  createdAt: Date;
  updatedAt: Date;
  quickReply?: { id: string; shortcut: string; title: string; scope: string } | null;
  createdBy?: { id: string; displayName: string } | null;
}) {
  return {
    id: rule.id,
    workspaceId: rule.workspaceId,
    createdByUserId: rule.createdByUserId,
    createdByName: rule.createdBy?.displayName ?? null,
    quickReplyId: rule.quickReplyId,
    quickReply: rule.quickReply
      ? {
          id: rule.quickReply.id,
          shortcut: rule.quickReply.shortcut,
          title: rule.quickReply.title,
          scope: rule.quickReply.scope,
        }
      : null,
    name: rule.name,
    description: rule.description,
    behaviorKind: rule.behaviorKind,
    recurrence: rule.recurrence,
    timezone: rule.timezone,
    timeOfDay: rule.timeOfDay,
    daysOfWeek: rule.daysOfWeek,
    dayOfMonth: rule.dayOfMonth,
    intervalEvery: rule.intervalEvery,
    intervalUnit: rule.intervalUnit,
    startsAt: rule.startsAt?.toISOString() ?? null,
    endsAt: rule.endsAt?.toISOString() ?? null,
    lastRunAt: rule.lastRunAt?.toISOString() ?? null,
    nextRunAt: rule.nextRunAt?.toISOString() ?? null,
    isActive: rule.isActive,
    metadata: rule.metadata,
    createdAt: rule.createdAt.toISOString(),
    updatedAt: rule.updatedAt.toISOString(),
  };
}

function canManageSchedules(auth: Awaited<ReturnType<typeof requireWorkspaceMember>>) {
  return !(auth instanceof NextResponse) && (auth.isSystemAdmin || auth.permissions.canEditWorkspaceSettings);
}

async function assertBindableQuickReply(workspaceId: string, quickReplyId: string | null) {
  if (!quickReplyId) return null;
  const reply = await prisma.quickReply.findFirst({
    where: { id: quickReplyId, workspaceId, scope: "WORKSPACE" },
    select: { id: true },
  });
  if (!reply) {
    throw new RangeError("只能綁定工作區範圍的快選回覆");
  }
  return reply.id;
}

export async function PATCH(req: Request, { params }: RouteParams) {
  const { workspaceId, scheduleId } = await params;
  const auth = await requireWorkspaceMember(workspaceId);
  if (auth instanceof NextResponse) return auth;
  if (!canManageSchedules(auth)) {
    return NextResponse.json({ error: "無權管理排程模組" }, { status: 403 });
  }

  const existing = await prisma.scheduleRule.findFirst({
    where: { id: scheduleId, workspaceId },
  });
  if (!existing) {
    return NextResponse.json({ error: "找不到排程規則" }, { status: 404 });
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "無效的請求內容" }, { status: 400 });
  }

  let input;
  try {
    input = normalizeScheduleInput(body, existing);
    await assertBindableQuickReply(workspaceId, input.quickReplyId);
  } catch (error) {
    const message = error instanceof RangeError ? error.message : "排程設定格式錯誤";
    return NextResponse.json({ error: message }, { status: 400 });
  }

  const updated = await prisma.scheduleRule.update({
    where: { id: scheduleId },
    data: {
      quickReplyId: input.quickReplyId,
      name: input.name,
      description: input.description,
      behaviorKind: input.behaviorKind,
      recurrence: input.recurrence,
      timezone: input.timezone,
      timeOfDay: input.timeOfDay,
      daysOfWeek: input.daysOfWeek,
      dayOfMonth: input.dayOfMonth,
      intervalEvery: input.intervalEvery,
      intervalUnit: input.intervalUnit,
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      isActive: input.isActive,
      metadata: input.metadata as Parameters<typeof prisma.scheduleRule.update>[0]["data"]["metadata"],
    },
    include: scheduleInclude,
  });

  await logAudit({
    workspaceId,
    userId: auth.userId,
    action: "schedule_rule.update",
    entityType: "ScheduleRule",
    entityId: updated.id,
    details: {
      changedKeys: Object.keys(body),
      quickReplyId: updated.quickReplyId,
    },
  });

  return NextResponse.json({ success: true, schedule: serializeSchedule(updated) });
}

export async function DELETE(_req: Request, { params }: RouteParams) {
  const { workspaceId, scheduleId } = await params;
  const auth = await requireWorkspaceMember(workspaceId);
  if (auth instanceof NextResponse) return auth;
  if (!canManageSchedules(auth)) {
    return NextResponse.json({ error: "無權管理排程模組" }, { status: 403 });
  }

  const existing = await prisma.scheduleRule.findFirst({
    where: { id: scheduleId, workspaceId },
  });
  if (!existing) {
    return NextResponse.json({ error: "找不到排程規則" }, { status: 404 });
  }

  await prisma.scheduleRule.delete({ where: { id: scheduleId } });

  await logAudit({
    workspaceId,
    userId: auth.userId,
    action: "schedule_rule.delete",
    entityType: "ScheduleRule",
    entityId: scheduleId,
    details: { name: existing.name, quickReplyId: existing.quickReplyId },
  });

  return NextResponse.json({ success: true });
}
