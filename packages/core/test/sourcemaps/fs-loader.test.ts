import { constants } from "node:fs";
import {
  mkdir,
  mkdtemp,
  open,
  realpath,
  rm,
  symlink,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import type { LoadResult } from "#src/sourcemaps/extract.js";
import {
  SSR_GUARD_EXTENSIONS,
  loadFsSourceMap,
  readSourceInsideRoots,
  resolveInsideRoots,
  resolveRoots,
} from "#src/sourcemaps/fs-loader.js";
import { classifyLocation } from "#src/sourcemaps/paths.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open) };
});

let base = "";
let root = "";
let outside = "";
let realRoots: string[] = [];

function mapJson(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    version: 3,
    sources: ["src/a.ts"],
    names: [],
    mappings: "AAAA",
    ...extra,
  });
}

function inlineComment(json: string = mapJson()): string {
  return `//# sourceMappingURL=data:application/json;base64,${Buffer.from(json).toString("base64")}`;
}

async function write(relPath: string, content: string): Promise<string> {
  const target = path.join(base, relPath);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content);
  return target;
}

function readPaths(): string[] {
  return vi.mocked(open).mock.calls.flatMap(([file]) => (typeof file === "string" ? [file] : []));
}

function readOutside(): boolean {
  return readPaths().some((file) => file.startsWith(outside));
}

async function load(filePath: string, maxBytes?: number): Promise<LoadResult | null> {
  const file = await resolveInsideRoots(filePath, realRoots);
  return file === null ? null : loadFsSourceMap(file, realRoots, { maxBytes });
}

beforeAll(async () => {
  base = await realpath(await mkdtemp(path.join(os.tmpdir(), "sentra-fs-")));
  root = path.join(base, "root");
  outside = path.join(base, "outside");
  await mkdir(root);
  await mkdir(outside);
  realRoots = await resolveRoots([root]);

  await write("outside/secret.js", `secret();\n${inlineComment()}\n`);
  await write("outside/secret.map", mapJson());
  await write("root/dist/app.js", `app();\n${inlineComment()}\n`);
  await write("root/.nuxt/dev/index.mjs", "boom();\n//# sourceMappingURL=index.mjs.map\n");
  await write("root/.nuxt/dev/index.mjs.map", mapJson({ sources: ["../../server/api/boom.ts"] }));
  await write("root/server/api/boom.ts", "export default () => {\n  throw new Error('boom')\n}\n");
  for (const file of ["app/pages/index.vue", "server/util.ts", "x.tsx", "x.mts", "x.jsx"]) {
    // oxlint-disable-next-line no-await-in-loop -- fixture setup
    await write(`root/${file}`, "export const a = 1;\n");
  }
  await write("root/plain.js", "plain();\n");
  await write("root/plain.mjs", "plain();\n");
  await write("root/a.ts", `export const a = 1;\n${inlineComment()}\n`);
  await write("root/evil.js", "evil();\n//# sourceMappingURL=../../outside/secret.map\n");
  await write("root/deep/evil.js", "evil();\n//# sourceMappingURL=../../../outside/secret.map\n");
  await write(
    "root/file-url.js",
    `evil();\n//# sourceMappingURL=${pathToFileURL(outside).href}/secret.map\n`,
  );
  await write(
    "root/encoded.js",
    `evil();\n//# sourceMappingURL=file://${root}/%2e%2e/outside/secret.map\n`,
  );
  await write("root/http.js", "h();\n//# sourceMappingURL=http://localhost:1/x.map\n");
  await write("root/missing-map.js", "m();\n//# sourceMappingURL=missing.js.map\n");
  await write("root/bad-map.js", "b();\n//# sourceMappingURL=bad-map.js.map\n");
  await write("root/bad-map.js.map", mapJson({ version: 2 }));
  await write("root/link-map.js", "l();\n//# sourceMappingURL=link-map.js.map\n");
  await symlink(path.join(outside, "secret.map"), path.join(root, "link-map.js.map"));
  await symlink(path.join(outside, "secret.js"), path.join(root, "link.js"));
  await symlink(outside, path.join(root, "outside-dir"));
  await symlink(root, path.join(base, "rootLink"));
  await write("root/big.js", "x".repeat(200));
  await write("x/app/a.js", "a();\n");
  await write("x/app2/a.js", "a();\n");
});

afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

beforeEach(() => {
  vi.mocked(open).mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("resolveRoots", () => {
  it("drops missing roots and files, dedupes, and realpaths", async () => {
    expect(
      await resolveRoots([
        "/does/not/exist",
        root,
        root,
        path.join(base, "rootLink"),
        path.join(root, "plain.js"),
      ]),
    ).toEqual([root]);
  });
});

describe("resolveInsideRoots", () => {
  it("returns real path, mtime and size", async () => {
    const result = await resolveInsideRoots(path.join(root, "plain.js"), realRoots);
    expect(result).toEqual({
      realPath: path.join(root, "plain.js"),
      mtimeMs: expect.any(Number),
      size: "plain();\n".length,
      dev: expect.any(Number),
      ino: expect.any(Number),
    });
  });

  it.each<[string, () => string]>([
    ["file outside roots", () => path.join(outside, "secret.js")],
    ["symlink escaping the root", () => path.join(root, "link.js")],
    ["file in symlinked dir escaping the root", () => path.join(root, "outside-dir/secret.js")],
    ["dot-dot traversal", () => path.join(root, "..", "outside", "secret.js")],
    ["raw dot-dot traversal", () => `${root}/../outside/secret.js`],
    ["missing file", () => path.join(root, "nope.js")],
    ["directory", () => path.join(root, "dist")],
    ["root itself", () => root],
    ["relative path", () => "root/plain.js"],
  ])("rejects %s", async (_name, filePath) => {
    expect(await resolveInsideRoots(filePath(), realRoots)).toBeNull();
    expect(readOutside()).toBe(false);
  });

  it("rejects an encoded traversal in a file:// frame location", async () => {
    const location = classifyLocation(`file://${root}/%2e%2e/outside/secret.js`);
    expect(location).toEqual({ kind: "file", path: path.join(outside, "secret.js") });
    expect(
      await resolveInsideRoots(location.kind === "file" ? location.path : "", realRoots),
    ).toBeNull();
  });

  it("rejects a sibling dir sharing the root prefix", async () => {
    const roots = await resolveRoots([path.join(base, "x/app")]);
    expect(await resolveInsideRoots(path.join(base, "x/app/a.js"), roots)).not.toBeNull();
    expect(await resolveInsideRoots(path.join(base, "x/app2/a.js"), roots)).toBeNull();
  });

  it("returns null with empty roots", async () => {
    expect(await resolveInsideRoots(path.join(root, "plain.js"), [])).toBeNull();
  });

  it("resolves files through a symlinked root", async () => {
    const roots = await resolveRoots([path.join(base, "rootLink")]);
    const viaLink = await resolveInsideRoots(path.join(base, "rootLink/plain.js"), roots);
    const direct = await resolveInsideRoots(path.join(root, "plain.js"), roots);
    expect(viaLink?.realPath).toBe(path.join(root, "plain.js"));
    expect(direct?.realPath).toBe(path.join(root, "plain.js"));
  });
});

describe("loadFsSourceMap", () => {
  it("loads an inline map", async () => {
    expect(await load(path.join(root, "dist/app.js"))).toEqual({
      status: "loaded",
      map: JSON.parse(mapJson()),
      sourcesBase: pathToFileURL(path.join(root, "dist/app.js")).href,
      origin: "fs",
    });
    // Proves the open mock intercepts the loader's reads.
    expect(readPaths()).toContain(path.join(root, "dist/app.js"));
  });

  it("loads a sibling map without sourcesContent", async () => {
    const result = await load(path.join(root, ".nuxt/dev/index.mjs"));
    expect(result).toMatchObject({
      status: "loaded",
      sourcesBase: pathToFileURL(path.join(root, ".nuxt/dev/index.mjs.map")).href,
      origin: "fs",
    });
    expect(result?.status === "loaded" ? result.map.sourcesContent : "x").toBeUndefined();
  });

  it.each(["app/pages/index.vue", "server/util.ts", "x.tsx", "x.mts", "x.jsx"])(
    "flags %s without map comment as unreliable",
    async (file) => {
      expect(await load(path.join(root, file))).toEqual({
        status: "unreliable",
        reason: "ssr_position_unreliable",
      });
    },
  );

  it.each(["plain.js", "plain.mjs"])("reports %s without map comment", async (file) => {
    expect(await load(path.join(root, file))).toEqual({
      status: "failed",
      reason: "no_source_map",
    });
  });

  it("maps a .ts file with a map comment", async () => {
    expect(await load(path.join(root, "a.ts"))).toMatchObject({ status: "loaded" });
  });

  it.each([
    ["evil.js", "relative traversal"],
    ["deep/evil.js", "deep relative traversal"],
    ["file-url.js", "file:// ref outside"],
    ["encoded.js", "encoded %2e%2e file:// ref"],
    ["link-map.js", "symlinked map escaping the root"],
    ["missing-map.js", "missing map"],
  ])("rejects map of %s (%s)", async (file) => {
    expect(await load(path.join(root, file))).toEqual({
      status: "failed",
      reason: "map_outside_source_root",
    });
    expect(readOutside()).toBe(false);
  });

  it("never fetches an http map reference", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    expect(await load(path.join(root, "http.js"))).toEqual({
      status: "failed",
      reason: "invalid_source_map",
    });
    expect(spy).not.toHaveBeenCalled();
  });

  it("rejects an invalid map file", async () => {
    expect(await load(path.join(root, "bad-map.js"))).toEqual({
      status: "failed",
      reason: "invalid_source_map",
    });
  });

  it("rejects a file above maxBytes without reading it", async () => {
    expect(await load(path.join(root, "big.js"), 100)).toEqual({
      status: "failed",
      reason: "too_large",
    });
    expect(readPaths()).not.toContain(path.join(root, "big.js"));
  });

  it("skips a file whose real path is outside the roots", async () => {
    const file = { realPath: path.join(outside, "secret.js"), mtimeMs: 0, size: 10 };
    expect(await loadFsSourceMap(file, realRoots)).toEqual({
      status: "skipped",
      reason: "outside_source_root",
    });
    expect(readOutside()).toBe(false);
  });

  it("reports a vanished file as read_failed", async () => {
    const file = { realPath: path.join(root, "vanished.js"), mtimeMs: 0, size: 10 };
    expect(await loadFsSourceMap(file, realRoots)).toEqual({
      status: "failed",
      reason: "read_failed",
    });
  });

  it("guards exactly the SSR extensions", () => {
    expect(SSR_GUARD_EXTENSIONS).toEqual([".vue", ".ts", ".tsx", ".mts", ".jsx"]);
  });
});

describe("bounded no-follow reads", () => {
  const FIXED_TIME = 1_700_000_000;

  async function pinned(relPath: string, content: string): Promise<string> {
    const target = await write(relPath, content);
    await utimes(target, FIXED_TIME, FIXED_TIME);
    return target;
  }

  it("fails when the file was modified after resolving", async () => {
    const target = await write("root/race/modified.js", `m();\n${inlineComment()}\n`);
    const file = await resolveInsideRoots(target, realRoots);
    await writeFile(target, "changed();\n");
    await utimes(target, FIXED_TIME, FIXED_TIME);
    expect(file).not.toBeNull();
    expect(file === null ? null : await loadFsSourceMap(file, realRoots)).toEqual({
      status: "failed",
      reason: "read_failed",
    });
  });

  it("refuses a file swapped for a symlink after resolving", async () => {
    const target = await write("root/race/swapped.js", `s();\n${inlineComment()}\n`);
    const file = await resolveInsideRoots(target, realRoots);
    await unlink(target);
    await symlink(path.join(outside, "secret.js"), target);
    expect(file === null ? null : await loadFsSourceMap(file, realRoots)).toEqual({
      status: "failed",
      reason: "read_failed",
    });
  });

  it("does not read a file that grew past maxBytes after resolving", async () => {
    const target = await pinned("root/race/grown.js", "g();\n");
    const file = await resolveInsideRoots(target, realRoots);
    await writeFile(target, "x".repeat(500));
    await utimes(target, FIXED_TIME, FIXED_TIME);
    expect(
      file === null ? null : await loadFsSourceMap(file, realRoots, { maxBytes: 100 }),
    ).toEqual({ status: "failed", reason: "too_large" });
  });

  it("returns null from readSourceInsideRoots for a source swapped for a symlink", async () => {
    const target = await write("root/race/source.ts", "export const a = 1;\n");
    expect(await readSourceInsideRoots(target, realRoots)).toBe("export const a = 1;\n");
    await unlink(target);
    await symlink(path.join(outside, "secret.js"), target);
    expect(await readSourceInsideRoots(target, realRoots)).toBeNull();
  });

  it("opens with O_NOFOLLOW", async () => {
    await load(path.join(root, "dist/app.js"));
    const flags = vi.mocked(open).mock.calls.map(([, flag]) => flag);
    expect(flags.length).toBeGreaterThan(0);
    for (const flag of flags) {
      // oxlint-disable-next-line no-bitwise -- open(2) flag check
      expect(typeof flag === "number" && (flag & constants.O_NOFOLLOW) !== 0).toBe(true);
    }
  });
});

describe("readSourceInsideRoots", () => {
  it("reads a file inside the roots", async () => {
    expect(await readSourceInsideRoots(path.join(root, "server/api/boom.ts"), realRoots)).toBe(
      "export default () => {\n  throw new Error('boom')\n}\n",
    );
  });

  it.each<[string, () => string]>([
    ["outside", () => path.join(outside, "secret.js")],
    ["directory", () => path.join(root, "server")],
    ["missing", () => path.join(root, "nope.ts")],
    ["traversal", () => `${root}/../outside/secret.js`],
  ])("returns null for %s", async (_name, filePath) => {
    expect(await readSourceInsideRoots(filePath(), realRoots)).toBeNull();
    expect(readOutside()).toBe(false);
  });

  it("returns null above maxBytes", async () => {
    expect(
      await readSourceInsideRoots(path.join(root, "big.js"), realRoots, { maxBytes: 100 }),
    ).toBeNull();
  });
});
