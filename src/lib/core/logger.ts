type Level = "debug" | "info" | "warn" | "error";

const LEVEL_WEIGHT: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export type LogRecord = {
  at: string;
  level: Level;
  scope: string;
  message: string;
  extra?: Record<string, unknown>;
};

const RING_SIZE = 500;
const ring: LogRecord[] = [];

function threshold(): number {
  const raw = (process.env.SB_LOG_LEVEL ?? "info").toLowerCase();
  return LEVEL_WEIGHT[(raw as Level) in LEVEL_WEIGHT ? (raw as Level) : "info"];
}

function emit(level: Level, scope: string, message: string, extra?: Record<string, unknown>): void {
  const record: LogRecord = { at: new Date().toISOString(), level, scope, message, ...(extra ? { extra } : {}) };
  ring.push(record);
  if (ring.length > RING_SIZE) ring.shift();
  if (LEVEL_WEIGHT[level] < threshold()) return;
  const line = `[${record.at}] ${level.toUpperCase().padEnd(5)} ${scope} ${message}`;
  if (level === "error") console.error(line, extra ?? "");
  else if (level === "warn") console.warn(line, extra ?? "");
  else console.log(line, extra ?? "");
}

export type Logger = {
  debug(message: string, extra?: Record<string, unknown>): void;
  info(message: string, extra?: Record<string, unknown>): void;
  warn(message: string, extra?: Record<string, unknown>): void;
  error(message: string, extra?: Record<string, unknown>): void;
  child(scope: string): Logger;
};

export function createLogger(scope: string): Logger {
  return {
    debug: (message, extra) => emit("debug", scope, message, extra),
    info: (message, extra) => emit("info", scope, message, extra),
    warn: (message, extra) => emit("warn", scope, message, extra),
    error: (message, extra) => emit("error", scope, message, extra),
    child: (child) => createLogger(`${scope}:${child}`),
  };
}

export const rootLogger = createLogger("app");

/** Recent records, used by the Settings page and the diagnostics API. */
export function recentLogs(limit = 100): LogRecord[] {
  return ring.slice(-limit);
}

export function clearLogs(): void {
  ring.length = 0;
}
