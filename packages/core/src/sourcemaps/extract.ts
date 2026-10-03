import path from "node:path";
import { fileURLToPath } from "node:url";

import { array, literal, looseObject, string, union, null as zodNull } from "zod";
import type { ZodType } from "zod";

const MAX_SOURCE_BYTES = 20 * 1024 * 1024;

interface RawSourceMap {
  version: 3;
  mappings: string;
  sources: (string | null)[];
  names: string[];
  sourcesContent?: (string | null)[];
  sourceRoot?: string;
  file?: string;
}

const nullableString = union([string(), zodNull()]);

const rawSourceMapSchema: ZodType<RawSourceMap> = looseObject({
  version: literal(3),
  mappings: string(),
  sources: array(nullableString),
  names: array(string()).default([]),
  sourcesContent: array(nullableString).optional(),
  sourceRoot: string().optional(),
  file: string().optional(),
});

type MapReference =
  | { kind: "inline"; json: string }
  | { kind: "url"; url: string }
  | { kind: "path"; path: string };

type LoadResult =
  | { status: "loaded"; map: RawSourceMap; sourcesBase: string; origin: "http" | "fs" }
  | { status: "unreliable"; reason: string }
  | { status: "skipped"; reason: string }
  | { status: "failed"; reason: string };

const MARKER = "sourceMappingURL=";
const COMMENT_PREFIX = /^[ \t]*(?:\/\/[#@]|\/\*#)[ \t]*$/;
const BASE64_BODY = /^[A-Za-z0-9+/\-_]*={0,2}$/;
const URL_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;

/** Value of the last valid `sourceMappingURL` comment, scanning from the end (no backtracking regex). */
function findSourceMappingUrl(code: string): string | null {
  let searchFrom = code.length;
  while (searchFrom >= 0) {
    const index = code.lastIndexOf(MARKER, searchFrom);
    if (index === -1) {
      return null;
    }
    searchFrom = index - 1;
    const lineStart = code.lastIndexOf("\n", index - 1) + 1;
    const prefix = code.slice(lineStart, index);
    if (!COMMENT_PREFIX.test(prefix)) {
      continue;
    }
    const lineEnd = code.indexOf("\n", index);
    let value = code.slice(index + MARKER.length, lineEnd === -1 ? code.length : lineEnd).trim();
    if (prefix.includes("/*")) {
      const close = value.indexOf("*/");
      if (close === -1) {
        continue;
      }
      value = value.slice(0, close).trim();
    }
    if (value !== "") {
      return value;
    }
  }
  return null;
}

/** Decodes a `data:application/json` URL (base64 or percent-encoded). */
function decodeDataUrl(url: string): string | null {
  if (!url.slice(0, 5).toLowerCase().startsWith("data:")) {
    return null;
  }
  const comma = url.indexOf(",");
  if (comma === -1) {
    return null;
  }
  const params = url.slice(5, comma).split(";");
  const mediaType = (params.shift() ?? "").trim().toLowerCase();
  if (mediaType !== "application/json") {
    return null;
  }
  let isBase64 = false;
  for (const param of params) {
    const normalized = param.trim().toLowerCase();
    if (normalized === "base64") {
      isBase64 = true;
    } else if (!normalized.includes("=")) {
      return null;
    }
  }
  const body = url.slice(comma + 1);
  if (isBase64) {
    const compact = body.replace(/\s+/g, "");
    if (!BASE64_BODY.test(compact) || compact.length % 4 === 1) {
      return null;
    }
    return Buffer.from(compact, "base64").toString("utf8");
  }
  try {
    return decodeURIComponent(body);
  } catch {
    return null;
  }
}

function toAbsolutePath(base: string): string | null {
  if (base.startsWith("/")) {
    return base;
  }
  if (base.startsWith("file:")) {
    try {
      return fileURLToPath(base);
    } catch {
      return null;
    }
  }
  return null;
}

/** Resolves a `sourceMappingURL` value against the module URL or absolute file path. */
function resolveMapReference(ref: string, base: string): MapReference | null {
  const trimmed = ref.trim();
  if (trimmed === "") {
    return null;
  }
  if (trimmed.slice(0, 5).toLowerCase() === "data:") {
    const json = decodeDataUrl(trimmed);
    return json === null ? null : { kind: "inline", json };
  }
  if (/^https?:\/\//i.test(base)) {
    try {
      const url = new URL(trimmed, base);
      return url.protocol === "http:" || url.protocol === "https:"
        ? { kind: "url", url: url.href }
        : null;
    } catch {
      return null;
    }
  }
  const basePath = toAbsolutePath(base);
  if (basePath === null) {
    return null;
  }
  if (URL_SCHEME.test(trimmed)) {
    if (!trimmed.toLowerCase().startsWith("file:")) {
      return null;
    }
    try {
      return { kind: "path", path: fileURLToPath(trimmed) };
    } catch {
      return null;
    }
  }
  return { kind: "path", path: path.resolve(path.dirname(basePath), trimmed) };
}

function parseJson(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

/** Parses and validates a v3 source map. Index maps (`sections`) are rejected. */
function parseSourceMap(json: string): RawSourceMap | null {
  const parsed = parseJson(json);
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed) ||
    "sections" in parsed
  ) {
    return null;
  }
  const result = rawSourceMapSchema.safeParse(parsed);
  return result.success ? result.data : null;
}

export {
  MAX_SOURCE_BYTES,
  decodeDataUrl,
  findSourceMappingUrl,
  parseSourceMap,
  rawSourceMapSchema,
  resolveMapReference,
};
export type { LoadResult, MapReference, RawSourceMap };
