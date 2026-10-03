import { LOOPBACK_HOSTS } from "#src/normalize/frames.js";
import {
  MAX_SOURCE_BYTES,
  findSourceMappingUrl,
  parseSourceMap,
  resolveMapReference,
} from "#src/sourcemaps/extract.js";
import type { LoadResult } from "#src/sourcemaps/extract.js";

interface HttpLoaderOptions {
  allowedHosts: ReadonlySet<string>;
  timeoutMs: number;
  maxBytes?: number;
  /** Shared deadline (e.g. per-envelope budget); combined with `timeoutMs` per fetch. */
  signal?: AbortSignal;
}

type FetchResult =
  | { ok: true; text: string; finalUrl: URL; headers: Headers }
  | { ok: false; reason: string };

const DEFAULT_ALLOWED_HOSTS: readonly string[] = LOOPBACK_HOSTS;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 3;
const JAVASCRIPT_CONTENT_TYPE = /^(?:text|application)\/(?:x-)?(?:javascript|ecmascript)\b/i;

/** Accepts `host`, `host:port`, `[v6]`, `[v6]:port` and bare IPv6; rejects anything URL-like. */
function addHost(hosts: Set<string>, entry: string): void {
  const value = entry.trim();
  if (value === "" || /[/\\@?#\s]/.test(value)) {
    return;
  }
  const isBareIpv6 = !value.startsWith("[") && value.split(":").length > 2;
  const hostname = URL.parse(`http://${isBareIpv6 ? `[${value}]` : value}`)?.hostname;
  if (hostname === undefined || hostname === "") {
    return;
  }
  hosts.add(hostname);
  if (hostname.startsWith("[")) {
    hosts.add(hostname.slice(1, -1));
  }
}

function normalizeAllowedHosts(extra: readonly string[]): Set<string> {
  const hosts = new Set<string>();
  for (const entry of [...DEFAULT_ALLOWED_HOSTS, ...extra]) {
    addHost(hosts, entry);
  }
  return hosts;
}

function isAllowedUrl(url: URL, allowedHosts: ReadonlySet<string>): boolean {
  return (
    (url.protocol === "http:" || url.protocol === "https:") &&
    url.username === "" &&
    url.password === "" &&
    allowedHosts.has(url.hostname.toLowerCase())
  );
}

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
}

async function fetchHop(current: URL, hop: number, context: FetchContext): Promise<FetchResult> {
  const { options, signal, expectJavaScript } = context;
  const response = await fetch(current, {
    redirect: "manual",
    signal,
    credentials: "omit",
    headers: { accept: "*/*" },
  });
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
  return { ok: true, text, finalUrl: current, headers: response.headers };
}

async function fetchLimited(
  url: URL,
  options: HttpLoaderOptions,
  expectJavaScript: boolean,
): Promise<FetchResult> {
  const timeout = AbortSignal.timeout(options.timeoutMs);
  const signal =
    options.signal === undefined ? timeout : AbortSignal.any([timeout, options.signal]);
  try {
    return await fetchHop(url, 0, { options, signal, expectJavaScript });
  } catch (error) {
    return { ok: false, reason: isTimeout(error, signal) ? "timeout" : "fetch_failed" };
  }
}

function toLoaded(json: string, sourcesBase: string): LoadResult {
  const map = parseSourceMap(json);
  return map === null
    ? { status: "failed", reason: "invalid_source_map" }
    : { status: "loaded", map, sourcesBase, origin: "http" };
}

/** Fetches a module from an allowed dev server and returns its source map. Never throws. */
async function loadHttpSourceMap(url: URL, options: HttpLoaderOptions): Promise<LoadResult> {
  if (!isAllowedUrl(url, options.allowedHosts)) {
    return { status: "skipped", reason: "host_not_allowed" };
  }
  const moduleResult = await fetchLimited(url, options, true);
  if (!moduleResult.ok) {
    return { status: "failed", reason: moduleResult.reason };
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
  if (reference.kind === "inline") {
    return toLoaded(reference.json, finalUrl.href);
  }
  const mapUrl = new URL(reference.url);
  if (mapUrl.origin !== finalUrl.origin || !isAllowedUrl(mapUrl, options.allowedHosts)) {
    return { status: "failed", reason: "map_not_allowed" };
  }
  const mapResult = await fetchLimited(mapUrl, options, false);
  if (!mapResult.ok) {
    return { status: "failed", reason: mapResult.reason };
  }
  return toLoaded(mapResult.text, mapResult.finalUrl.href);
}

export { DEFAULT_ALLOWED_HOSTS, isAllowedUrl, loadHttpSourceMap, normalizeAllowedHosts };
export type { HttpLoaderOptions };
