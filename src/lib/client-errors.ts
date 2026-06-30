/**
 * Client-side error collector for the "系統異常回報" flow.
 *
 * Installs window listeners once on first use and keeps a ring buffer of
 * recent JS errors (`error` + `unhandledrejection`). Bundled into the
 * user-facing report so testers don't need to open DevTools to hand
 * diagnostic info back to the dev team.
 *
 * Intentionally lightweight: no network I/O, no external telemetry —
 * everything stays in-memory until the user clicks "複製回報".
 */

export type ClientError = {
  message: string;
  stack?: string;
  source?: string;
  timestamp: string;
};

const MAX_ERRORS = 10;
const buffer: ClientError[] = [];
let installed = false;

function push(err: ClientError) {
  buffer.push(err);
  if (buffer.length > MAX_ERRORS) buffer.shift();
}

export function installClientErrorCollector() {
  if (typeof window === "undefined" || installed) return;
  installed = true;

  window.addEventListener("error", (e: ErrorEvent) => {
    push({
      message: e.message || "unknown error",
      stack: e.error instanceof Error ? e.error.stack : undefined,
      source:
        e.filename && typeof e.lineno === "number"
          ? `${e.filename}:${e.lineno}:${e.colno ?? 0}`
          : undefined,
      timestamp: new Date().toISOString(),
    });
  });

  window.addEventListener("unhandledrejection", (e: PromiseRejectionEvent) => {
    const reason = e.reason;
    const message =
      reason instanceof Error
        ? reason.message
        : typeof reason === "string"
          ? reason
          : "unhandled promise rejection";
    const stack = reason instanceof Error ? reason.stack : undefined;
    push({ message, stack, timestamp: new Date().toISOString() });
  });
}

export function getRecentClientErrors(): ClientError[] {
  return [...buffer];
}
