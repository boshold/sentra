import path from "node:path";

import { buildDsn } from "#src/dsn.js";
import { SentraConfigError } from "#src/errors.js";
import { createIngestHandler } from "#src/ingest/handler.js";
import { createPipeline } from "#src/ingest/pipeline.js";
import type { MapFramesStep } from "#src/ingest/pipeline.js";
import { createLiveBus } from "#src/live/bus.js";
import { normalizeEventId } from "#src/normalize/schemas.js";
import { resolveOptions } from "#src/options.js";
import type { ResolvedOptions, SentraOptions } from "#src/options.js";
import {
  resolveIssueFilter,
  resolveItemFilter,
  resolveLiveFilter,
  resolvePage,
  resolveScopeFilter,
  resolveScopeTimeFilter,
} from "#src/query/filters.js";
import type {
  Envelope,
  Issue,
  IssueDetail,
  IssueFilter,
  Item,
  ItemFilter,
  ItemSummary,
  LiveEvent,
  LiveFilter,
  Page,
  PageInput,
  Scope,
  ScopeFilter,
  ScopeSummary,
  SentraToolDefinition,
  TimeFilter,
} from "#src/types.js";
import { VERSION } from "#src/util/version.js";

interface SentraBlob {
  data: Uint8Array;
  contentType: string | null;
  filename: string;
}

interface SentraInfo {
  version: string;
  storage: { type: "memory" | "sqlite"; driver: string | null; path: string | null };
  retention: string;
}

interface SentraQuery {
  listScopes(filter?: ScopeFilter): Promise<ScopeSummary[]>;
  listIssues(filter?: IssueFilter, page?: PageInput): Promise<Page<Issue>>;
  getIssue(id: string): Promise<IssueDetail | null>;
  listItems(filter?: ItemFilter, page?: PageInput): Promise<Page<ItemSummary>>;
  getItem(id: string): Promise<Item | null>;
  /** First record with that eventId (prefers error/message/transaction). */
  getItemByEventId(eventId: string): Promise<Item | null>;
  getBlob(itemId: string): Promise<SentraBlob | null>;
  getRawEnvelope(envelopeId: string): Promise<Uint8Array | null>;
  listFailedEnvelopes(
    filter?: ScopeFilter & TimeFilter,
    page?: PageInput,
  ): Promise<Page<Omit<Envelope, "body">>>;
}

interface Sentra {
  /** Ingest handler; bound, never rejects. */
  handle(request: Request): Promise<Response>;
  /** Requires `publicUrl`. */
  getDsn(scope?: Partial<Scope>): string;
  /** Absolute path; idempotent. */
  addSourceRoot(dir: string): void;
  removeSourceRoot(dir: string): void;
  query: SentraQuery;
  subscribe(filter: LiveFilter, listener: (event: LiveEvent) => void): () => void;
  clear(filter?: ItemFilter): Promise<{ itemsDeleted: number }>;
  /** Runs both retention rules. */
  prune(): Promise<{ sessionsDeleted: number; itemsDeleted: number }>;
  vacuum(): Promise<void>;
  mcpTools(): SentraToolDefinition[];
  info(): SentraInfo;
  /** Stops timers and closes storage. */
  close(): Promise<void>;
}

/** Internal hooks for later phases and tests. */
interface SentraInternals {
  mapFrames?: MapFramesStep;
}

function absoluteDir(dir: string): string {
  if (!path.isAbsolute(dir)) {
    throw new SentraConfigError("invalid_option", `source root must be absolute: ${dir}`);
  }
  return path.resolve(dir);
}

async function blobOf(options: ResolvedOptions, item: Item | null): Promise<SentraBlob | null> {
  if (item === null) {
    return null;
  }
  if (item.kind === "attachment") {
    const data = await options.storage.getBlob(item.id);
    return data === null
      ? null
      : { data, contentType: item.data.contentType, filename: item.data.filename };
  }
  if (item.kind === "other" && item.data.payloadEncoding === "binary") {
    const data = await options.storage.getBlob(item.id);
    return data === null ? null : { data, contentType: null, filename: item.itemType };
  }
  return null;
}

async function createSentraWith(
  input: SentraOptions | undefined,
  internals: SentraInternals,
): Promise<Sentra> {
  const options = resolveOptions(input);
  const { storage, logger } = options;
  const storageInfo = await storage.init();
  const bus = createLiveBus(logger);
  const sourceRoots = new Set(options.sourceMaps.sourceRoots);
  const onEnvelope = createPipeline({
    storage,
    bus,
    options,
    logger,
    mapFrames: internals.mapFrames,
  });
  const handler = createIngestHandler({
    limits: { maxEnvelopeBytes: options.limits.maxEnvelopeBytes },
    onEnvelope,
    logger,
  });
  let closed: Promise<void> | null = null;

  const query: SentraQuery = {
    listScopes: async (filter) => storage.listScopes(resolveScopeFilter(filter)),
    listIssues: async (filter, page) =>
      storage.listIssues(resolveIssueFilter(filter), resolvePage(page)),
    async getIssue(id) {
      const issue = await storage.getIssue(id);
      if (issue === null) {
        return null;
      }
      return { ...issue, latest: await storage.getItem(issue.lastItemId) };
    },
    listItems: async (filter, page) =>
      storage.listItems(resolveItemFilter(filter), resolvePage(page)),
    getItem: async (id) => storage.getItem(id),
    async getItemByEventId(eventId) {
      const normalized = normalizeEventId(eventId);
      return normalized === null ? null : storage.getItemByEventId(normalized);
    },
    getBlob: async (itemId) => blobOf(options, await storage.getItem(itemId)),
    async getRawEnvelope(envelopeId) {
      const envelope = await storage.getEnvelope(envelopeId);
      return envelope?.body ?? null;
    },
    listFailedEnvelopes: async (filter, page) =>
      storage.listFailedEnvelopes(resolveScopeTimeFilter(filter), resolvePage(page)),
  };

  return {
    handle: async (request) => handler(request),
    getDsn(scope = {}) {
      if (options.publicUrl === null) {
        throw new SentraConfigError("missing_public_url", "getDsn() requires the publicUrl option");
      }
      return buildDsn({ baseUrl: options.publicUrl, ...scope });
    },
    addSourceRoot(dir) {
      sourceRoots.add(absoluteDir(dir));
    },
    removeSourceRoot(dir) {
      sourceRoots.delete(absoluteDir(dir));
    },
    query,
    subscribe: (filter, listener) => bus.subscribe(resolveLiveFilter(filter), listener),
    async clear(filter) {
      return { itemsDeleted: await storage.deleteItems(resolveItemFilter(filter)) };
    },
    prune: async () => Promise.resolve({ sessionsDeleted: 0, itemsDeleted: 0 }),
    vacuum: async () => storage.vacuum(),
    mcpTools: () => [],
    info: () => ({
      version: VERSION,
      storage: { type: storage.type, driver: storageInfo.driver, path: storageInfo.path },
      retention: `${options.retention.maxIdle} idle, noise ${options.retention.noiseMaxAge}`,
    }),
    async close() {
      closed ??= (async () => {
        bus.clear();
        await storage.close();
      })();
      return closed;
    },
  };
}

/** Creates a core instance: resolves options and runs `storage.init()`. */
async function createSentra(options?: SentraOptions): Promise<Sentra> {
  return createSentraWith(options, {});
}

export { createSentra, createSentraWith };
export type { Sentra, SentraBlob, SentraInfo, SentraInternals, SentraQuery };
