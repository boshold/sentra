import { lenientArray, rawFrameSchema } from "#src/normalize/schemas.js";
import { isAllowedHostname, normalizeAllowedHosts } from "#src/sourcemaps/hosts.js";
import type { Frame } from "#src/types.js";

interface FrameOptions {
  platform: string | null;
  allowedHosts: readonly string[];
}

const LIBRARY_PATH_MARKERS = ["/node_modules/", "/.vite/deps/", "/_nuxt/@fs/"] as const;
const FS_NODE_MODULES_PATTERN = /\/@fs\/.*\/node_modules\//;
const HTTP_URL_PATTERN = /^https?:\/\//i;

const framesSchema = lenientArray(rawFrameSchema);

/** Same `host` / `host:port` matching as the HTTP source-map loader. */
function isForeignHost(location: string, allowedHosts: ReadonlySet<string>): boolean {
  const url = HTTP_URL_PATTERN.test(location) ? URL.parse(location) : null;
  return url !== null && !isAllowedHostname(url, allowedHosts);
}

function inAppFor(
  location: string | null,
  sentInApp: boolean | null,
  platform: string | null,
  allowedHosts: ReadonlySet<string>,
): boolean {
  if (platform !== "javascript") {
    return sentInApp ?? true;
  }
  if (location === null) {
    return true;
  }
  if (
    LIBRARY_PATH_MARKERS.some((marker) => location.includes(marker)) ||
    FS_NODE_MODULES_PATTERN.test(location)
  ) {
    return false;
  }
  return !isForeignHost(location, allowedHosts);
}

function computeInApp(
  location: string | null,
  sentInApp: boolean | null,
  options: FrameOptions,
): boolean {
  return inAppFor(
    location,
    sentInApp,
    options.platform,
    normalizeAllowedHosts(options.allowedHosts),
  );
}

function normalizeFrames(raw: unknown, options: FrameOptions): Frame[] {
  const parsed = framesSchema.parse(raw) ?? [];
  const allowedHosts = normalizeAllowedHosts(options.allowedHosts);
  return parsed.map((frame): Frame => {
    const filename = frame.filename ?? null;
    const absPath = frame.abs_path ?? null;
    return {
      filename,
      absPath,
      function: frame.function ?? null,
      module: frame.module ?? null,
      lineno: frame.lineno ?? null,
      colno: frame.colno ?? null,
      inApp: inAppFor(absPath ?? filename, frame.in_app ?? null, options.platform, allowedHosts),
      contextLine: frame.context_line ?? null,
      preContext: frame.pre_context ?? [],
      postContext: frame.post_context ?? [],
      positionReliable: true,
      mapped: null,
    };
  });
}

export { computeInApp, normalizeFrames };
export type { FrameOptions };
