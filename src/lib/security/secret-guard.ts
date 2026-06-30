/**
 * Runtime guard against deploying with build-time / dev *placeholder* secrets.
 *
 * The production Docker image bakes literal placeholder values into `ENV`
 * (see `Dockerfile`) so that module-level `if (!process.env.X) throw` checks
 * pass during `next build`. The danger: those placeholders are **public** (they
 * live in the Dockerfile, which ships in the open-source repo). If a deploy
 * forgets to override even one variable, the app would otherwise run silently
 * using a known secret — e.g. a known `TELEGRAM_SESSION_KEY` makes every stored
 * Telegram session decryptable, and a known `INTERNAL_SECRET` lets anyone who
 * can reach the bridge/app authenticate.
 *
 * This module rejects such values at runtime (but NOT during the build phase,
 * where the placeholder is expected, and NOT in local dev, where weak defaults
 * are intentional).
 */

/** Literal placeholders baked by the Dockerfile build stage. */
const KNOWN_PLACEHOLDER_PREFIXES = ["build-time-placeholder"];

/** Substrings that mark the committed dev/example defaults (never valid in prod). */
const DEV_DEFAULT_MARKERS = ["change-in-production", "change-me", "changeme"];

/** True while `next build` is running — placeholders are expected then. */
function isBuildPhase(): boolean {
  return process.env.NEXT_PHASE === "phase-production-build";
}

/** True if `value` is a known build-time placeholder or a dev/example default. */
export function isPlaceholderSecret(value: string | undefined | null): boolean {
  if (!value) return false;
  if (KNOWN_PLACEHOLDER_PREFIXES.some((p) => value.startsWith(p))) return true;
  const lower = value.toLowerCase();
  return DEV_DEFAULT_MARKERS.some((m) => lower.includes(m));
}

/**
 * Assert that `value` is a real secret. In production: throws if the value is
 * unset or a known placeholder/dev-default. In local dev: warns only (so the
 * weak `.env` defaults keep working). Always a no-op during `next build`.
 */
export function assertRealSecret(name: string, value: string | undefined | null): void {
  if (isBuildPhase()) return;
  const isProd = process.env.NODE_ENV === "production";

  if (!value) {
    if (isProd) throw new Error(`${name} must be set in production`);
    return;
  }
  if (isPlaceholderSecret(value)) {
    const msg =
      `${name} is set to a build-time/dev placeholder — refusing to use it as a ` +
      `live secret. Generate a real value with: openssl rand -hex 32`;
    if (isProd) throw new Error(msg);
    console.warn(`[secret-guard] ${msg}`);
  }
}
