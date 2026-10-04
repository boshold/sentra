import { homedir, networkInterfaces } from "node:os";
import path from "node:path";
import { inspect } from "node:util";

import {
  DEFAULT_MAX_ATTACHMENT_BYTES,
  DEFAULT_MAX_ENVELOPE_BYTES,
  DEFAULT_MAX_IDLE,
  DEFAULT_MAX_ITEMS,
  DEFAULT_NOISE_MAX_AGE,
  ITEM_KINDS,
  buildDsn,
  isDuration,
  isScopeSegment,
  levelSchema,
  memoryStorage,
  parseAllowedHost,
  parseSize,
  sqliteStorage,
} from "@bosdev/sentra-core";
import type { Duration, ItemKind, Level, SentraLogger, SentraOptions } from "@bosdev/sentra-core";
import { NEVER, array, boolean, number, object, string, enum as zodEnum } from "zod";
import type { ZodError } from "zod";

class CliUsageError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "CliUsageError";
  }
}

class CliRuntimeError extends Error {
  public constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "CliRuntimeError";
  }
}

const LOG_LEVELS = ["error", "warn", "info", "debug"] as const;
type LogLevel = (typeof LOG_LEVELS)[number];

interface StartConfig {
  host: string;
  port: number;
  publicUrl: string | null;
  storage: "memory" | "sqlite";
  dbPath: string;
  sqliteDriver: "auto" | "better-sqlite3" | "node";
  maxItems: number;
  retention: Duration | "never";
  noiseRetention: Duration | "never";
  maxBodyBytes: number;
  maxAttachmentBytes: number;
  rawEnvelopes: boolean;
  sourceMaps: boolean;
  sourceMapHosts: string[];
  sourceRoots: string[];
  allowedHosts: string[];
  api: boolean;
  mcp: boolean;
  show: ItemKind[] | "all";
  minLevel: Level | null;
  project: string | null;
  session: string | null;
  service: string | null;
  format: "pretty" | "json";
  quiet: boolean;
  color: boolean;
  logLevel: LogLevel;
}

const DEFAULT_PORT = 8969;

function isPublicUrl(value: string): boolean {
  try {
    buildDsn({ baseUrl: value });
    return true;
  } catch {
    return false;
  }
}

const publicUrlSchema = string().refine(isPublicUrl, {
  message: "expected an http(s) URL without path, query or credentials",
});

/**
 * Canonical hostname as URL parsing yields it (`::0` → `[::]`, `0x7f.1` → `127.0.0.1`); `null` if
 * invalid.
 */
function canonicalHost(host: string): string | null {
  const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  if (bare === "" || /[\s/\\@?#[\]]/.test(bare)) {
    return null;
  }
  if (bare.includes(":")) {
    return URL.parse(`http://[${bare}]/`)?.hostname ?? null;
  }
  const hostname = URL.parse(`http://${bare}/`)?.hostname;
  return hostname === undefined || hostname === "" ? null : hostname;
}

const hostSchema = string()
  .refine((value) => canonicalHost(value) !== null, {
    message: "expected a hostname or IP address without scheme, port or path",
  })
  .transform((value) =>
    value.startsWith("[") && value.endsWith("]") ? value.slice(1, -1) : value,
  );

const segmentSchema = string().refine(isScopeSegment, {
  message: "expected 1-64 characters of A-Z a-z 0-9 . _ - (not . or ..)",
});

const hostEntrySchema = string().refine((value) => parseAllowedHost(value) !== null, {
  message: "expected host, host:port or IPv6 address (no scheme, path or credentials)",
});

const durationOrNever = string().transform((value, ctx): Duration | "never" => {
  if (value === "never" || isDuration(value)) {
    return value;
  }
  ctx.addIssue({ code: "custom", message: 'expected a duration (e.g. "30d") or "never"' });
  return NEVER;
});

const sizeSchema = string().transform((value, ctx): number => {
  const bytes = parseSize(value);
  if (bytes === null || bytes <= 0) {
    ctx.addIssue({ code: "custom", message: "expected a size (e.g. 512kb, 20mb)" });
    return NEVER;
  }
  return bytes;
});

const KIND_SET: ReadonlySet<string> = new Set(ITEM_KINDS);

function isItemKind(value: string): value is ItemKind {
  return KIND_SET.has(value);
}

const showSchema = string().transform((value, ctx): ItemKind[] | "all" => {
  const entries = value.split(",").map((entry) => entry.trim());
  if (entries.length === 1 && entries[0] === "all") {
    return "all";
  }
  const kinds = entries.filter(isItemKind);
  if (kinds.length !== entries.length || kinds.length === 0) {
    ctx.addIssue({
      code: "custom",
      message: `expected a comma list of ${ITEM_KINDS.join(", ")} or "all" alone`,
    });
    return NEVER;
  }
  return [...new Set(kinds)];
});

const flagsSchema = object({
  host: hostSchema.default("127.0.0.1"),
  port: number().int().min(0).max(65_535).default(DEFAULT_PORT),
  publicUrl: publicUrlSchema.optional(),
  storage: zodEnum(["memory", "sqlite"]).default("sqlite"),
  db: string().min(1).optional(),
  sqliteDriver: zodEnum(["auto", "better-sqlite3", "node"]).default("auto"),
  maxItems: number().int().positive().default(DEFAULT_MAX_ITEMS),
  retention: durationOrNever.default(DEFAULT_MAX_IDLE),
  noiseRetention: durationOrNever.default(DEFAULT_NOISE_MAX_AGE),
  maxBody: sizeSchema.default(DEFAULT_MAX_ENVELOPE_BYTES),
  maxAttachment: sizeSchema.default(DEFAULT_MAX_ATTACHMENT_BYTES),
  noRaw: boolean().default(false),
  noSourceMaps: boolean().default(false),
  sourceMapHost: array(hostEntrySchema).default([]),
  sourceRoot: array(string().min(1)).default([]),
  allowedHost: array(hostEntrySchema).default([]),
  noApi: boolean().default(false),
  noMcp: boolean().default(false),
  show: showSchema.default(["error", "message", "log"]),
  minLevel: levelSchema.optional(),
  project: segmentSchema.optional(),
  session: segmentSchema.optional(),
  service: segmentSchema.optional(),
  format: zodEnum(["pretty", "json"]).default("pretty"),
  quiet: boolean().default(false),
  noColor: boolean().default(false),
  logLevel: zodEnum(LOG_LEVELS).default("warn"),
});

const dsnSchema = object({
  project: segmentSchema.optional(),
  session: segmentSchema.optional(),
  service: segmentSchema.optional(),
  publicUrl: publicUrlSchema.default(`http://127.0.0.1:${DEFAULT_PORT}`),
});

const SIZE_UNITS = [
  ["gb", 1024 ** 3],
  ["mb", 1024 ** 2],
  ["kb", 1024],
] as const;

/** Inverse of `parseSize` for help text: largest unit that divides evenly, e.g. `20mb`. */
function formatSize(bytes: number): string {
  const unit = SIZE_UNITS.find(([, size]) => bytes % size === 0);
  return unit === undefined ? `${bytes}b` : `${bytes / unit[1]}${unit[0]}`;
}

function flagName(key: PropertyKey | undefined): string {
  return typeof key === "string"
    ? `--${key.replaceAll(/[A-Z]/g, (char) => `-${char.toLowerCase()}`)}`
    : "flags";
}

function usageError(error: ZodError): CliUsageError {
  const messages = error.issues.map(
    (issue) => `invalid ${flagName(issue.path[0])}: ${issue.message}`,
  );
  return new CliUsageError([...new Set(messages)].join("; "));
}

/**
 * `$XDG_DATA_HOME/sentra/sentra.db` (absolute values only), else `~/.local/share/sentra/sentra.db`.
 */
function defaultDbPath(env: NodeJS.ProcessEnv, homeDir: string): string {
  const xdg = env.XDG_DATA_HOME;
  const base =
    xdg !== undefined && path.isAbsolute(xdg) ? xdg : path.join(homeDir, ".local", "share");
  return path.join(base, "sentra", "sentra.db");
}

function resolveStartConfig(flags: unknown, env: NodeJS.ProcessEnv, cwd: string): StartConfig {
  const parsed = flagsSchema.safeParse(flags ?? {});
  if (!parsed.success) {
    throw usageError(parsed.error);
  }
  const input = parsed.data;
  return {
    host: input.host,
    port: input.port,
    publicUrl: input.publicUrl ?? null,
    storage: input.storage,
    dbPath: path.resolve(cwd, input.db ?? defaultDbPath(env, homedir())),
    sqliteDriver: input.sqliteDriver,
    maxItems: input.maxItems,
    retention: input.retention,
    noiseRetention: input.noiseRetention,
    maxBodyBytes: input.maxBody,
    maxAttachmentBytes: input.maxAttachment,
    rawEnvelopes: !input.noRaw,
    sourceMaps: !input.noSourceMaps,
    sourceMapHosts: input.sourceMapHost,
    sourceRoots:
      input.sourceRoot.length === 0
        ? [cwd]
        : input.sourceRoot.map((root) => path.resolve(cwd, root)),
    allowedHosts: input.allowedHost,
    api: !input.noApi,
    mcp: !input.noMcp,
    show: input.show,
    minLevel: input.minLevel ?? null,
    project: input.project ?? null,
    session: input.session ?? null,
    service: input.service ?? null,
    format: input.format,
    quiet: input.quiet,
    color: !input.noColor,
    logLevel: input.logLevel,
  };
}

/** Link-local addresses (`169.254.0.0/16`, `fe80::/10`) are not reachable as LAN hosts. */
function isLinkLocal(address: string): boolean {
  return address.startsWith("169.254.") || /^fe[89ab][0-9a-f]:/i.test(address);
}

/** Non-internal, non-link-local IPv4 addresses of this machine. */
function lanAddresses(): string[] {
  return Object.values(networkInterfaces()).flatMap((entries) =>
    (entries ?? [])
      .filter((entry) => entry.family === "IPv4" && !entry.internal && !isLinkLocal(entry.address))
      .map((entry) => entry.address),
  );
}

function isLoopbackHost(host: string): boolean {
  const canonical = canonicalHost(host);
  return (
    canonical === "localhost" ||
    canonical === "[::1]" ||
    /^127(?:\.\d{1,3}){3}$/.test(canonical ?? "")
  );
}

/** `0.0.0.0` or `::` in any spelling. */
function isUnspecifiedHost(host: string): boolean {
  const canonical = canonicalHost(host);
  return canonical === "0.0.0.0" || canonical === "[::]";
}

/** `--source-map-host` values; for a non-loopback bind also the bound host and the LAN IPs. */
function sourceMapHosts(config: StartConfig): string[] {
  if (isLoopbackHost(config.host)) {
    return [...config.sourceMapHosts];
  }
  const bound = isUnspecifiedHost(config.host) ? [] : [config.host];
  return [...new Set([...config.sourceMapHosts, ...bound, ...lanAddresses()])];
}

const LOG_RANK: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3 };

function createStderrLogger(
  level: LogLevel,
  stream: NodeJS.WritableStream = process.stderr,
): SentraLogger {
  function write(messageLevel: LogLevel, message: string, meta?: Record<string, unknown>): void {
    if (LOG_RANK[messageLevel] > LOG_RANK[level]) {
      return;
    }
    const suffix =
      meta === undefined
        ? ""
        : ` ${inspect(meta, { breakLength: Number.POSITIVE_INFINITY, depth: 4 })}`;
    stream.write(`sentra ${messageLevel}: ${message}${suffix}\n`);
  }
  return {
    debug: (message, meta) => {
      write("debug", message, meta);
    },
    info: (message, meta) => {
      write("info", message, meta);
    },
    warn: (message, meta) => {
      write("warn", message, meta);
    },
    error: (message, meta) => {
      write("error", message, meta);
    },
  };
}

/** Does not open the database; `sqliteStorage` creates missing parent directories on init. */
function toSentraOptions(
  config: StartConfig,
  logger: SentraLogger = createStderrLogger(config.logLevel),
): SentraOptions {
  return {
    storage:
      config.storage === "sqlite"
        ? sqliteStorage({ path: config.dbPath, driver: config.sqliteDriver })
        : memoryStorage({ maxItems: config.maxItems }),
    ...(config.publicUrl === null ? {} : { publicUrl: config.publicUrl }),
    retention: { maxIdle: config.retention, noiseMaxAge: config.noiseRetention },
    limits: {
      maxEnvelopeBytes: config.maxBodyBytes,
      maxAttachmentBytes: config.maxAttachmentBytes,
    },
    rawEnvelopes: config.rawEnvelopes,
    sourceMaps: {
      enabled: config.sourceMaps,
      allowedHosts: sourceMapHosts(config),
      sourceRoots: config.sourceRoots,
    },
    logger,
  };
}

export {
  CliRuntimeError,
  CliUsageError,
  createStderrLogger,
  defaultDbPath,
  DEFAULT_PORT,
  dsnSchema,
  formatSize,
  isLoopbackHost,
  isUnspecifiedHost,
  lanAddresses,
  resolveStartConfig,
  toSentraOptions,
  usageError,
};
export type { LogLevel, StartConfig };
