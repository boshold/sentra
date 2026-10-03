import type { TraceMap } from "@jridgewell/trace-mapping";

import type { HttpCacheInfo, LoadResult } from "#src/sourcemaps/extract.js";
import { LruCache } from "#src/util/lru.js";

/** `traceMap` is set when `result.status === "loaded"`. */
interface CachedSource {
  result: LoadResult;
  traceMap: TraceMap | null;
}

interface CacheEntry {
  source: CachedSource;
  /** Epoch ms after which the entry is reloaded; `null` = no expiry. */
  expiresAt: number | null;
  /** Set for HTTP maps whose module sent `ETag` / `Last-Modified`: revalidated on every use. */
  revalidate: HttpCacheInfo | null;
}

interface SourceMapCache {
  get(key: string): CacheEntry | undefined;
  set(key: string, value: CacheEntry): void;
  delete(key: string): void;
  clear(): void;
  readonly size: number;
}

const SOURCE_MAP_CACHE_SIZE = 200;
/** Dev servers rebuild modules at the same URL, so HTTP entries are not trusted forever. */
const HTTP_FAILURE_TTL_MS = 5000;
const HTTP_UNVALIDATED_TTL_MS = 30_000;

const DETERMINISTIC_FAILURES: ReadonlySet<string> = new Set([
  "no_source_map",
  "not_javascript",
  "invalid_source_map",
  "map_outside_source_root",
  "map_not_allowed",
  "too_large",
]);

function createSourceMapCache(maxEntries: number = SOURCE_MAP_CACHE_SIZE): SourceMapCache {
  const lru = new LruCache<string, CacheEntry>(maxEntries);
  return {
    get: (key) => lru.get(key),
    set: (key, value) => lru.set(key, value),
    delete: (key) => {
      lru.delete(key);
    },
    clear: () => lru.clear(),
    get size() {
      return lru.size;
    },
  };
}

function httpCacheKey(url: URL): string {
  return `http:${url.href}`;
}

function fsCacheKey(realPath: string, mtimeMs: number): string {
  return `fs:${realPath}:${mtimeMs}`;
}

/**
 * FS keys already contain the mtime. HTTP entries are revalidated when the module sent
 * validators; an external map without validators (or a module without them) expires after 30 s.
 */
function cacheEntryFor(source: CachedSource, origin: "http" | "fs", now: number): CacheEntry {
  if (origin === "fs") {
    return { source, expiresAt: null, revalidate: null };
  }
  const { result } = source;
  if (result.status === "failed") {
    return { source, expiresAt: now + HTTP_FAILURE_TTL_MS, revalidate: null };
  }
  const http = result.status === "loaded" ? (result.http ?? null) : null;
  if (http === null || http.module === null) {
    return { source, expiresAt: now + HTTP_UNVALIDATED_TTL_MS, revalidate: null };
  }
  const unvalidatedMap = http.mapUrl !== null && http.map === null;
  return {
    source,
    expiresAt: unvalidatedMap ? now + HTTP_UNVALIDATED_TTL_MS : null,
    revalidate: http,
  };
}

function isCacheable(result: LoadResult): boolean {
  if (result.status === "failed") {
    return DETERMINISTIC_FAILURES.has(result.reason);
  }
  return result.status === "loaded" || result.status === "unreliable";
}

export {
  HTTP_FAILURE_TTL_MS,
  HTTP_UNVALIDATED_TTL_MS,
  SOURCE_MAP_CACHE_SIZE,
  cacheEntryFor,
  createSourceMapCache,
  fsCacheKey,
  httpCacheKey,
  isCacheable,
};
export type { CacheEntry, CachedSource, SourceMapCache };
