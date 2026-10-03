import path from "node:path";

import { array, boolean, custom, number, prettifyError, strictObject, string } from "zod";
import type { output } from "zod";

import {
  DEFAULT_MAX_ATTACHMENT_BYTES,
  DEFAULT_MAX_ENVELOPE_BYTES,
  DEFAULT_MAX_IDLE,
  DEFAULT_NOISE_MAX_AGE,
} from "#src/defaults.js";
import { buildDsn } from "#src/dsn.js";
import { SentraConfigError } from "#src/errors.js";
import { parseDuration } from "#src/query/duration.js";
import { parseAllowedHost } from "#src/sourcemaps/hosts.js";
import { memoryStorage } from "#src/storage/memory/index.js";
import type { StorageAdapter } from "#src/storage/types.js";
import type { Duration, SentraLogger } from "#src/types.js";

interface SentraOptions {
  /** Default `memoryStorage()`. */
  storage?: StorageAdapter;
  /** Base URL used by `getDsn()`, e.g. `http://127.0.0.1:8969`. */
  publicUrl?: string;
  retention?: {
    /** Default `"30d"`: delete a whole session after this time without events. */
    maxIdle?: Duration | "never";
    /** Default `"7d"`: delete span/transaction/log/other records older than this. */
    noiseMaxAge?: Duration | "never";
  };
  limits?: {
    /** Default 20 MiB. */
    maxEnvelopeBytes?: number;
    /** Default 10 MiB. */
    maxAttachmentBytes?: number;
  };
  /** Keep raw envelope bodies. Default `true`. */
  rawEnvelopes?: boolean;
  sourceMaps?: {
    enabled?: boolean;
    /** Added to the loopback defaults. */
    allowedHosts?: string[];
    /** Absolute directories for the FS loader. */
    sourceRoots?: string[];
    fetchTimeoutMs?: number;
    /** Per envelope. */
    budgetMs?: number;
  };
  /** Default silent. */
  logger?: SentraLogger;
}

interface ResolvedRetention {
  maxIdle: string;
  noiseMaxAge: string;
  /** `null` = never. */
  maxIdleMs: number | null;
  /** `null` = never. */
  noiseMaxAgeMs: number | null;
}

interface ResolvedOptions {
  storage: StorageAdapter;
  publicUrl: string | null;
  retention: ResolvedRetention;
  limits: { maxEnvelopeBytes: number; maxAttachmentBytes: number };
  rawEnvelopes: boolean;
  sourceMaps: {
    enabled: boolean;
    allowedHosts: string[];
    sourceRoots: string[];
    fetchTimeoutMs: number;
    budgetMs: number;
  };
  logger: SentraLogger;
}

const STORAGE_METHODS = [
  "init",
  "write",
  "listScopes",
  "listIssues",
  "findIssues",
  "getIssue",
  "listItems",
  "getItem",
  "getItemByEventId",
  "getBlob",
  "getEnvelope",
  "listFailedEnvelopes",
  "deleteItems",
  "pruneIdleSessions",
  "pruneOldItems",
  "vacuum",
  "close",
] as const;
const LOGGER_METHODS = ["debug", "info", "warn", "error"] as const;

function noop(): void {
  // Silent default logger.
}

const SILENT_LOGGER: SentraLogger = { debug: noop, info: noop, warn: noop, error: noop };

function hasMethods(value: unknown, methods: readonly string[]): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    methods.every((method) => typeof Reflect.get(value, method) === "function")
  );
}

function isStorageAdapter(value: unknown): value is StorageAdapter {
  if (!hasMethods(value, STORAGE_METHODS) || typeof value !== "object" || value === null) {
    return false;
  }
  const type: unknown = Reflect.get(value, "type");
  return type === "memory" || type === "sqlite";
}

function isLogger(value: unknown): value is SentraLogger {
  return hasMethods(value, LOGGER_METHODS);
}

function isPublicUrl(value: string): boolean {
  try {
    buildDsn({ baseUrl: value });
    return true;
  } catch {
    return false;
  }
}

const durationOrNever = string().refine(
  (value) => value === "never" || parseDuration(value) !== null,
  {
    message: 'expected a duration (e.g. "30d") or "never"',
  },
);
const positiveInt = number().int().positive();

const optionsSchema = strictObject({
  storage: custom<StorageAdapter>(isStorageAdapter, {
    message: "storage must implement StorageAdapter",
  }).optional(),
  publicUrl: string()
    .refine(isPublicUrl, {
      message: "publicUrl must be an http(s) URL without path, query or credentials",
    })
    .optional(),
  retention: strictObject({
    maxIdle: durationOrNever.optional(),
    noiseMaxAge: durationOrNever.optional(),
  }).optional(),
  limits: strictObject({
    maxEnvelopeBytes: positiveInt.optional(),
    maxAttachmentBytes: positiveInt.optional(),
  }).optional(),
  rawEnvelopes: boolean().optional(),
  sourceMaps: strictObject({
    enabled: boolean().optional(),
    allowedHosts: array(
      string().refine((value) => parseAllowedHost(value) !== null, {
        message:
          "allowedHosts entries must be host, host:port or IPv6 (no scheme, path or credentials)",
      }),
    ).optional(),
    sourceRoots: array(
      string().refine((value) => path.isAbsolute(value), {
        message: "sourceRoots must be absolute",
      }),
    ).optional(),
    fetchTimeoutMs: positiveInt.optional(),
    budgetMs: positiveInt.optional(),
  }).optional(),
  logger: custom<SentraLogger>(isLogger, {
    message: "logger must have debug, info, warn and error functions",
  }).optional(),
});

function durationMs(value: string): number | null {
  return value === "never" ? null : parseDuration(value);
}

type ParsedOptions = output<typeof optionsSchema>;

function resolveRetention(retention: ParsedOptions["retention"]): ResolvedRetention {
  const maxIdle = retention?.maxIdle ?? DEFAULT_MAX_IDLE;
  const noiseMaxAge = retention?.noiseMaxAge ?? DEFAULT_NOISE_MAX_AGE;
  return {
    maxIdle,
    noiseMaxAge,
    maxIdleMs: durationMs(maxIdle),
    noiseMaxAgeMs: durationMs(noiseMaxAge),
  };
}

function resolveSourceMaps(sourceMaps: ParsedOptions["sourceMaps"]): ResolvedOptions["sourceMaps"] {
  return {
    enabled: sourceMaps?.enabled ?? true,
    allowedHosts: [...(sourceMaps?.allowedHosts ?? [])],
    sourceRoots: (sourceMaps?.sourceRoots ?? []).map((root) => path.resolve(root)),
    fetchTimeoutMs: sourceMaps?.fetchTimeoutMs ?? 1500,
    budgetMs: sourceMaps?.budgetMs ?? 3000,
  };
}

function resolveOptions(input: unknown): ResolvedOptions {
  const result = optionsSchema.safeParse(input ?? {});
  if (!result.success) {
    throw new SentraConfigError(
      "invalid_option",
      `invalid options: ${prettifyError(result.error)}`,
      {
        details: result.error.issues,
      },
    );
  }
  const options = result.data;
  return {
    storage: options.storage ?? memoryStorage(),
    publicUrl: options.publicUrl ?? null,
    retention: resolveRetention(options.retention),
    limits: {
      maxEnvelopeBytes: options.limits?.maxEnvelopeBytes ?? DEFAULT_MAX_ENVELOPE_BYTES,
      maxAttachmentBytes: options.limits?.maxAttachmentBytes ?? DEFAULT_MAX_ATTACHMENT_BYTES,
    },
    rawEnvelopes: options.rawEnvelopes ?? true,
    sourceMaps: resolveSourceMaps(options.sourceMaps),
    logger: options.logger ?? SILENT_LOGGER,
  };
}

export { resolveOptions, SILENT_LOGGER };
export type { ResolvedOptions, ResolvedRetention, SentraOptions };
