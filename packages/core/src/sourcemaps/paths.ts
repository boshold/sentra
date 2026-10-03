import { fileURLToPath } from "node:url";

import type { Frame } from "#src/types.js";

type FrameLocation =
  | { kind: "http"; url: URL }
  | { kind: "file"; path: string }
  | { kind: "unsupported" };

const WEBPACK_SOURCE = /^webpack:\/\/[^/]*\/(?<rest>.*)$/;

function frameLocation(frame: Pick<Frame, "absPath" | "filename">): string | null {
  return frame.absPath ?? frame.filename;
}

function classifyLocation(location: string | null): FrameLocation {
  if (location === null || location === "") {
    return { kind: "unsupported" };
  }
  const lower = location.slice(0, 8).toLowerCase();
  if (lower.startsWith("http://") || lower.startsWith("https://")) {
    try {
      return { kind: "http", url: new URL(location) };
    } catch {
      return { kind: "unsupported" };
    }
  }
  if (lower.startsWith("file:")) {
    try {
      return { kind: "file", path: fileURLToPath(location) };
    } catch {
      return { kind: "unsupported" };
    }
  }
  if (location.startsWith("/")) {
    return { kind: "file", path: location };
  }
  return { kind: "unsupported" };
}

function stripQueryAndHash(value: string): string {
  const end = value.search(/[?#]/);
  return end === -1 ? value : value.slice(0, end);
}

function stripLeadingRelative(value: string): string {
  let result = value;
  while (result.startsWith("/") || result.startsWith("./")) {
    result = result.startsWith("/") ? result.slice(1) : result.slice(2);
  }
  return result;
}

function decodeSegment(segment: string): string {
  try {
    const decoded = decodeURIComponent(segment);
    return decoded.includes("/") || decoded === "." || decoded === ".." ? segment : decoded;
  } catch {
    return segment;
  }
}

/** Decodes per segment so `%2F` cannot introduce new path segments. */
function decodePathname(pathname: string): string {
  return pathname.split("/").map(decodeSegment).join("/");
}

/** Normalizes a map source for display (`MappedLocation.source`). */
function toDisplaySource(source: string, roots: readonly string[]): string {
  let value = source;
  let relative = false;

  const webpack = WEBPACK_SOURCE.exec(value);
  if (webpack) {
    value = webpack.groups?.rest ?? "";
    relative = true;
  } else if (/^https?:\/\//i.test(value)) {
    try {
      value = decodePathname(new URL(value).pathname);
      relative = true;
    } catch {
      // Keep as is
    }
  } else if (/^file:/i.test(value)) {
    try {
      value = fileURLToPath(value);
    } catch {
      // Keep as is
    }
  }

  value = stripQueryAndHash(value);

  if (value.startsWith("/_nuxt/")) {
    value = value.slice("/_nuxt".length);
    relative = true;
  }
  if (value.startsWith("/@fs/")) {
    value = value.slice("/@fs".length);
    relative = false;
  }

  let longestRoot = "";
  for (const root of roots) {
    const normalized = root.replace(/\/+$/, "");
    if (
      normalized !== "" &&
      normalized.length > longestRoot.length &&
      value.startsWith(`${normalized}/`)
    ) {
      longestRoot = normalized;
    }
  }
  if (longestRoot !== "") {
    value = value.slice(longestRoot.length);
    relative = true;
  }

  return relative ? stripLeadingRelative(value) : value;
}

export { classifyLocation, frameLocation, toDisplaySource };
export type { FrameLocation };
