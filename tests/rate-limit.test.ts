import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRateLimiter, getClientIp } from "@/lib/rate-limit";

describe("createRateLimiter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("allows up to max calls per window, then blocks until the window resets", () => {
    const limiter = createRateLimiter({ max: 3, windowMs: 60_000 });

    expect([1, 2, 3, 4].map(() => limiter.consume("ip:1"))).toEqual([true, true, true, false]);

    vi.advanceTimersByTime(60_000);
    expect(limiter.consume("ip:1")).toBe(false);

    vi.advanceTimersByTime(1);
    expect(limiter.consume("ip:1")).toBe(true);
  });

  it("tracks keys independently and supports manual reset", () => {
    const limiter = createRateLimiter({ max: 1, windowMs: 60_000 });

    expect(limiter.consume("user:a")).toBe(true);
    expect(limiter.consume("user:a")).toBe(false);
    expect(limiter.consume("user:b")).toBe(true);

    limiter.reset("user:a");
    expect(limiter.consume("user:a")).toBe(true);
  });
});

describe("getClientIp", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function request(headers: Record<string, string>) {
    return new Request("http://localhost/api/auth/login", { headers });
  }

  it("ignores client-supplied hops and trusts the proxy-observed address", () => {
    vi.stubEnv("TRUSTED_PROXY_HOPS", "");
    const spoofed = request({ "x-forwarded-for": "6.6.6.6, 203.0.113.7" });
    expect(getClientIp(spoofed)).toBe("203.0.113.7");
  });

  it("honours TRUSTED_PROXY_HOPS and clamps it to the header length", () => {
    const req = request({ "x-forwarded-for": "198.51.100.1, 10.0.0.2, 10.0.0.3" });

    vi.stubEnv("TRUSTED_PROXY_HOPS", "2");
    expect(getClientIp(req)).toBe("10.0.0.2");

    vi.stubEnv("TRUSTED_PROXY_HOPS", "10");
    expect(getClientIp(req)).toBe("198.51.100.1");

    vi.stubEnv("TRUSTED_PROXY_HOPS", "not-a-number");
    expect(getClientIp(req)).toBe("10.0.0.3");
  });

  it("falls back to X-Real-IP, then to unknown", () => {
    expect(getClientIp(request({ "x-real-ip": "203.0.113.9" }))).toBe("203.0.113.9");
    expect(getClientIp(request({}))).toBe("unknown");
  });
});
