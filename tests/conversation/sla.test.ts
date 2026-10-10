import { describe, expect, it } from "vitest";
import { isConversationOverdue, normalizeSlaConfig } from "@/lib/conversation/sla";

describe("normalizeSlaConfig", () => {
  it("falls back to the defaults", () => {
    expect(normalizeSlaConfig(undefined)).toEqual({ enabled: false, responseMinutes: 60 });
    expect(normalizeSlaConfig({}, { enabled: true, responseMinutes: 15 })).toEqual({
      enabled: true,
      responseMinutes: 15,
    });
  });

  it("parses numeric strings and truncates fractions", () => {
    expect(normalizeSlaConfig({ responseMinutes: "30" }).responseMinutes).toBe(30);
    expect(normalizeSlaConfig({ responseMinutes: 30.9 }).responseMinutes).toBe(30);
  });

  it("enables the SLA only for a literal true", () => {
    expect(normalizeSlaConfig({ enabled: true }).enabled).toBe(true);
    expect(normalizeSlaConfig({ enabled: "true" }).enabled).toBe(false);
    expect(normalizeSlaConfig({ enabled: 1 }).enabled).toBe(false);
  });

  it("accepts 1 minute to 7 days", () => {
    expect(normalizeSlaConfig({ responseMinutes: 1 }).responseMinutes).toBe(1);
    expect(normalizeSlaConfig({ responseMinutes: 10080 }).responseMinutes).toBe(10080);
    expect(() => normalizeSlaConfig({ responseMinutes: 0 })).toThrow(RangeError);
    expect(() => normalizeSlaConfig({ responseMinutes: 10081 })).toThrow(RangeError);
  });

  it("rejects values that are not finite numbers", () => {
    expect(() => normalizeSlaConfig({ responseMinutes: "soon" })).toThrow(TypeError);
    expect(() => normalizeSlaConfig({ responseMinutes: Infinity })).toThrow(TypeError);
  });
});

describe("isConversationOverdue", () => {
  const now = new Date("2026-01-01T12:00:00Z");
  const base = {
    enabled: true,
    responseMinutes: 30,
    now,
    lastInboundAt: new Date("2026-01-01T11:30:00Z"),
    lastOutboundAt: null,
  };

  it("is overdue once the response window has fully elapsed", () => {
    expect(isConversationOverdue(base)).toBe(true);
    expect(isConversationOverdue({ ...base, lastInboundAt: "2026-01-01T11:30:01Z" })).toBe(false);
  });

  it("is never overdue when the SLA is off, the conversation is closed, or nothing came in", () => {
    expect(isConversationOverdue({ ...base, enabled: false })).toBe(false);
    expect(isConversationOverdue({ ...base, status: "CLOSED" })).toBe(false);
    expect(isConversationOverdue({ ...base, lastInboundAt: null })).toBe(false);
    expect(isConversationOverdue({ ...base, lastInboundAt: "not a date" })).toBe(false);
  });

  it("clears once the team has replied after the last inbound message", () => {
    expect(isConversationOverdue({ ...base, lastOutboundAt: "2026-01-01T11:30:00Z" })).toBe(false);
    expect(isConversationOverdue({ ...base, lastOutboundAt: "2026-01-01T11:00:00Z" })).toBe(true);
  });

  it("is suppressed while the conversation is snoozed", () => {
    expect(isConversationOverdue({ ...base, mutedUntil: "2026-01-01T13:00:00Z" })).toBe(false);
    expect(isConversationOverdue({ ...base, mutedUntil: "2026-01-01T11:59:00Z" })).toBe(true);
  });
});
