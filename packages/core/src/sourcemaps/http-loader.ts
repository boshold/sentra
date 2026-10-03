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
}

type FetchResult =
  | { ok: true; text: string; finalUrl: URL; headers: Headers }
  | { ok: false; reason: string };

const DEFAULT_ALLOWED_HOSTS: readonly string[] = LOOPBACK_HOSTS;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 3;
const JAVASCRIPT_CONTENT_TYPE = /^(?:text|application)\/(?:x-)?(?:javascript|ecmascript)\b/i;

function addHost(hosts: Set<string>, entry: string): void {
  const value = entry.trim().toLowerCase();
  if (value === "") {
    return;
  }
  if (value.startsWith("[")) {
    const end = value.indexOf("]");
    if (end === -1) {
      return;
    }
    hosts.add(value.slice(0, end + 1));
    hosts.add(value.slice(1, end));
    return;
  }
  const colons = value.split(":").length - 1;
  if (colons > 1) {
    hosts.add(value);
    hosts.add(`[${value}]`);
    return;
  }
  hosts.add(colons === 1 ? value.slice(0, value.indexOf(":")) : value);
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

async function readLimited(response: Response, maxBytes: number): Promise<Uint8Array | null> {
  const contentLength = Number(response.headers.get("content-length") ?? Number.NaN);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    await cancelBody(response);
    return null;
  }
  if (response.body === null) {
    return new Uint8Array(0);
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- sequential stream reads
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    total += value.byteLength;
    if (total > maxBytes) {
      // oxlint-disable-next-line no-await-in-loop -- abort once, then return
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function fetchLimited(
  url: URL,
  options: HttpLoaderOptions,
  expectJavaScript: boolean,
): Promise<FetchResult> {
  const signal = AbortSignal.timeout(options.timeoutMs);
  const maxBytes = options.maxBytes ?? MAX_SOURCE_BYTES;
  let current = url;
  try {
    for (let hop = 0; ; hop += 1) {
      // oxlint-disable-next-line no-await-in-loop -- redirects are followed one by one
      const response = await fetch(current, {
        redirect: "manual",
        signal,
        credentials: "omit",
        headers: { accept: "*/*" },
      });
      if (REDIRECT_STATUSES.has(response.status)) {
        // oxlint-disable-next-line no-await-in-loop -- redirect body is discarded
        await cancelBody(response);
        const location = response.headers.get("location");
        const next =
          location === null || hop >= MAX_REDIRECTS ? null : URL.parse(location, current);
        if (
          next === null ||
          next.host !== current.host ||
          !isAllowedUrl(next, options.allowedHosts)
        ) {
          return { ok: false, reason: "redirect_not_allowed" };
        }
        current = next;
        continue;
      }
      if (response.status !== 200) {
        // oxlint-disable-next-line no-await-in-loop -- terminal branch
        await cancelBody(response);
        return { ok: false, reason: `http_status_${response.status}` };
      }
      if (
        expectJavaScript &&
        !JAVASCRIPT_CONTENT_TYPE.test(response.headers.get("content-type") ?? "")
      ) {
        // oxlint-disable-next-line no-await-in-loop -- terminal branch
        await cancelBody(response);
        return { ok: false, reason: "not_javascript" };
      }
      // oxlint-disable-next-line no-await-in-loop -- terminal branch
      const bytes = await readLimited(response, maxBytes);
      if (bytes === null) {
        return { ok: false, reason: "too_large" };
      }
      return {
        ok: true,
        text: new TextDecoder().decode(bytes),
        finalUrl: current,
        headers: response.headers,
      };
    }
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
