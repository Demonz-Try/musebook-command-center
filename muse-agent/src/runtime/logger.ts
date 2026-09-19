export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
  child(fields: Record<string, unknown>): Logger;
}

export interface LoggerOptions {
  level?: LogLevel;
  /** JSON lines for production, human-readable for a terminal. */
  format?: "json" | "pretty";
  base?: Record<string, unknown>;
  write?: (line: string) => void;
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const level = options.level ?? "info";
  const format = options.format ?? "pretty";
  const base = options.base ?? {};
  const write = options.write ?? ((line: string) => process.stdout.write(`${line}\n`));

  const emit = (entryLevel: LogLevel, message: string, fields?: Record<string, unknown>) => {
    if (LEVEL_ORDER[entryLevel] < LEVEL_ORDER[level]) return;
    const merged = { ...base, ...fields };
    if (format === "json") {
      write(JSON.stringify({ at: new Date().toISOString(), level: entryLevel, message, ...merged }));
      return;
    }
    const suffix = Object.keys(merged).length
      ? ` ${Object.entries(merged)
          .map(([key, value]) => `${key}=${formatValue(value)}`)
          .join(" ")}`
      : "";
    write(`${new Date().toISOString()} ${entryLevel.toUpperCase().padEnd(5)} ${message}${suffix}`);
  };

  return {
    debug: (message, fields) => emit("debug", message, fields),
    info: (message, fields) => emit("info", message, fields),
    warn: (message, fields) => emit("warn", message, fields),
    error: (message, fields) => emit("error", message, fields),
    child: (fields) => createLogger({ ...options, base: { ...base, ...fields } }),
  };
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return String(value);
  if (typeof value === "string") return /\s/.test(value) ? JSON.stringify(value) : value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

export const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => silentLogger,
};
