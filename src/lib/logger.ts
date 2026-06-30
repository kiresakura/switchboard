/**
 * Structured logger — replaces console.log/error/warn across the codebase.
 *
 * Each log entry is a single JSON line with:
 *   { level, module, message, timestamp, ...extra }
 *
 * Usage:
 *   import { logger } from "@/lib/logger";
 *   const log = logger("Bridge");
 *   log.info("Connected", { accountId });
 *   log.error("Failed to send", { error: err.message });
 */

type LogLevel = "debug" | "info" | "warn" | "error";

interface LogEntry {
  level: LogLevel;
  module: string;
  message: string;
  timestamp: string;
  [key: string]: unknown;
}

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const MIN_LEVEL = (process.env.LOG_LEVEL as LogLevel) || "info";

function shouldLog(level: LogLevel): boolean {
  return LOG_LEVELS[level] >= LOG_LEVELS[MIN_LEVEL];
}

function formatEntry(entry: LogEntry): string {
  if (process.env.NODE_ENV === "development") {
    // Human-readable format in dev
    const prefix = `[${entry.module}]`;
    const extra = Object.keys(entry)
      .filter((k) => !["level", "module", "message", "timestamp"].includes(k))
      .reduce(
        (acc, k) => {
          acc[k] = entry[k];
          return acc;
        },
        {} as Record<string, unknown>
      );
    const extraStr = Object.keys(extra).length > 0 ? " " + JSON.stringify(extra) : "";
    return `${prefix} ${entry.message}${extraStr}`;
  }
  // Structured JSON in production
  return JSON.stringify(entry);
}

function createLogMethod(module: string, level: LogLevel) {
  return (message: string, extra?: Record<string, unknown>) => {
    if (!shouldLog(level)) return;

    const entry: LogEntry = {
      level,
      module,
      message,
      timestamp: new Date().toISOString(),
      ...extra,
    };

    const formatted = formatEntry(entry);

    switch (level) {
      case "error":
        console.error(formatted);
        break;
      case "warn":
        console.warn(formatted);
        break;
      default:
        // eslint-disable-next-line no-console
        console.log(formatted);
    }
  };
}

interface Logger {
  debug: (message: string, extra?: Record<string, unknown>) => void;
  info: (message: string, extra?: Record<string, unknown>) => void;
  warn: (message: string, extra?: Record<string, unknown>) => void;
  error: (message: string, extra?: Record<string, unknown>) => void;
}

export function logger(module: string): Logger {
  return {
    debug: createLogMethod(module, "debug"),
    info: createLogMethod(module, "info"),
    warn: createLogMethod(module, "warn"),
    error: createLogMethod(module, "error"),
  };
}
