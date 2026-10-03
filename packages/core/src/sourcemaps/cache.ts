import type { TraceMap } from "@jridgewell/trace-mapping";

import type { LoadResult } from "#src/sourcemaps/extract.js";
import { LruCache } from "#src/util/lru.js";

/** `traceMap` is set when `result.status === "loaded"`. */
interface CachedSource {
  result: LoadResult;
  traceMap: TraceMap | null;
}

interface SourceMapCache {
  get(key: string): CachedSource | undefined;
  set(key: string, value: CachedSource): void;
  clear(): void;
  readonly size: number;
}

const SOURCE_MAP_CACHE_SIZE = 200;

const DETERMINISTIC_FAILURES: ReadonlySet<string> = new Set([
  "no_source_map",
  "not_javascript",
  "invalid_source_map",
  "map_outside_source_root",
  "map_not_allowed",
  "too_large",
]);

function createSourceMapCache(maxEntries: number = SOURCE_MAP_CACHE_SIZE): SourceMapCache {
  const lru = new LruCache<string, CachedSource>(maxEntries);
  return {
    get: (key) => lru.get(key),
    set: (key, value) => lru.set(key, value),
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

function isCacheable(result: LoadResult): boolean {
  if (result.status === "failed") {
    return DETERMINISTIC_FAILURES.has(result.reason);
  }
  return result.status === "loaded" || result.status === "unreliable";
}

export { SOURCE_MAP_CACHE_SIZE, createSourceMapCache, fsCacheKey, httpCacheKey, isCacheable };
export type { CachedSource, SourceMapCache };
