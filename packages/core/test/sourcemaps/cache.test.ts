import { TraceMap } from "@jridgewell/trace-mapping";

import {
  HTTP_FAILURE_TTL_MS,
  HTTP_UNVALIDATED_TTL_MS,
  SOURCE_MAP_CACHE_SIZE,
  cacheEntryFor,
  createSourceMapCache,
  fsCacheKey,
  httpCacheKey,
  isCacheable,
} from "#src/sourcemaps/cache.js";
import type { CacheEntry, CachedSource } from "#src/sourcemaps/cache.js";
import type { LoadResult, RawSourceMap } from "#src/sourcemaps/extract.js";

const failed: CacheEntry = {
  source: { result: { status: "failed", reason: "no_source_map" }, traceMap: null },
  expiresAt: null,
  validators: null,
};

describe("createSourceMapCache", () => {
  it("keeps at most 200 entries and evicts the least recently used", () => {
    const cache = createSourceMapCache();
    expect(SOURCE_MAP_CACHE_SIZE).toBe(200);
    for (let i = 0; i < 200; i += 1) {
      cache.set(`k${i}`, failed);
    }
    expect(cache.get("k0")).toBe(failed);
    cache.set("k200", failed);
    expect(cache.size).toBe(200);
    expect(cache.get("k0")).toBe(failed);
    expect(cache.get("k1")).toBeUndefined();
    expect(cache.get("k200")).toBe(failed);
  });

  it("stores the trace map and clears", () => {
    const map = { version: 3, sources: ["a.ts"], names: [], mappings: "AAAA" } as const;
    const traceMap = new TraceMap(map);
    const cache = createSourceMapCache(2);
    cache.set("a", {
      source: {
        result: {
          status: "loaded",
          map: { ...map, sources: ["a.ts"], names: [] },
          sourcesBase: "",
          origin: "fs",
        },
        traceMap,
      },
      expiresAt: null,
      validators: null,
    });
    expect(cache.get("a")?.source.traceMap).toBe(traceMap);
    cache.delete("a");
    expect(cache.get("a")).toBeUndefined();
    cache.set("b", failed);
    cache.clear();
    expect(cache.size).toBe(0);
  });
});

describe("cache keys", () => {
  it("include the query for http", () => {
    expect(httpCacheKey(new URL("http://localhost/a.js?t=1"))).not.toBe(
      httpCacheKey(new URL("http://localhost/a.js?t=2")),
    );
    expect(httpCacheKey(new URL("http://localhost/a.js?t=1"))).toBe(
      "http:http://localhost/a.js?t=1",
    );
  });

  it("include mtime for fs", () => {
    expect(fsCacheKey("/app/a.js", 1)).not.toBe(fsCacheKey("/app/a.js", 2));
    expect(fsCacheKey("/app/a.js", 1.5)).toBe("fs:/app/a.js:1.5");
  });
});

describe("isCacheable", () => {
  const loaded: LoadResult = {
    status: "loaded",
    map: { version: 3, sources: [], names: [], mappings: "" },
    sourcesBase: "file:///a.js",
    origin: "fs",
  };

  it.each<[string, LoadResult, boolean]>([
    ["loaded", loaded, true],
    ["unreliable", { status: "unreliable", reason: "ssr_position_unreliable" }, true],
    ...[
      "no_source_map",
      "not_javascript",
      "invalid_source_map",
      "map_outside_source_root",
      "map_not_allowed",
      "too_large",
    ].map((reason): [string, LoadResult, boolean] => [reason, { status: "failed", reason }, true]),
    ...[
      "timeout",
      "fetch_failed",
      "read_failed",
      "budget_exceeded",
      "redirect_not_allowed",
      "http_status_404",
      "http_status_504",
    ].map((reason): [string, LoadResult, boolean] => [reason, { status: "failed", reason }, false]),
    ["skipped host_not_allowed", { status: "skipped", reason: "host_not_allowed" }, false],
    ["skipped outside_source_root", { status: "skipped", reason: "outside_source_root" }, false],
  ])("%s → %s", (_name, result, expected) => {
    expect(isCacheable(result)).toBe(expected);
  });
});

describe("cacheEntryFor", () => {
  const map: RawSourceMap = { version: 3, sources: [], names: [], mappings: "" };
  function loaded(result: LoadResult): CachedSource {
    return { result, traceMap: null };
  }
  const httpLoaded = (etag: string | null): CachedSource =>
    loaded({
      status: "loaded",
      map,
      sourcesBase: "http://localhost/a.js",
      origin: "http",
      validators: etag === null ? null : { etag, lastModified: null },
    });

  it("never expires fs entries", () => {
    expect(cacheEntryFor(httpLoaded(null), "fs", 1000)).toMatchObject({
      expiresAt: null,
      validators: null,
    });
  });

  it("expires http failures after the failure TTL", () => {
    expect(HTTP_FAILURE_TTL_MS).toBe(5000);
    const source = loaded({ status: "failed", reason: "no_source_map" });
    expect(cacheEntryFor(source, "http", 1000)).toEqual({
      source,
      expiresAt: 6000,
      validators: null,
    });
  });

  it("expires http maps without validators after the unvalidated TTL", () => {
    expect(HTTP_UNVALIDATED_TTL_MS).toBe(30_000);
    expect(cacheEntryFor(httpLoaded(null), "http", 1000)).toMatchObject({
      expiresAt: 31_000,
      validators: null,
    });
  });

  it("keeps http maps with validators for revalidation", () => {
    expect(cacheEntryFor(httpLoaded('"v1"'), "http", 1000)).toMatchObject({
      expiresAt: null,
      validators: { etag: '"v1"', lastModified: null },
    });
  });
});
