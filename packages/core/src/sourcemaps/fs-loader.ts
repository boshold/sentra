import { constants } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  MAX_SOURCE_BYTES,
  findSourceMappingUrl,
  parseSourceMap,
  resolveMapReference,
} from "#src/sourcemaps/extract.js";
import type { FsMapFile, LoadResult } from "#src/sourcemaps/extract.js";

interface FsLoaderOptions {
  sourceRoots: readonly string[];
  maxBytes?: number;
}

interface ResolvedFsFile {
  realPath: string;
  mtimeMs: number;
  size: number;
  /** Identity from `stat`; the opened handle must match it. */
  dev?: number;
  ino?: number;
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
    return info.isFile()
      ? { realPath, mtimeMs: info.mtimeMs, size: info.size, dev: info.dev, ino: info.ino }
      : null;
  } catch {
    return null;
  }
}

class FileChangedError extends Error {
  public override readonly name = "FileChangedError";
}

async function readInto(handle: FileHandle, buffer: Buffer, offset: number): Promise<number> {
  if (offset >= buffer.byteLength) {
    return offset;
  }
  const { bytesRead } = await handle.read(buffer, offset, buffer.byteLength - offset, offset);
  return bytesRead === 0 ? offset : readInto(handle, buffer, offset + bytesRead);
}

/**
 * Reads through one no-follow handle up to `maxBytes`; `null` if too large. Throws
 * `FileChangedError` if the file changed since `resolveInsideRoots`, so cache keys stay exact.
 */
async function readResolved(file: ResolvedFsFile, maxBytes: number): Promise<string | null> {
  if (file.size > maxBytes) {
    return null;
  }
  // oxlint-disable-next-line no-bitwise -- open(2) flag set
  const handle = await open(file.realPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (
      !info.isFile() ||
      info.mtimeMs !== file.mtimeMs ||
      (file.dev !== undefined && info.dev !== file.dev) ||
      (file.ino !== undefined && info.ino !== file.ino)
    ) {
      throw new FileChangedError(file.realPath);
    }
    if (info.size > maxBytes) {
      return null;
    }
    const buffer = Buffer.alloc(Math.min(info.size, maxBytes) + 1);
    const bytesRead = await readInto(handle, buffer, 0);
    if (bytesRead > maxBytes) {
      return null;
    }
    if (bytesRead !== info.size) {
      throw new FileChangedError(file.realPath);
    }
    return buffer.toString("utf8", 0, bytesRead);
  } finally {
    await handle.close();
  }
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
  if (json === null) {
    return { status: "failed", reason: "too_large" };
  }
  const loaded = toLoaded(json, pathToFileURL(mapFile.realPath).href);
  return loaded.status === "loaded"
    ? { ...loaded, mapFile: { ...mapFile, path: mapPath } }
    : loaded;
}

/** True when `mapFile` still resolves (inside the roots) to the same file, unchanged. */
async function isMapFileUnchanged(
  mapFile: FsMapFile,
  realRoots: readonly string[],
): Promise<boolean> {
  const current = await resolveInsideRoots(mapFile.path, realRoots);
  return (
    current !== null &&
    current.realPath === mapFile.realPath &&
    current.mtimeMs === mapFile.mtimeMs &&
    current.size === mapFile.size &&
    current.dev === mapFile.dev &&
    current.ino === mapFile.ino
  );
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
  isMapFileUnchanged,
  loadFsSourceMap,
  readSourceInsideRoots,
  resolveInsideRoots,
  resolveRoots,
};
export type { FsLoaderOptions, ResolvedFsFile };
