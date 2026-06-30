/**
 * Simple in-memory token-window rate limiter.
 *
 * Each call to `consume(key)` increments the counter for `key`; once it
 * exceeds `max` within `windowMs`, further calls return `false` until the
 * window resets. Keys are bucketed independently — pass a per-IP or per-user
 * identifier depending on the threat model.
 *
 * In-memory: rate-limit state is per-process. For multi-instance deployments
 * behind a load balancer, swap to Redis.
 */
type Bucket = { count: number; resetAt: number };

export interface RateLimiter {
  consume(key: string): boolean;
  reset(key: string): void;
}

export function createRateLimiter(opts: {
  max: number;
  windowMs: number;
  /** Optional cleanup interval (defaults to windowMs * 5). */
  cleanupMs?: number;
}): RateLimiter {
  const buckets = new Map<string, Bucket>();
  const cleanupInterval = opts.cleanupMs ?? opts.windowMs * 5;

  // Periodic cleanup so abandoned keys don't grow the map forever.
  const timer: ReturnType<typeof setInterval> = setInterval(() => {
    const now = Date.now();
    for (const [key, bucket] of buckets.entries()) {
      if (now > bucket.resetAt) buckets.delete(key);
    }
  }, cleanupInterval);
  // unref so a stray limiter doesn't keep the event loop alive in tests.
  if (typeof timer.unref === "function") timer.unref();

  return {
    consume(key: string): boolean {
      const now = Date.now();
      const bucket = buckets.get(key);
      if (!bucket || now > bucket.resetAt) {
        buckets.set(key, { count: 1, resetAt: now + opts.windowMs });
        return true;
      }
      bucket.count++;
      return bucket.count <= opts.max;
    },
    reset(key: string): void {
      buckets.delete(key);
    },
  };
}

/**
 * Extract the client IP for rate-limiting / audit.
 *
 * SECURITY (H1): the LEFT-most `X-Forwarded-For` entry is client-controlled —
 * anyone can prepend a fake hop, which would let an attacker land every login
 * attempt in a fresh rate-limit bucket. Behind N trusted reverse proxies the
 * trustworthy address is the Nth entry from the RIGHT. Default 1 = the address
 * the proxy directly in front of the app observed. Operators whose topology has
 * a different proxy depth set `TRUSTED_PROXY_HOPS` to match.
 */
export function getClientIp(request: Request): string {
  const fwd = request.headers.get("x-forwarded-for");
  if (fwd) {
    const parts = fwd.split(",").map((s) => s.trim()).filter(Boolean);
    if (parts.length > 0) {
      const hops = Math.min(
        parts.length,
        Math.max(1, Number(process.env.TRUSTED_PROXY_HOPS) || 1),
      );
      return parts[parts.length - hops];
    }
  }
  return request.headers.get("x-real-ip") || "unknown";
}
