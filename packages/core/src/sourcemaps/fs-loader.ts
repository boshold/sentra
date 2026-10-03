import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  MAX_SOURCE_BYTES,
  findSourceMappingUrl,
  parseSourceMap,
  resolveMapReference,
} from "#src/sourcemaps/extract.js";
import type { LoadResult } from "#src/sourcemaps/extract.js";

interface FsLoaderOptions {
  sourceRoots: readonly string[];
  maxBytes?: number;
}

interface ResolvedFsFile {
  realPath: string;
  mtimeMs: number;
  size: number;
}

const SSR_GUARD_EXTENSIONS: readonly string[] = [".vue", ".ts", ".tsx", ".mts", ".jsx"];

async function resolveRoot(root: string): Promise<string | null> {
  try {
    const real = await realpath(root);
    const info = await stat(real);
    return info.isDirectory() ? real : null;
  } catch {
    return null;
  }
}

async function resolveRoots(sourceRoots: readonly string[]): Promise<string[]> {
  const resolved = await Promise.all(sourceRoots.map(resolveRoot));
  return [...new Set(resolved.filter((root) => root !== null))];
}

function isInsideRoots(realPath: string, realRoots: readonly string[]): boolean {
  return realRoots.some((root) => {
    const prefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
    return realPath === root || realPath.startsWith(prefix);
  });
}

/** Realpath-checks `filePath` against the (already realpath'd) roots; only regular files pass. */
async function resolveInsideRoots(
  filePath: string,
  realRoots: readonly string[],
): Promise<ResolvedFsFile | null> {
  if (realRoots.length === 0 || !path.isAbsolute(filePath)) {
    return null;
  }
  try {
    const realPath = await realpath(filePath);
    if (!isInsideRoots(realPath, realRoots)) {
      return null;
    }
    const info = await stat(realPath);
    return info.isFile() ? { realPath, mtimeMs: info.mtimeMs, size: info.size } : null;
  } catch {
    return null;
  }
}

/** Reads a resolved file; `null` when it exceeds `maxBytes` (also re-checked after reading). */
async function readResolved(file: ResolvedFsFile, maxBytes: number): Promise<string | null> {
  if (file.size > maxBytes) {
    return null;
  }
  const bytes = await readFile(file.realPath);
  return bytes.byteLength > maxBytes ? null : bytes.toString("utf8");
}

function toLoaded(json: string, sourcesBase: string): LoadResult {
  const map = parseSourceMap(json);
  return map === null
    ? { status: "failed", reason: "invalid_source_map" }
    : { status: "loaded", map, sourcesBase, origin: "fs" };
}

async function loadMapFile(
  mapPath: string,
  realRoots: readonly string[],
  maxBytes: number,
): Promise<LoadResult> {
  const mapFile = await resolveInsideRoots(mapPath, realRoots);
  if (mapFile === null) {
    return { status: "failed", reason: "map_outside_source_root" };
  }
  const json = await readResolved(mapFile, maxBytes);
  return json === null
    ? { status: "failed", reason: "too_large" }
    : toLoaded(json, pathToFileURL(mapFile.realPath).href);
}

/** Loads the source map of a file returned by `resolveInsideRoots`. Never throws. */
async function loadFsSourceMap(
  file: ResolvedFsFile,
  realRoots: readonly string[],
  options: { maxBytes?: number } = {},
): Promise<LoadResult> {
  const maxBytes = options.maxBytes ?? MAX_SOURCE_BYTES;
  if (!isInsideRoots(file.realPath, realRoots)) {
    return { status: "skipped", reason: "outside_source_root" };
  }
  try {
    const code = await readResolved(file, maxBytes);
    if (code === null) {
      return { status: "failed", reason: "too_large" };
    }
    const ref = findSourceMappingUrl(code);
    if (ref === null) {
      return SSR_GUARD_EXTENSIONS.includes(path.extname(file.realPath).toLowerCase())
        ? { status: "unreliable", reason: "ssr_position_unreliable" }
        : { status: "failed", reason: "no_source_map" };
    }
    const reference = resolveMapReference(ref, file.realPath);
    if (reference === null || reference.kind === "url") {
      return { status: "failed", reason: "invalid_source_map" };
    }
    if (reference.kind === "inline") {
      return toLoaded(reference.json, pathToFileURL(file.realPath).href);
    }
    return await loadMapFile(reference.path, realRoots, maxBytes);
  } catch {
    return { status: "failed", reason: "read_failed" };
  }
}

/** Reads an original source for context lines; `null` on any failure or outside the roots. */
async function readSourceInsideRoots(
  filePath: string,
  realRoots: readonly string[],
  options: { maxBytes?: number } = {},
): Promise<string | null> {
  const file = await resolveInsideRoots(filePath, realRoots);
  if (file === null) {
    return null;
  }
  try {
    return await readResolved(file, options.maxBytes ?? MAX_SOURCE_BYTES);
  } catch {
    return null;
  }
}

export {
  SSR_GUARD_EXTENSIONS,
  loadFsSourceMap,
  readSourceInsideRoots,
  resolveInsideRoots,
  resolveRoots,
};
export type { FsLoaderOptions, ResolvedFsFile };
