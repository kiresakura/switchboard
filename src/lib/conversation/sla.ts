export type SlaConfig = {
  enabled: boolean;
  responseMinutes: number;
};

export const DEFAULT_SLA_CONFIG: SlaConfig = {
  enabled: false,
  responseMinutes: 60,
};

const MIN_RESPONSE_MINUTES = 1;
const MAX_RESPONSE_MINUTES = 7 * 24 * 60;

export function normalizeSlaConfig(input: unknown, fallback: SlaConfig = DEFAULT_SLA_CONFIG): SlaConfig {
  const obj = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const rawMinutes = obj.responseMinutes;
  const numericMinutes =
    typeof rawMinutes === "number"
      ? rawMinutes
      : typeof rawMinutes === "string"
        ? Number(rawMinutes)
        : fallback.responseMinutes;

  if (!Number.isFinite(numericMinutes)) {
    throw new TypeError("responseMinutes must be a finite number");
  }

  const responseMinutes = Math.trunc(numericMinutes);
  if (responseMinutes < MIN_RESPONSE_MINUTES || responseMinutes > MAX_RESPONSE_MINUTES) {
    throw new RangeError("responseMinutes must be between 1 and 10080 minutes");
  }

  return {
    enabled: "enabled" in obj ? obj.enabled === true : fallback.enabled,
    responseMinutes,
  };
}

export function isConversationOverdue(input: {
  enabled: boolean;
  responseMinutes: number;
  now: Date;
  lastInboundAt: Date | string | null | undefined;
  lastOutboundAt: Date | string | null | undefined;
  mutedUntil?: Date | string | null;
  status?: string | null;
}): boolean {
  if (!input.enabled) return false;
  if (input.status === "CLOSED") return false;
  if (!input.lastInboundAt) return false;

  const inbound = new Date(input.lastInboundAt);
  if (Number.isNaN(inbound.getTime())) return false;

  if (input.lastOutboundAt) {
    const outbound = new Date(input.lastOutboundAt);
    if (!Number.isNaN(outbound.getTime()) && outbound >= inbound) return false;
  }

  if (input.mutedUntil) {
    const mutedUntil = new Date(input.mutedUntil);
    if (!Number.isNaN(mutedUntil.getTime()) && mutedUntil > input.now) return false;
  }

  const dueAt = new Date(inbound.getTime() + input.responseMinutes * 60 * 1000);
  return dueAt <= input.now;
}
