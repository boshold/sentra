import { cp, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createSentra, memoryStorage } from "@boshold/sentra-core";
import type { EventData, Frame, Item, Sentra } from "@boshold/sentra-core";
import vue from "@vitejs/plugin-vue";
import { build } from "esbuild";
import { createServer } from "vite";
import type { ViteDevServer } from "vite";

import { eventEnvelope } from "./helpers/envelope.js";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const FIXTURES = path.join(REPO_ROOT, "test/fixtures/sourcemaps");
const SECRET_MARKER = "TOP_SECRET_OUTSIDE_ROOT";

let work = "";
let outside = "";
let server: ViteDevServer | null = null;
let origin = "";
let cardUrl = "";
let cardCode = "";
let bundlePath = "";
let bundleCode = "";
let sentra: Sentra;
const extraInstances: Sentra[] = [];

function locate(code: string, needle: string): { lineno: number; colno: number } {
  const lines = code.split("\n");
  const index = lines.findIndex((line) => line.includes(needle));
  if (index === -1) {
    throw new Error(`needle not found: ${needle}`);
  }
  return { lineno: index + 1, colno: (lines[index] ?? "").indexOf(needle) + 1 };
}

async function sendWith(
  instance: Sentra,
  frames: Record<string, unknown>[],
  platform: string,
): Promise<Item | null> {
  const { eventId, request } = eventEnvelope({ platform, frames });
  const response = await instance.handle(request);
  expect(response.status).toBe(200);
  return instance.query.getItemByEventId(eventId);
}

async function send(frames: Record<string, unknown>[], platform: string): Promise<Item | null> {
  return sendWith(sentra, frames, platform);
}

function dataOf(item: Item | null): EventData {
  if (item?.kind !== "error") {
    throw new Error("expected an error record");
  }
  return item.data;
}

function frameOf(item: Item | null): Frame {
  const frame = dataOf(item).exceptions.at(-1)?.frames.at(-1);
  if (frame === undefined) {
    throw new Error("expected a frame");
  }
  return frame;
}

function cardFrame(absPath: string): Record<string, unknown> {
  const { lineno, colno } = locate(cardCode, "new Error(");
  return {
    abs_path: absPath,
    filename: "/src/components/Card.vue",
    function: "explode",
    lineno,
    colno,
    in_app: true,
  };
}

function bundleFrame(filename: string): Record<string, unknown> {
  const { lineno, colno } = locate(bundleCode, 'new Error("nitro boom');
  return { filename, function: "boom", lineno, colno, in_app: true };
}

function secretFrame(): Record<string, unknown> {
  return { filename: path.join(outside, "secret.js"), function: "secret", lineno: 2, colno: 1 };
}

async function startVite(root: string): Promise<void> {
  await symlink(path.join(REPO_ROOT, "node_modules"), path.join(root, "node_modules"), "dir");
  server = await createServer({
    configFile: false,
    root,
    cacheDir: path.join(work, ".vite-cache"),
    plugins: [vue()],
    server: { port: 0, host: "127.0.0.1" },
    logLevel: "error",
  });
  await server.listen();
  const address = server.httpServer?.address();
  if (address === null || address === undefined || typeof address === "string") {
    throw new Error("vite has no address");
  }
  const { port } = address satisfies AddressInfo;
  origin = `http://127.0.0.1:${port}`;
  cardUrl = `${origin}/src/components/Card.vue`;
  const response = await fetch(cardUrl);
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("javascript")) {
    throw new Error(`vite served Card.vue as ${contentType} (${response.status})`);
  }
  cardCode = await response.text();
}

async function buildNitroBundle(appRoot: string): Promise<void> {
  bundlePath = path.join(appRoot, ".nuxt/dev/index.mjs");
  await build({
    entryPoints: [path.join(appRoot, "server/api/boom.ts")],
    outfile: bundlePath,
    bundle: true,
    format: "esm",
    platform: "node",
    sourcemap: "external",
    sourcesContent: false,
    logLevel: "silent",
  });
  bundleCode = await readFile(bundlePath, "utf8");
  if (!bundleCode.includes("sourceMappingURL=")) {
    bundleCode += "\n//# sourceMappingURL=index.mjs.map\n";
    await writeFile(bundlePath, bundleCode);
  }
  const map: unknown = JSON.parse(await readFile(`${bundlePath}.map`, "utf8"));
  if (typeof map !== "object" || map === null || "sourcesContent" in map) {
    throw new Error("nitro-style map must not contain sourcesContent");
  }
}

async function writeOutside(): Promise<void> {
  const map = {
    version: 3,
    sources: ["secret.ts"],
    sourcesContent: [`const secret = "${SECRET_MARKER}";\nthrow new Error(secret);\n`],
    names: [],
    mappings: "AAAA;AACA",
  };
  const inline = Buffer.from(JSON.stringify(map)).toString("base64");
  await writeFile(
    path.join(outside, "secret.js"),
    `const secret = "${SECRET_MARKER}";\nthrow new Error(secret);\n//# sourceMappingURL=data:application/json;base64,${inline}\n`,
  );
  await writeFile(path.join(outside, "secret.txt"), `${SECRET_MARKER}\n`);
}

beforeAll(async () => {
  work = await realpath(await mkdtemp(path.join(os.tmpdir(), "sentra-sm-")));
  outside = await realpath(await mkdtemp(path.join(os.tmpdir(), "sentra-sm-outside-")));
  await cp(FIXTURES, work, { recursive: true });
  const nitroApp = path.join(work, "nitro-app");
  await Promise.all([
    startVite(path.join(work, "vite-app")),
    buildNitroBundle(nitroApp),
    writeOutside(),
  ]);
  await symlink(path.join(outside, "secret.js"), path.join(nitroApp, "link.js"));
  await writeFile(
    path.join(nitroApp, "evil.mjs"),
    `evil();\n//# sourceMappingURL=${path.relative(nitroApp, path.join(outside, "secret.txt"))}\n`,
  );
  sentra = await createSentra({
    storage: memoryStorage(),
    sourceMaps: { sourceRoots: [nitroApp, path.join(work, "ssr-app")] },
  });
}, 30_000);

afterAll(async () => {
  await server?.close();
  await sentra?.close();
  await Promise.all(extraInstances.map(async (instance) => instance.close()));
  await rm(work, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

describe("vite dev server", () => {
  it("(a) maps a .vue frame to the original SFC line", async () => {
    const item = await send([cardFrame(cardUrl)], "javascript");
    const frame = frameOf(item);
    expect(frame.mapped).toMatchObject({
      lineno: 8,
      colno: 9,
      source: "src/components/Card.vue",
      contextLine: "  throw new Error('boom ' + doubled)",
    });
    expect(frame.mapped?.preContext).toHaveLength(5);
    expect(frame.mapped?.preContext).toContain("function explode(input: number): number {");
    expect(frame.positionReliable).toBe(true);
    expect(dataOf(item).sourceMaps).toEqual({
      status: "full",
      mappedFrames: 1,
      candidateFrames: 1,
      errors: [],
    });
  });

  it("(a2) keeps the query string", async () => {
    const item = await send([cardFrame(`${cardUrl}?t=1700000000000`)], "javascript");
    expect(frameOf(item).mapped).toMatchObject({ lineno: 8, colno: 9 });
  });

  it("(a3) does not map an unknown .vue URL", async () => {
    const item = await send([cardFrame(`${origin}/src/components/Missing.vue`)], "javascript");
    expect(frameOf(item).mapped).toBeNull();
    expect(dataOf(item).sourceMaps.status).toBe("none");
    expect(dataOf(item).sourceMaps.errors[0]?.reason).toBe("not_javascript");
  });

  it("(a4) ignores hosts outside the allowlist", async () => {
    const url = cardUrl.replace("127.0.0.1", "localhost.example.test");
    const item = await send([cardFrame(url)], "javascript");
    expect(frameOf(item).mapped).toBeNull();
    expect(dataOf(item).sourceMaps).toMatchObject({ candidateFrames: 0, status: "not_applicable" });
  });

  it("(a5) groups by the mapped source", async () => {
    const instance = await createSentra({ storage: memoryStorage() });
    extraInstances.push(instance);
    await sendWith(instance, [cardFrame(`${cardUrl}?t=1`)], "javascript");
    await sendWith(instance, [cardFrame(`${cardUrl}?t=2`)], "javascript");
    const issues = await instance.query.listIssues();
    expect(issues.items).toHaveLength(1);
    expect(issues.items[0]?.count).toBe(2);
  });
});

describe("nitro-style bundle", () => {
  it.each([
    ["(b) file:// URL", () => pathToFileURL(bundlePath).href],
    ["(b2) absolute path", () => bundlePath],
  ])("%s maps to the original source with context from disk", async (_name, filename) => {
    const item = await send([bundleFrame(filename())], "node");
    const { mapped } = frameOf(item);
    expect(mapped).toMatchObject({
      source: "server/api/boom.ts",
      lineno: 3,
      absPath: path.join(work, "nitro-app/server/api/boom.ts"),
    });
    expect(mapped?.contextLine).toContain('throw new Error("nitro boom "');
    expect(mapped?.preContext).toHaveLength(2);
    expect(dataOf(item).sourceMaps.status).toBe("full");
  });
});

describe("ssr-style .vue", () => {
  it("(c) flags the frame as unreliable and drops SDK context", async () => {
    const item = await send(
      [
        {
          filename: path.join(work, "ssr-app/app/pages/index.vue"),
          function: "setup",
          lineno: 31,
          colno: 9,
          context_line: "wrong",
          pre_context: ["x"],
          post_context: ["y"],
          in_app: true,
        },
      ],
      "node",
    );
    const frame = frameOf(item);
    expect(frame).toMatchObject({
      positionReliable: false,
      mapped: null,
      contextLine: null,
      preContext: [],
      postContext: [],
      lineno: 31,
    });
    expect(dataOf(item).sourceMaps.errors[0]?.reason).toBe("ssr_position_unreliable");
  });
});

describe("source root boundaries", () => {
  it("(d) never reads a file outside the roots", async () => {
    const item = await send([secretFrame()], "node");
    expect(frameOf(item).mapped).toBeNull();
    expect(dataOf(item).sourceMaps).toEqual({
      status: "not_applicable",
      candidateFrames: 0,
      mappedFrames: 0,
      errors: [],
    });
    expect(JSON.stringify(item)).not.toContain(SECRET_MARKER);
  });

  it("(d2) does not follow a symlink out of the root", async () => {
    const item = await send(
      [{ filename: path.join(work, "nitro-app/link.js"), lineno: 2, colno: 1 }],
      "node",
    );
    expect(frameOf(item).mapped).toBeNull();
    expect(dataOf(item).sourceMaps.candidateFrames).toBe(0);
    expect(JSON.stringify(item)).not.toContain(SECRET_MARKER);
  });

  it("(d3) does not follow a map reference out of the root", async () => {
    const item = await send(
      [{ filename: path.join(work, "nitro-app/evil.mjs"), lineno: 1, colno: 1 }],
      "node",
    );
    expect(frameOf(item).mapped).toBeNull();
    expect(dataOf(item).sourceMaps.errors[0]?.reason).toBe("map_outside_source_root");
    expect(JSON.stringify(item)).not.toContain(SECRET_MARKER);
  });

  it("(e) maps after addSourceRoot and stops after removeSourceRoot", async () => {
    sentra.addSourceRoot(outside);
    const mapped = await send([secretFrame()], "node");
    expect(frameOf(mapped).mapped).toMatchObject({ source: "secret.ts", lineno: 2 });
    sentra.removeSourceRoot(outside);
    const unmapped = await send([secretFrame()], "node");
    expect(frameOf(unmapped).mapped).toBeNull();
    expect(dataOf(unmapped).sourceMaps.candidateFrames).toBe(0);
  });
});
