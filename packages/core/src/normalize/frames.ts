import { lenientArray, rawFrameSchema } from "#src/normalize/schemas.js";
import type { Frame } from "#src/types.js";

interface FrameOptions {
  platform: string | null;
  allowedHosts: readonly string[];
}

const LOOPBACK_HOSTS: readonly string[] = ["localhost", "127.0.0.1", "::1", "[::1]"];

const LIBRARY_PATH_MARKERS = ["/node_modules/", "/.vite/deps/", "/_nuxt/@fs/"] as const;
const FS_NODE_MODULES_PATTERN = /\/@fs\/.*\/node_modules\//;
const HTTP_URL_PATTERN = /^https?:\/\//i;

const framesSchema = lenientArray(rawFrameSchema);

function isForeignHost(location: string, allowedHosts: readonly string[]): boolean {
  if (!HTTP_URL_PATTERN.test(location) || !URL.canParse(location)) {
    return false;
  }
  const host = new URL(location).hostname.toLowerCase();
  return (
    !LOOPBACK_HOSTS.includes(host) &&
    !allowedHosts.some((allowed) => allowed.toLowerCase() === host)
  );
}

function computeInApp(
  location: string | null,
  sentInApp: boolean | null,
  options: FrameOptions,
): boolean {
  if (options.platform !== "javascript") {
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
  return !isForeignHost(location, options.allowedHosts);
}

function normalizeFrames(raw: unknown, options: FrameOptions): Frame[] {
  const parsed = framesSchema.parse(raw) ?? [];
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
      inApp: computeInApp(absPath ?? filename, frame.in_app ?? null, options),
      contextLine: frame.context_line ?? null,
      preContext: frame.pre_context ?? [],
      postContext: frame.post_context ?? [],
      positionReliable: true,
      mapped: null,
    };
  });
}

export { computeInApp, LOOPBACK_HOSTS, normalizeFrames };
export type { FrameOptions };
