import {
  MAX_SOURCE_BYTES,
  findSourceMappingUrl,
  parseSourceMap,
  resolveMapReference,
} from "#src/sourcemaps/extract.js";
import type { HttpCacheInfo, HttpValidators, LoadResult } from "#src/sourcemaps/extract.js";
import { isAllowedUrl } from "#src/sourcemaps/hosts.js";

interface HttpLoaderOptions {
  allowedHosts: ReadonlySet<string>;
  timeoutMs: number;
  maxBytes?: number;
  /** Shared deadline (e.g. per-envelope budget); combined with `timeoutMs` per fetch. */
  signal?: AbortSignal;
}

type FetchResult =
  | { ok: true; notModified: false; text: string; finalUrl: URL; headers: Headers }
  | { ok: true; notModified: true }
  | { ok: false; reason: string };

/** The cached entry is still current (all conditional requests answered `304`). */
interface NotModified {
  status: "not_modified";
}

type HttpLoadResult = LoadResult | NotModified;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 3;
const JAVASCRIPT_CONTENT_TYPE = /^(?:text|application)\/(?:x-)?(?:javascript|ecmascript)\b/i;

function isTimeout(error: unknown, signal: AbortSignal): boolean {
  if (signal.aborted) {
    return true;
  }
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

async function cancelBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Ignore: body already closed
  }
}

async function collect(
  body: ReadableStream<Uint8Array>,
  maxBytes: number,
): Promise<Uint8Array[] | null> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  // Leaving the loop early cancels the stream.
  for await (const chunk of body) {
    total += chunk.byteLength;
    if (total > maxBytes) {
      return null;
    }
    chunks.push(chunk);
  }
  return chunks;
}

async function readLimited(response: Response, maxBytes: number): Promise<string | null> {
  const contentLength = Number(response.headers.get("content-length") ?? Number.NaN);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    await cancelBody(response);
    return null;
  }
  if (response.body === null) {
    return "";
  }
  const chunks = await collect(response.body, maxBytes);
  if (chunks === null) {
    return null;
  }
  const decoder = new TextDecoder();
  return chunks.map((chunk) => decoder.decode(chunk, { stream: true })).join("") + decoder.decode();
}

interface FetchContext {
  options: HttpLoaderOptions;
  signal: AbortSignal;
  expectJavaScript: boolean;
  /** Sent as `If-None-Match` / `If-Modified-Since`; `304` then means not modified. */
  validators: HttpValidators | null;
}

function requestHeaders(validators: HttpValidators | null): Record<string, string> {
  const headers: Record<string, string> = { accept: "*/*" };
  const etag = validators?.etag ?? null;
  const lastModified = validators?.lastModified ?? null;
  if (etag !== null) {
    headers["if-none-match"] = etag;
  }
  if (lastModified !== null) {
    headers["if-modified-since"] = lastModified;
  }
  return headers;
}

async function fetchHop(current: URL, hop: number, context: FetchContext): Promise<FetchResult> {
  const { options, signal, expectJavaScript, validators } = context;
  const response = await fetch(current, {
    redirect: "manual",
    signal,
    credentials: "omit",
    headers: requestHeaders(validators),
  });
  if (response.status === 304 && validators !== null) {
    await cancelBody(response);
    return { ok: true, notModified: true };
  }
  if (REDIRECT_STATUSES.has(response.status)) {
    await cancelBody(response);
    const location = response.headers.get("location");
    const next = location === null || hop >= MAX_REDIRECTS ? null : URL.parse(location, current);
    if (next === null || next.host !== current.host || !isAllowedUrl(next, options.allowedHosts)) {
      return { ok: false, reason: "redirect_not_allowed" };
    }
    return fetchHop(next, hop + 1, context);
  }
  if (response.status !== 200) {
    await cancelBody(response);
    return { ok: false, reason: `http_status_${response.status}` };
  }
  if (
    expectJavaScript &&
    !JAVASCRIPT_CONTENT_TYPE.test(response.headers.get("content-type") ?? "")
  ) {
    await cancelBody(response);
    return { ok: false, reason: "not_javascript" };
  }
  const text = await readLimited(response, options.maxBytes ?? MAX_SOURCE_BYTES);
  if (text === null) {
    return { ok: false, reason: "too_large" };
  }
  return { ok: true, notModified: false, text, finalUrl: current, headers: response.headers };
}

async function fetchLimited(
  url: URL,
  options: HttpLoaderOptions,
  expectJavaScript: boolean,
  validators: HttpValidators | null = null,
): Promise<FetchResult> {
  const timeout = AbortSignal.timeout(options.timeoutMs);
  const signal =
    options.signal === undefined ? timeout : AbortSignal.any([timeout, options.signal]);
  try {
    return await fetchHop(url, 0, { options, signal, expectJavaScript, validators });
  } catch (error) {
    return { ok: false, reason: isTimeout(error, signal) ? "timeout" : "fetch_failed" };
  }
}

function validatorsOf(headers: Headers): HttpValidators | null {
  const etag = headers.get("etag");
  const lastModified = headers.get("last-modified");
  return etag === null && lastModified === null ? null : { etag, lastModified };
}

function toLoaded(json: string, sourcesBase: string, http: HttpCacheInfo): LoadResult {
  const map = parseSourceMap(json);
  return map === null
    ? { status: "failed", reason: "invalid_source_map" }
    : { status: "loaded", map, sourcesBase, origin: "http", http };
}

async function loadExternalMap(
  mapUrl: URL,
  options: HttpLoaderOptions,
  module: HttpValidators | null,
  previousMap: HttpValidators | null,
): Promise<HttpLoadResult> {
  const mapResult = await fetchLimited(mapUrl, options, false, previousMap);
  if (!mapResult.ok) {
    return { status: "failed", reason: mapResult.reason };
  }
  if (mapResult.notModified) {
    return { status: "not_modified" };
  }
  return toLoaded(mapResult.text, mapResult.finalUrl.href, {
    module,
    mapUrl: mapUrl.href,
    map: validatorsOf(mapResult.headers),
  });
}

function allowedMapUrl(mapUrl: URL, moduleUrl: URL, options: HttpLoaderOptions): boolean {
  return mapUrl.origin === moduleUrl.origin && isAllowedUrl(mapUrl, options.allowedHosts);
}

/** The module answered 304; a map without validators is left to the cache TTL. */
async function revalidateMap(
  moduleUrl: URL,
  options: HttpLoaderOptions,
  previous: HttpCacheInfo | undefined,
): Promise<HttpLoadResult> {
  const mapHref = previous?.mapUrl ?? null;
  const mapValidators = previous?.map ?? null;
  if (previous === undefined || mapHref === null || mapValidators === null) {
    return { status: "not_modified" };
  }
  const mapUrl = URL.parse(mapHref);
  if (mapUrl === null || !allowedMapUrl(mapUrl, moduleUrl, options)) {
    return { status: "failed", reason: "map_not_allowed" };
  }
  return loadExternalMap(mapUrl, options, previous.module, mapValidators);
}

/**
 * Fetches a module from an allowed dev server and returns its source map. Never throws.
 * With `previous`, the module and an external map are requested conditionally:
 * `not_modified` when nothing changed; a changed module response is used as is.
 */
async function loadHttpSourceMap(
  url: URL,
  options: HttpLoaderOptions,
  previous?: HttpCacheInfo,
): Promise<HttpLoadResult> {
  if (!isAllowedUrl(url, options.allowedHosts)) {
    return { status: "skipped", reason: "host_not_allowed" };
  }
  const moduleResult = await fetchLimited(url, options, true, previous?.module ?? null);
  if (!moduleResult.ok) {
    return { status: "failed", reason: moduleResult.reason };
  }
  if (moduleResult.notModified) {
    return revalidateMap(url, options, previous);
  }
  const { finalUrl, headers, text } = moduleResult;
  const ref = findSourceMappingUrl(text) ?? headers.get("sourcemap") ?? headers.get("x-sourcemap");
  if (ref === null) {
    return { status: "failed", reason: "no_source_map" };
  }
  const reference = resolveMapReference(ref, finalUrl.href);
  if (reference === null || reference.kind === "path") {
    return { status: "failed", reason: "invalid_source_map" };
  }
  const module = validatorsOf(headers);
  if (reference.kind === "inline") {
    return toLoaded(reference.json, finalUrl.href, { module, mapUrl: null, map: null });
  }
  const mapUrl = new URL(reference.url);
  if (!allowedMapUrl(mapUrl, finalUrl, options)) {
    return { status: "failed", reason: "map_not_allowed" };
  }
  return loadExternalMap(mapUrl, options, module, null);
}

export { loadHttpSourceMap };
export type { HttpLoadResult, HttpLoaderOptions };
