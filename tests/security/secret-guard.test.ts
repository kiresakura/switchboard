import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assertRealSecret, isPlaceholderSecret } from "@/lib/security/secret-guard";

const REAL_SECRET = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";

beforeEach(() => {
  vi.stubEnv("NEXT_PHASE", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("isPlaceholderSecret", () => {
  it("flags the Dockerfile placeholder and committed example values", () => {
    expect(isPlaceholderSecret("build-time-placeholder-replaced-at-runtime")).toBe(true);
    expect(isPlaceholderSecret("change-me-to-a-random-32-byte-hex-string")).toBe(true);
    expect(isPlaceholderSecret("CHANGE-IN-PRODUCTION")).toBe(true);
    expect(isPlaceholderSecret("changeme")).toBe(true);
  });

  it("accepts real-looking secrets and treats empty values as unset", () => {
    expect(isPlaceholderSecret(REAL_SECRET)).toBe(false);
    expect(isPlaceholderSecret("")).toBe(false);
    expect(isPlaceholderSecret(undefined)).toBe(false);
  });
});

describe("assertRealSecret", () => {
  it("throws in production for missing or placeholder secrets", () => {
    vi.stubEnv("NODE_ENV", "production");

    expect(() => assertRealSecret("SESSION_SECRET", undefined)).toThrow(/must be set in production/);
    expect(() => assertRealSecret("SESSION_SECRET", "change-me")).toThrow(/placeholder/);
    expect(() => assertRealSecret("SESSION_SECRET", REAL_SECRET)).not.toThrow();
  });

  it("only warns in development", () => {
    vi.stubEnv("NODE_ENV", "development");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(() => assertRealSecret("SESSION_SECRET", "change-me")).not.toThrow();
    expect(() => assertRealSecret("SESSION_SECRET", undefined)).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("is a no-op during next build", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PHASE", "phase-production-build");

    expect(() =>
      assertRealSecret("SESSION_SECRET", "build-time-placeholder-replaced-at-runtime"),
    ).not.toThrow();
  });
});
