import {
  isScheduleBehaviorKind,
  isScheduleIntervalUnit,
  isScheduleRecurrence,
  isValidTimeOfDay,
  normalizeDaysOfWeek,
  type ScheduleBehaviorKind,
  type ScheduleIntervalUnit,
  type ScheduleRecurrence,
} from "@/lib/schedules/recurrence";

export type ScheduleInputBase = {
  name?: string | null;
  description?: string | null;
  behaviorKind?: string | null;
  recurrence?: string | null;
  timezone?: string | null;
  timeOfDay?: string | null;
  daysOfWeek?: number[] | null;
  dayOfMonth?: number | null;
  intervalEvery?: number | null;
  intervalUnit?: string | null;
  startsAt?: Date | string | null;
  endsAt?: Date | string | null;
  quickReplyId?: string | null;
  isActive?: boolean | null;
  metadata?: unknown;
};

export type NormalizedScheduleInput = {
  name: string;
  description: string | null;
  behaviorKind: ScheduleBehaviorKind;
  recurrence: ScheduleRecurrence;
  timezone: string;
  timeOfDay: string | null;
  daysOfWeek: number[];
  dayOfMonth: number | null;
  intervalEvery: number | null;
  intervalUnit: ScheduleIntervalUnit | null;
  startsAt: Date | null;
  endsAt: Date | null;
  quickReplyId: string | null;
  isActive: boolean;
  metadata: Record<string, unknown> | null;
};

function optionalString(value: unknown): string | null {
  if (value == null) return null;
  const text = String(value).trim();
  return text.length > 0 ? text : null;
}

function parseDate(value: unknown, label: string): Date | null {
  if (value == null || value === "") return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) {
    throw new RangeError(`${label} 不是合法時間`);
  }
  return date;
}

function numberOrNull(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function objectOrNull(value: unknown): Record<string, unknown> | null {
  if (value == null) return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new RangeError("metadata 必須是物件");
  }
  return value as Record<string, unknown>;
}

function valueOrBase(
  input: Record<string, unknown>,
  base: ScheduleInputBase | undefined,
  key: keyof ScheduleInputBase,
): unknown {
  return Object.prototype.hasOwnProperty.call(input, key) ? input[key] : base?.[key];
}

export function normalizeScheduleInput(
  input: Record<string, unknown>,
  base?: ScheduleInputBase,
): NormalizedScheduleInput {
  const name = optionalString(valueOrBase(input, base, "name"));
  if (!name || name.length > 80) {
    throw new RangeError("排程名稱為必填且 ≤ 80 字元");
  }

  const description = optionalString(valueOrBase(input, base, "description"));
  if (description && description.length > 2000) {
    throw new RangeError("說明必須 ≤ 2000 字元");
  }

  const behaviorKindValue = valueOrBase(input, base, "behaviorKind") ?? "REMINDER";
  if (!isScheduleBehaviorKind(behaviorKindValue)) {
    throw new RangeError("行為類型不支援");
  }

  const recurrenceValue = valueOrBase(input, base, "recurrence");
  if (!isScheduleRecurrence(recurrenceValue)) {
    throw new RangeError("週期類型不支援");
  }

  const timezone = optionalString(valueOrBase(input, base, "timezone")) ?? "Asia/Taipei";
  if (timezone.length > 64) {
    throw new RangeError("時區名稱過長");
  }

  const quickReplyId = optionalString(valueOrBase(input, base, "quickReplyId"));
  const isActiveValue = valueOrBase(input, base, "isActive") ?? true;
  const isActive = typeof isActiveValue === "boolean" ? isActiveValue : Boolean(isActiveValue);
  const startsAt = parseDate(valueOrBase(input, base, "startsAt"), "開始時間");
  const endsAt = parseDate(valueOrBase(input, base, "endsAt"), "結束時間");
  if (startsAt && endsAt && endsAt <= startsAt) {
    throw new RangeError("結束時間必須晚於開始時間");
  }

  const rawTimeOfDay = valueOrBase(input, base, "timeOfDay");
  const timeOfDay = optionalString(rawTimeOfDay);
  const rawDaysOfWeek = valueOrBase(input, base, "daysOfWeek") ?? [];
  const daysOfWeek = normalizeDaysOfWeek(rawDaysOfWeek);
  const dayOfMonth = numberOrNull(valueOrBase(input, base, "dayOfMonth"));
  const intervalEvery = numberOrNull(valueOrBase(input, base, "intervalEvery"));
  const intervalUnitValue = valueOrBase(input, base, "intervalUnit");
  const intervalUnit = isScheduleIntervalUnit(intervalUnitValue) ? intervalUnitValue : null;
  const metadata = objectOrNull(valueOrBase(input, base, "metadata"));

  if (recurrenceValue === "DAILY") {
    if (!isValidTimeOfDay(timeOfDay)) throw new RangeError("每日排程需要 HH:mm 時間");
    return {
      name,
      description,
      behaviorKind: behaviorKindValue,
      recurrence: recurrenceValue,
      timezone,
      timeOfDay,
      daysOfWeek: [],
      dayOfMonth: null,
      intervalEvery: null,
      intervalUnit: null,
      startsAt,
      endsAt,
      quickReplyId,
      isActive,
      metadata,
    };
  }

  if (recurrenceValue === "WEEKLY") {
    if (!isValidTimeOfDay(timeOfDay)) throw new RangeError("每週排程需要 HH:mm 時間");
    if (daysOfWeek.length === 0) throw new RangeError("每週排程至少要選一天");
    return {
      name,
      description,
      behaviorKind: behaviorKindValue,
      recurrence: recurrenceValue,
      timezone,
      timeOfDay,
      daysOfWeek,
      dayOfMonth: null,
      intervalEvery: null,
      intervalUnit: null,
      startsAt,
      endsAt,
      quickReplyId,
      isActive,
      metadata,
    };
  }

  if (recurrenceValue === "MONTHLY") {
    if (!isValidTimeOfDay(timeOfDay)) throw new RangeError("每月排程需要 HH:mm 時間");
    if (
      typeof dayOfMonth !== "number" ||
      !Number.isInteger(dayOfMonth) ||
      dayOfMonth < 1 ||
      dayOfMonth > 31
    ) {
      throw new RangeError("每月日期必須介於 1 到 31");
    }
    return {
      name,
      description,
      behaviorKind: behaviorKindValue,
      recurrence: recurrenceValue,
      timezone,
      timeOfDay,
      daysOfWeek: [],
      dayOfMonth,
      intervalEvery: null,
      intervalUnit: null,
      startsAt,
      endsAt,
      quickReplyId,
      isActive,
      metadata,
    };
  }

  if (
    typeof intervalEvery !== "number" ||
    !Number.isInteger(intervalEvery) ||
    intervalEvery < 1 ||
    intervalEvery > 365
  ) {
    throw new RangeError("固定間隔必須介於 1 到 365");
  }
  if (!intervalUnit) {
    throw new RangeError("固定間隔需要單位");
  }
  return {
    name,
    description,
    behaviorKind: behaviorKindValue,
    recurrence: recurrenceValue,
    timezone,
    timeOfDay: null,
    daysOfWeek: [],
    dayOfMonth: null,
    intervalEvery,
    intervalUnit,
    startsAt,
    endsAt,
    quickReplyId,
    isActive,
    metadata,
  };
}
