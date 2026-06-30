import type { NativeOutboundPayload } from "./client-manager";

const DICE_EMOTICONS = new Set(["🎲", "🎯", "🏀", "⚽", "🎰", "🎳"]);

function trimmed(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const out = value.trim();
  if (!out || out.length > maxLength) return null;
  return out;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function positiveInteger(value: unknown): number | null {
  const n = finiteNumber(value);
  if (n == null) return null;
  const int = Math.floor(n);
  return int > 0 ? int : null;
}

export function normalizeNativeOutboundPayload(input: unknown): NativeOutboundPayload | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const payload = input as Record<string, unknown>;

  switch (payload.kind) {
    case "location": {
      const lat = finiteNumber(payload.lat);
      const lng = finiteNumber(payload.lng);
      if (lat == null || lng == null || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
      const livePeriod = positiveInteger(payload.livePeriod);
      return {
        kind: "location",
        lat,
        lng,
        ...(livePeriod != null ? { livePeriod: Math.min(livePeriod, 86_400) } : {}),
      };
    }
    case "contact": {
      const firstName = trimmed(payload.firstName, 64);
      const lastName = typeof payload.lastName === "string" && payload.lastName.trim()
        ? payload.lastName.trim().slice(0, 64)
        : undefined;
      const phone = trimmed(payload.phone, 32);
      if (!firstName || !phone || !/^[+()\d\s.-]{3,32}$/.test(phone)) return null;
      const userId = typeof payload.userId === "string" && /^\d{1,20}$/.test(payload.userId.trim())
        ? payload.userId.trim()
        : undefined;
      return { kind: "contact", firstName, phone, ...(lastName ? { lastName } : {}), ...(userId ? { userId } : {}) };
    }
    case "poll": {
      const question = trimmed(payload.question, 300);
      if (!question || !Array.isArray(payload.options)) return null;
      const options = payload.options
        .map((o) => trimmed(o, 100))
        .filter((o): o is string => !!o)
        .slice(0, 10);
      if (options.length < 2) return null;
      const correctOptionIndex = positiveInteger(payload.correctOptionIndex ?? 0);
      const hasCorrect =
        typeof payload.correctOptionIndex === "number" &&
        Number.isInteger(payload.correctOptionIndex) &&
        payload.correctOptionIndex >= 0 &&
        payload.correctOptionIndex < options.length;
      return {
        kind: "poll",
        question,
        options,
        ...(typeof payload.anonymous === "boolean" ? { anonymous: payload.anonymous } : {}),
        ...(payload.multipleChoice === true ? { multipleChoice: true } : {}),
        ...(payload.quiz === true ? { quiz: true } : {}),
        ...(payload.closed === true ? { closed: true } : {}),
        ...(hasCorrect ? { correctOptionIndex: correctOptionIndex ?? 0 } : {}),
      };
    }
    case "dice": {
      const emoticon = typeof payload.emoticon === "string" ? payload.emoticon : "";
      return DICE_EMOTICONS.has(emoticon)
        ? { kind: "dice", emoticon: emoticon as Extract<NativeOutboundPayload, { kind: "dice" }>["emoticon"] }
        : null;
    }
    case "story": {
      const peerId = trimmed(payload.peerId, 64);
      const storyId = positiveInteger(payload.storyId);
      return peerId && storyId != null ? { kind: "story", peerId, storyId } : null;
    }
    default:
      return null;
  }
}
