import { describe, expect, it } from "vitest";
import {
  isValidTimeOfDay,
  normalizeDaysOfWeek,
  summarizeSchedule,
} from "@/lib/schedules/recurrence";
import { normalizeScheduleInput } from "@/lib/schedules/validation";

const daily = { name: "Morning check-in", recurrence: "DAILY", timeOfDay: "09:30" };

describe("normalizeScheduleInput", () => {
  it("applies defaults and clears fields that do not belong to the recurrence", () => {
    const out = normalizeScheduleInput({
      ...daily,
      name: "  Morning check-in  ",
      daysOfWeek: [1, 2],
      dayOfMonth: 5,
      intervalEvery: 3,
      intervalUnit: "DAYS",
    });

    expect(out).toEqual({
      name: "Morning check-in",
      description: null,
      behaviorKind: "REMINDER",
      recurrence: "DAILY",
      timezone: "Asia/Taipei",
      timeOfDay: "09:30",
      daysOfWeek: [],
      dayOfMonth: null,
      intervalEvery: null,
      intervalUnit: null,
      startsAt: null,
      endsAt: null,
      quickReplyId: null,
      isActive: true,
      metadata: null,
    });
  });

  it("requires a name of at most 80 characters", () => {
    expect(() => normalizeScheduleInput({ ...daily, name: "   " })).toThrow(RangeError);
    expect(() => normalizeScheduleInput({ ...daily, name: "x".repeat(81) })).toThrow(RangeError);
    expect(normalizeScheduleInput({ ...daily, name: "x".repeat(80) }).name).toHaveLength(80);
  });

  it("rejects unsupported behavior kinds and recurrences", () => {
    expect(() => normalizeScheduleInput({ ...daily, behaviorKind: "SPAM" })).toThrow(RangeError);
    expect(() => normalizeScheduleInput({ ...daily, recurrence: "YEARLY" })).toThrow(RangeError);
  });

  it("requires an HH:mm time for calendar recurrences", () => {
    for (const timeOfDay of [undefined, "9:30", "24:00", "12:60"]) {
      expect(() => normalizeScheduleInput({ ...daily, timeOfDay })).toThrow(/HH:mm/);
    }
  });

  it("de-duplicates and sorts weekdays and requires at least one", () => {
    const weekly = { name: "Weekly report", recurrence: "WEEKLY", timeOfDay: "18:00" };

    expect(normalizeScheduleInput({ ...weekly, daysOfWeek: [5, 1, 5, 9, -1] }).daysOfWeek)
      .toEqual([1, 5]);
    expect(() => normalizeScheduleInput({ ...weekly, daysOfWeek: [7] })).toThrow(RangeError);
  });

  it("accepts monthly days 1 to 31 only", () => {
    const monthly = { name: "Invoice reminder", recurrence: "MONTHLY", timeOfDay: "08:00" };

    expect(normalizeScheduleInput({ ...monthly, dayOfMonth: "31" }).dayOfMonth).toBe(31);
    for (const dayOfMonth of [0, 32, 1.5, null]) {
      expect(() => normalizeScheduleInput({ ...monthly, dayOfMonth })).toThrow(RangeError);
    }
  });

  it("validates fixed intervals and drops the time of day", () => {
    const interval = { name: "Health ping", recurrence: "INTERVAL", timeOfDay: "10:00" };

    expect(
      normalizeScheduleInput({ ...interval, intervalEvery: 6, intervalUnit: "HOURS" }),
    ).toMatchObject({ intervalEvery: 6, intervalUnit: "HOURS", timeOfDay: null });
    expect(() =>
      normalizeScheduleInput({ ...interval, intervalEvery: 366, intervalUnit: "DAYS" }),
    ).toThrow(RangeError);
    expect(() =>
      normalizeScheduleInput({ ...interval, intervalEvery: 2, intervalUnit: "MONTHS" }),
    ).toThrow(RangeError);
  });

  it("requires the end time to be after the start time", () => {
    const startsAt = "2026-01-01T00:00:00Z";

    expect(() => normalizeScheduleInput({ ...daily, startsAt, endsAt: startsAt })).toThrow(RangeError);
    expect(() => normalizeScheduleInput({ ...daily, startsAt: "not a date" })).toThrow(RangeError);
    expect(
      normalizeScheduleInput({ ...daily, startsAt, endsAt: "2026-02-01T00:00:00Z" }).endsAt,
    ).toEqual(new Date("2026-02-01T00:00:00Z"));
  });

  it("only accepts a plain object as metadata", () => {
    expect(() => normalizeScheduleInput({ ...daily, metadata: ["x"] })).toThrow(RangeError);
    expect(normalizeScheduleInput({ ...daily, metadata: { channel: "vip" } }).metadata)
      .toEqual({ channel: "vip" });
  });

  it("merges a partial update onto the stored schedule", () => {
    const stored = {
      name: "Weekly report",
      description: "Send the KPI summary",
      recurrence: "WEEKLY",
      timeOfDay: "18:00",
      daysOfWeek: [5],
    };

    expect(normalizeScheduleInput({ timeOfDay: "17:00" }, stored)).toMatchObject({
      name: "Weekly report",
      description: "Send the KPI summary",
      timeOfDay: "17:00",
      daysOfWeek: [5],
    });
    // 明確傳 null 代表清空，而不是沿用舊值
    expect(normalizeScheduleInput({ description: null }, stored).description).toBeNull();
  });
});

describe("recurrence helpers", () => {
  it("normalizes weekday lists", () => {
    expect(normalizeDaysOfWeek(["1", 3, 3, 7, -1, 2.5, "x"])).toEqual([1, 3]);
    expect(normalizeDaysOfWeek("1,2")).toEqual([]);
  });

  it("validates 24-hour HH:mm times", () => {
    expect(["00:00", "09:05", "23:59"].every(isValidTimeOfDay)).toBe(true);
    expect([null, 930, "9:05", "24:00", "12:60"].some(isValidTimeOfDay)).toBe(false);
  });

  it("summarizes each recurrence in the UI language", () => {
    expect(summarizeSchedule({ recurrence: "DAILY", timeOfDay: "09:30" })).toBe("每日 09:30");
    expect(summarizeSchedule({ recurrence: "WEEKLY", timeOfDay: "18:00", daysOfWeek: [1, 3] }))
      .toBe("每週週一、三 18:00");
    expect(summarizeSchedule({ recurrence: "MONTHLY", timeOfDay: "08:00", dayOfMonth: 15 }))
      .toBe("每月 15 日 08:00");
    expect(summarizeSchedule({ recurrence: "INTERVAL", intervalEvery: 2, intervalUnit: "HOURS" }))
      .toBe("每 2 小時");
  });
});
