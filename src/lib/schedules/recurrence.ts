export const SCHEDULE_BEHAVIOR_KINDS = [
  "REMINDER",
  "FOLLOW_UP",
  "BROADCAST",
  "MAINTENANCE",
  "CUSTOM",
] as const;

export const SCHEDULE_RECURRENCES = [
  "DAILY",
  "WEEKLY",
  "MONTHLY",
  "INTERVAL",
] as const;

export const SCHEDULE_INTERVAL_UNITS = ["HOURS", "DAYS", "WEEKS"] as const;

export type ScheduleBehaviorKind = (typeof SCHEDULE_BEHAVIOR_KINDS)[number];
export type ScheduleRecurrence = (typeof SCHEDULE_RECURRENCES)[number];
export type ScheduleIntervalUnit = (typeof SCHEDULE_INTERVAL_UNITS)[number];

export const BEHAVIOR_LABELS: Record<ScheduleBehaviorKind, string> = {
  REMINDER: "提醒",
  FOLLOW_UP: "追蹤",
  BROADCAST: "週期廣播",
  MAINTENANCE: "維運",
  CUSTOM: "自定義",
};

export const RECURRENCE_LABELS: Record<ScheduleRecurrence, string> = {
  DAILY: "每日",
  WEEKLY: "每週",
  MONTHLY: "每月",
  INTERVAL: "固定間隔",
};

export const INTERVAL_UNIT_LABELS: Record<ScheduleIntervalUnit, string> = {
  HOURS: "小時",
  DAYS: "天",
  WEEKS: "週",
};

export const WEEKDAY_LABELS = ["日", "一", "二", "三", "四", "五", "六"] as const;

export function isScheduleBehaviorKind(value: unknown): value is ScheduleBehaviorKind {
  return typeof value === "string" && SCHEDULE_BEHAVIOR_KINDS.includes(value as ScheduleBehaviorKind);
}

export function isScheduleRecurrence(value: unknown): value is ScheduleRecurrence {
  return typeof value === "string" && SCHEDULE_RECURRENCES.includes(value as ScheduleRecurrence);
}

export function isScheduleIntervalUnit(value: unknown): value is ScheduleIntervalUnit {
  return typeof value === "string" && SCHEDULE_INTERVAL_UNITS.includes(value as ScheduleIntervalUnit);
}

export function normalizeDaysOfWeek(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return Array.from(
    new Set(
      value
        .map((day) => Number(day))
        .filter((day) => Number.isInteger(day) && day >= 0 && day <= 6),
    ),
  ).sort((a, b) => a - b);
}

export function isValidTimeOfDay(value: unknown): value is string {
  return typeof value === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

export function summarizeSchedule(input: {
  recurrence: ScheduleRecurrence;
  timeOfDay?: string | null;
  daysOfWeek?: number[] | null;
  dayOfMonth?: number | null;
  intervalEvery?: number | null;
  intervalUnit?: string | null;
}): string {
  if (input.recurrence === "DAILY") {
    return `每日 ${input.timeOfDay ?? "--:--"}`;
  }
  if (input.recurrence === "WEEKLY") {
    const days = (input.daysOfWeek ?? [])
      .map((day) => WEEKDAY_LABELS[day] ?? String(day))
      .join("、");
    return `每週${days ? `週${days}` : ""} ${input.timeOfDay ?? "--:--"}`;
  }
  if (input.recurrence === "MONTHLY") {
    return `每月 ${input.dayOfMonth ?? "?"} 日 ${input.timeOfDay ?? "--:--"}`;
  }
  const unit = isScheduleIntervalUnit(input.intervalUnit)
    ? INTERVAL_UNIT_LABELS[input.intervalUnit]
    : "單位";
  return `每 ${input.intervalEvery ?? "?"} ${unit}`;
}
