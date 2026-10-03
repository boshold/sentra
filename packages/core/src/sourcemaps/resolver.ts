import path from "node:path";

import { SentraConfigError } from "#src/errors.js";
import type { MapFramesStep } from "#src/ingest/pipeline.js";
import {
  createSourceMapCache,
  fsCacheKey,
  httpCacheKey,
  isCacheable,
} from "#src/sourcemaps/cache.js";
import type { CachedSource } from "#src/sourcemaps/cache.js";
import type { LoadResult } from "#src/sourcemaps/extract.js";
import {
  loadFsSourceMap,
  readSourceInsideRoots,
  resolveInsideRoots,
  resolveRoots,
} from "#src/sourcemaps/fs-loader.js";
import { isAllowedUrl, normalizeAllowedHosts } from "#src/sourcemaps/hosts.js";
import { loadHttpSourceMap } from "#src/sourcemaps/http-loader.js";
import { createBudget, createTraceMap, mapFrame } from "#src/sourcemaps/mapper.js";
import type { Budget } from "#src/sourcemaps/mapper.js";
import { classifyLocation, frameLocation } from "#src/sourcemaps/paths.js";
import type { EventData, Frame, Item, SentraLogger, SourceMapInfo } from "#src/types.js";

interface SourceMapResolverOptions {
  /** Extra hosts; loopback defaults are always added. */
  allowedHosts: readonly string[];
  /** A `Set` is used as-is, so the owner can share it (e.g. `Sentra.addSourceRoot`). */
  sourceRoots: Set<string> | readonly string[];
  fetchTimeoutMs: number;
  budgetMs: number;
  logger: SentraLogger;
}

interface SourceMapResolver {
  /** Mutates in place; one call = one budget. Never rejects. */
  resolveEvents(events: EventData[]): Promise<void>;
  mapFrames: MapFramesStep;
  addSourceRoot(dir: string): void;
  removeSourceRoot(dir: string): void;
  sourceRoots(): string[];
}

interface Candidate {
  key: string;
  load: () => Promise<LoadResult>;
}

interface ResolveContext {
  budget: Budget;
  deadline: AbortSignal;
  realRoots: string[];
  candidates: Map<string, Promise<Candidate | null>>;
  loads: Map<string, Promise<CachedSource>>;
  sources: Map<string, Promise<string | null>>;
}

type FrameOutcome =
  | { kind: "none" }
  | { kind: "mapped"; frame: Frame }
  | { kind: "error"; frame: Frame; reason: string };

const MAX_ERRORS = 50;
const NOT_APPLICABLE: SourceMapInfo = {
  status: "not_applicable",
  mappedFrames: 0,
  candidateFrames: 0,
  errors: [],
};

/** Validates and normalizes a source root; shared with `Sentra.addSourceRoot`. */
function absoluteDir(dir: string): string {
  if (!path.isAbsolute(dir)) {
    throw new SentraConfigError("invalid_option", `source root must be absolute: ${dir}`);
  }
  return path.resolve(dir);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function eventDataOf(item: Item): EventData | null {
  return item.kind === "error" || item.kind === "message" ? item.data : null;
}

function withEventData(item: Item, data: EventData): Item {
  if (item.kind === "error") {
    return { ...item, data };
  }
  if (item.kind === "message") {
    return { ...item, data };
  }
  return item;
}

function statusOf(candidateFrames: number, mappedFrames: number): SourceMapInfo["status"] {
  if (candidateFrames === 0) {
    return "not_applicable";
  }
  if (mappedFrames === candidateFrames) {
    return "full";
  }
  return mappedFrames === 0 ? "none" : "partial";
}

async function toCached(result: LoadResult): Promise<CachedSource> {
  if (result.status !== "loaded") {
    return { result, traceMap: null };
  }
  try {
    return { result, traceMap: createTraceMap(result.map, result.sourcesBase) };
  } catch {
    return { result: { status: "failed", reason: "invalid_source_map" }, traceMap: null };
  }
}

async function memo<T>(
  map: Map<string, Promise<T>>,
  key: string,
  create: () => Promise<T>,
): Promise<T> {
  let pending = map.get(key);
  if (pending === undefined) {
    pending = create();
    map.set(key, pending);
  }
  return pending;
}

function createSourceMapResolver(options: SourceMapResolverOptions): SourceMapResolver {
  const roots =
    options.sourceRoots instanceof Set
      ? options.sourceRoots
      : new Set(options.sourceRoots.map(absoluteDir));
  const hostSet = normalizeAllowedHosts(options.allowedHosts);
  const cache = createSourceMapCache();

  async function classify(location: string, ctx: ResolveContext): Promise<Candidate | null> {
    const classified = classifyLocation(location);
    if (classified.kind === "http") {
      const { url } = classified;
      if (!isAllowedUrl(url, hostSet)) {
        return null;
      }
      return {
        key: httpCacheKey(url),
        load: async () =>
          loadHttpSourceMap(url, {
            allowedHosts: hostSet,
            timeoutMs: options.fetchTimeoutMs,
            signal: ctx.deadline,
          }),
      };
    }
    if (classified.kind === "file") {
      const file = await resolveInsideRoots(classified.path, ctx.realRoots);
      if (file === null) {
        return null;
      }
      return {
        key: fsCacheKey(file.realPath, file.mtimeMs),
        load: async () => loadFsSourceMap(file, ctx.realRoots),
      };
    }
    return null;
  }

  async function load(candidate: Candidate, ctx: ResolveContext): Promise<CachedSource> {
    const cached = cache.get(candidate.key);
    if (cached !== undefined) {
      return cached;
    }
    if (ctx.budget.exceeded()) {
      return { result: { status: "failed", reason: "budget_exceeded" }, traceMap: null };
    }
    const loaded = await candidate.load();
    // A fetch aborted by the shared per-envelope deadline ran out of budget, not of fetch time.
    const result: LoadResult =
      loaded.status === "failed" && loaded.reason === "timeout" && ctx.deadline.aborted
        ? { status: "failed", reason: "budget_exceeded" }
        : loaded;
    const entry = await toCached(result);
    if (isCacheable(entry.result)) {
      cache.set(candidate.key, entry);
    }
    return entry;
  }

  async function resolveFrame(frame: Frame, ctx: ResolveContext): Promise<FrameOutcome> {
    const location = frameLocation(frame);
    if (location === null) {
      return { kind: "none" };
    }
    const candidate = await memo(ctx.candidates, location, async () => classify(location, ctx));
    if (candidate === null) {
      return { kind: "none" };
    }
    const { result, traceMap } = await memo(ctx.loads, candidate.key, async () =>
      load(candidate, ctx),
    );
    if (result.status === "skipped") {
      return { kind: "none" };
    }
    if (result.status === "unreliable") {
      return {
        kind: "error",
        reason: result.reason,
        frame: {
          ...frame,
          positionReliable: false,
          contextLine: null,
          preContext: [],
          postContext: [],
          mapped: null,
        },
      };
    }
    if (result.status === "failed" || traceMap === null) {
      return {
        kind: "error",
        reason: result.status === "failed" ? result.reason : "invalid_source_map",
        frame,
      };
    }
    const readSource =
      result.origin === "fs"
        ? async (filePath: string) =>
            memo(ctx.sources, filePath, async () => readSourceInsideRoots(filePath, ctx.realRoots))
        : async () => null;
    const mapped = await mapFrame(frame, traceMap, { roots: ctx.realRoots, readSource });
    return mapped === null
      ? { kind: "error", reason: "no_mapping", frame }
      : { kind: "mapped", frame: { ...frame, mapped } };
  }

  async function resolveEvent(event: EventData, ctx: ResolveContext): Promise<EventData> {
    const resolveAll = async (frames: Frame[]): Promise<FrameOutcome[]> =>
      Promise.all(frames.map(async (frame) => resolveFrame(frame, ctx)));
    const [exceptionOutcomes, stacktraceOutcomes] = await Promise.all([
      Promise.all(event.exceptions.map(async (exception) => resolveAll(exception.frames))),
      resolveAll(event.stacktrace),
    ]);

    // Built sequentially in frame order so counters and errors are deterministic.
    const errors: SourceMapInfo["errors"] = [];
    const seen = new Set<string>();
    let candidateFrames = 0;
    let mappedFrames = 0;
    const apply = (frames: Frame[], outcomes: FrameOutcome[]): Frame[] =>
      frames.map((frame, index) => {
        const outcome = outcomes[index];
        if (outcome === undefined || outcome.kind === "none") {
          return frame;
        }
        candidateFrames += 1;
        if (outcome.kind === "mapped") {
          mappedFrames += 1;
          return outcome.frame;
        }
        const absPath = frameLocation(outcome.frame) ?? "";
        const errorKey = `${absPath}\n${outcome.reason}`;
        if (!seen.has(errorKey) && errors.length < MAX_ERRORS) {
          seen.add(errorKey);
          errors.push({ absPath, reason: outcome.reason });
        }
        return outcome.frame;
      });

    const exceptions = event.exceptions.map((exception, index) => ({
      ...exception,
      frames: apply(exception.frames, exceptionOutcomes[index] ?? []),
    }));
    const stacktrace = apply(event.stacktrace, stacktraceOutcomes);
    const sourceMaps: SourceMapInfo =
      candidateFrames === 0
        ? { ...NOT_APPLICABLE, errors: [] }
        : {
            status: statusOf(candidateFrames, mappedFrames),
            candidateFrames,
            mappedFrames,
            errors,
          };
    return { ...event, exceptions, stacktrace, sourceMaps };
  }

  /** Returns mapped copies; inputs are never mutated. Rejects on unexpected errors. */
  async function mapEvents(events: EventData[]): Promise<EventData[]> {
    const budget = createBudget(options.budgetMs);
    const ctx: ResolveContext = {
      budget,
      deadline: AbortSignal.timeout(options.budgetMs),
      realRoots: await resolveRoots([...roots]),
      candidates: new Map(),
      loads: new Map(),
      sources: new Map(),
    };
    return Promise.all(events.map(async (event) => resolveEvent(event, ctx)));
  }

  async function safeMapEvents(events: EventData[]): Promise<EventData[] | null> {
    try {
      return await mapEvents(events);
    } catch (error) {
      options.logger.warn(`source map resolution failed: ${messageOf(error)}`, { error });
      return null;
    }
  }

  return {
    async resolveEvents(events) {
      const mapped = await safeMapEvents(events);
      if (mapped === null) {
        return;
      }
      for (const [index, event] of events.entries()) {
        const copy = mapped[index];
        if (copy !== undefined) {
          Object.assign(event, copy);
        }
      }
    },
    async mapFrames(items) {
      const events = items.flatMap((entry) => {
        const data = eventDataOf(entry.item);
        return data === null ? [] : [{ entry, data }];
      });
      if (events.length === 0) {
        return items;
      }
      const mapped = await safeMapEvents(events.map(({ data }) => data));
      if (mapped === null) {
        return items;
      }
      const byEntry = new Map(events.map(({ entry }, index) => [entry, mapped[index]]));
      return items.map((entry) => {
        const data = byEntry.get(entry);
        return data === undefined ? entry : { ...entry, item: withEventData(entry.item, data) };
      });
    },
    addSourceRoot(dir) {
      roots.add(absoluteDir(dir));
    },
    removeSourceRoot(dir) {
      roots.delete(absoluteDir(dir));
    },
    sourceRoots: () => [...roots],
  };
}

export { absoluteDir, createSourceMapResolver };
export type { SourceMapResolver, SourceMapResolverOptions };
