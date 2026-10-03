import { mkdir, mkdtemp, realpath, rm, utimes, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { SentraConfigError } from "#src/errors.js";
import type { NewItem } from "#src/normalize/types.js";
import { loadHttpSourceMap } from "#src/sourcemaps/http-loader.js";
import { createSourceMapResolver } from "#src/sourcemaps/resolver.js";
import type { SourceMapResolverOptions } from "#src/sourcemaps/resolver.js";
import type { EventData, Frame, Item, ItemSummary, SentraLogger } from "#src/types.js";

vi.mock("#src/sourcemaps/http-loader.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("#src/sourcemaps/http-loader.js")>();
  return { ...actual, loadHttpSourceMap: vi.fn(actual.loadHttpSourceMap) };
});

let server: Server;
let origin = "";
let base = "";
let root = "";
const requests: string[] = [];

function inline(map: object): string {
  return `//# sourceMappingURL=data:application/json;base64,${Buffer.from(JSON.stringify(map)).toString("base64")}`;
}

const moduleMap = {
  version: 3,
  sources: ["orig.ts"],
  sourcesContent: ["const a = 1;\nthrow new Error('x');\n"],
  names: [],
  mappings: ";AACA",
};

function frame(location: string, lineno = 1, colno = 1): Frame {
  return {
    filename: location,
    absPath: location,
    function: "fn",
    module: null,
    lineno,
    colno,
    inApp: true,
    contextLine: "sdk line",
    preContext: ["sdk pre"],
    postContext: ["sdk post"],
    positionReliable: true,
    mapped: null,
  };
}

function event(frames: Frame[], stacktrace: Frame[] = []): EventData {
  return {
    message: null,
    exceptions: [{ type: "Error", value: "boom", module: null, mechanism: null, frames }],
    stacktrace,
    culprit: null,
    transaction: null,
    logger: null,
    dist: null,
    serverName: null,
    user: null,
    request: null,
    tags: {},
    contexts: {},
    extra: {},
    breadcrumbs: [],
    sdk: null,
    fingerprint: [],
    sourceMaps: { status: "not_applicable", mappedFrames: 0, candidateFrames: 0, errors: [] },
  };
}

function summary(kind: ItemSummary["kind"]): ItemSummary {
  return {
    id: `id-${kind}`,
    envelopeId: "env",
    scope: { project: "default", session: "default", service: "default" },
    kind,
    itemType: kind,
    receivedAt: "2026-01-01T00:00:00.000Z",
    timestamp: "2026-01-01T00:00:00.000Z",
    eventId: null,
    issueId: null,
    traceId: null,
    level: null,
    environment: null,
    release: null,
    platform: null,
    title: kind,
  };
}

function newItem(item: Item): NewItem {
  return { item, blob: null, grouping: null, warnings: [] };
}

function framesOf(data: EventData): Frame[] {
  return data.exceptions[0]?.frames ?? [];
}

function silentLogger(): SentraLogger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function resolver(overrides: Partial<SourceMapResolverOptions> = {}) {
  return createSourceMapResolver({
    allowedHosts: [],
    sourceRoots: [root],
    fetchTimeoutMs: 1500,
    budgetMs: 3000,
    logger: silentLogger(),
    ...overrides,
  });
}

function count(url: string): number {
  return requests.filter((entry) => entry === url).length;
}

async function write(relPath: string, content: string): Promise<string> {
  const target = path.join(root, relPath);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content);
  return target;
}

beforeAll(async () => {
  base = await realpath(await mkdtemp(path.join(os.tmpdir(), "sentra-resolver-")));
  root = path.join(base, "root");
  await mkdir(root);
  await write("secret.ts", "top secret\n");
  server = createServer((req, res) => {
    const url = req.url ?? "/";
    requests.push(url);
    const { pathname } = new URL(url, "http://x");
    const js = (body: string): void => {
      res.writeHead(200, { "content-type": "text/javascript" });
      res.end(body);
    };
    if (pathname.startsWith("/mod")) {
      js(`a();\nthrow 1;\n${inline(moduleMap)}\n`);
    } else if (pathname === "/spa.vue") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<html></html>");
    } else if (pathname.startsWith("/slow")) {
      const timer = setTimeout(() => js(inline(moduleMap)), 300);
      res.on("close", () => clearTimeout(timer));
    } else if (pathname === "/file-source.js") {
      js(
        inline({
          version: 3,
          sources: [pathToFileURL(path.join(root, "secret.ts")).href],
          names: [],
          mappings: "AAAA",
        }),
      );
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  origin =
    typeof address === "object" && address !== null ? `http://127.0.0.1:${address.port}` : "";
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
  await rm(base, { recursive: true, force: true });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("resolveEvents", () => {
  it("maps candidate frames and ignores non-candidates without fetching them", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const data = event([
      frame(`${origin}/mod-a.js`, 2, 1),
      frame("node:internal/process/task_queues"),
      frame("http://example.com/x.js"),
    ]);
    await resolver().resolveEvents([data]);
    expect(data.sourceMaps).toEqual({
      status: "full",
      candidateFrames: 1,
      mappedFrames: 1,
      errors: [],
    });
    expect(framesOf(data)[0]?.mapped).toMatchObject({
      source: "orig.ts",
      lineno: 2,
      contextLine: "throw new Error('x');",
    });
    expect(framesOf(data)[1]?.mapped).toBeNull();
    const fetched = fetchSpy.mock.calls.map(([input]) => (input instanceof URL ? input.href : ""));
    expect(fetched.some((url) => url.includes("example.com"))).toBe(false);
  });

  it("reports partial when one module is not javascript", async () => {
    const data = event([frame(`${origin}/mod-b.js`, 2), frame(`${origin}/spa.vue`)]);
    await resolver().resolveEvents([data]);
    expect(data.sourceMaps.status).toBe("partial");
    expect(data.sourceMaps.errors).toEqual([
      { absPath: `${origin}/spa.vue`, reason: "not_javascript" },
    ]);
  });

  it("reports not_applicable without candidates", async () => {
    const data = event([frame("<anonymous>"), frame("/outside/of/roots.js")]);
    await resolver().resolveEvents([data]);
    expect(data.sourceMaps).toEqual({
      status: "not_applicable",
      candidateFrames: 0,
      mappedFrames: 0,
      errors: [],
    });
  });

  it("reports none when all candidates fail and dedupes errors", async () => {
    const data = event([frame(`${origin}/spa.vue`), frame(`${origin}/spa.vue`)]);
    await resolver().resolveEvents([data]);
    expect(data.sourceMaps).toEqual({
      status: "none",
      candidateFrames: 2,
      mappedFrames: 0,
      errors: [{ absPath: `${origin}/spa.vue`, reason: "not_javascript" }],
    });
  });

  it("reports no_mapping for a line outside the map", async () => {
    const data = event([frame(`${origin}/mod-c.js`, 50)]);
    await resolver().resolveEvents([data]);
    expect(data.sourceMaps.errors).toEqual([
      { absPath: `${origin}/mod-c.js`, reason: "no_mapping" },
    ]);
  });

  it("flags SSR frames as unreliable and drops SDK context", async () => {
    const file = await write("app/pages/index.vue", "<template><div /></template>\n");
    const data = event([frame(file, 3, 4)]);
    await resolver().resolveEvents([data]);
    expect(framesOf(data)[0]).toMatchObject({
      filename: file,
      lineno: 3,
      colno: 4,
      positionReliable: false,
      contextLine: null,
      preContext: [],
      postContext: [],
      mapped: null,
    });
    expect(data.sourceMaps).toMatchObject({
      status: "none",
      errors: [{ absPath: file, reason: "ssr_position_unreliable" }],
    });
  });

  it("fetches a module once per envelope and caches it across calls", async () => {
    const url = `${origin}/mod-cache.js`;
    const instance = resolver();
    const frames = Array.from({ length: 10 }, () => frame(url, 2));
    await instance.resolveEvents([event(frames)]);
    expect(count("/mod-cache.js")).toBe(1);
    const second = event([frame(url, 2)]);
    await instance.resolveEvents([second]);
    expect(count("/mod-cache.js")).toBe(1);
    expect(second.sourceMaps.status).toBe("full");
    await instance.resolveEvents([event([frame(`${url}?t=2`, 2)])]);
    expect(count("/mod-cache.js?t=2")).toBe(1);
  });

  it("dedupes loads across events of one envelope", async () => {
    const url = `${origin}/mod-multi.js`;
    await resolver().resolveEvents([event([frame(url, 2)]), event([frame(url, 2)])]);
    expect(count("/mod-multi.js")).toBe(1);
  });

  it("reloads a file after its mtime changes", async () => {
    const mapFor = (line: number) =>
      inline({
        version: 3,
        sources: ["src/a.ts"],
        names: [],
        mappings: `AA${line === 1 ? "A" : "C"}A`,
      });
    const file = await write("dist/app.js", `app();\n${mapFor(1)}\n`);
    await write("dist/src/a.ts", "line one\nline two\n");
    await utimes(file, 1_700_000_000, 1_700_000_000);
    const instance = resolver();
    const first = event([frame(file)]);
    await instance.resolveEvents([first]);
    expect(framesOf(first)[0]?.mapped).toMatchObject({ lineno: 1, contextLine: "line one" });

    await writeFile(file, `app();\n${mapFor(2)}\n`);
    await utimes(file, 1_700_000_100, 1_700_000_100);
    const second = event([frame(file)]);
    await instance.resolveEvents([second]);
    expect(framesOf(second)[0]?.mapped).toMatchObject({ lineno: 2, contextLine: "line two" });
  });

  it("reads original sources from disk for fs maps", async () => {
    const file = await write("nitro/index.mjs", "boom();\n//# sourceMappingURL=index.mjs.map\n");
    await write(
      "nitro/index.mjs.map",
      JSON.stringify({ version: 3, sources: ["../server/boom.ts"], names: [], mappings: "AACA" }),
    );
    await write("server/boom.ts", "export default 1;\nthrow new Error('boom');\n");
    const data = event([frame(`file://${file}`)]);
    await resolver().resolveEvents([data]);
    expect(framesOf(data)[0]?.mapped).toMatchObject({
      source: "server/boom.ts",
      absPath: path.join(root, "server/boom.ts"),
      lineno: 2,
      contextLine: "throw new Error('boom');",
    });
  });

  it("never reads disk sources for http-loaded maps", async () => {
    const data = event([frame(`${origin}/file-source.js`)]);
    await resolver().resolveEvents([data]);
    expect(framesOf(data)[0]?.mapped).toMatchObject({
      absPath: path.join(root, "secret.ts"),
      contextLine: null,
      preContext: [],
    });
  });

  it("stays within the budget", async () => {
    const data = event([frame(`${origin}/slow-1.js`), frame(`${origin}/slow-2.js`)]);
    const start = performance.now();
    await resolver({ budgetMs: 100 }).resolveEvents([data]);
    expect(performance.now() - start).toBeLessThan(600);
    expect(data.sourceMaps.mappedFrames).toBe(0);
    for (const error of data.sourceMaps.errors) {
      expect(["timeout", "budget_exceeded"]).toContain(error.reason);
    }
    expect(data.sourceMaps.errors).toHaveLength(2);
  });

  it("aborts module and map fetch with one shared deadline", async () => {
    const data = event([frame(`${origin}/slow-3.js`)]);
    const start = performance.now();
    await resolver({ fetchTimeoutMs: 5000, budgetMs: 100 }).resolveEvents([data]);
    expect(performance.now() - start).toBeLessThan(300);
    expect(data.sourceMaps.errors).toEqual([{ absPath: `${origin}/slow-3.js`, reason: "timeout" }]);
  });

  it("does not cache transient failures", async () => {
    const instance = resolver({ budgetMs: 50 });
    await instance.resolveEvents([event([frame(`${origin}/slow-4.js`)])]);
    await instance.resolveEvents([event([frame(`${origin}/slow-4.js`)])]);
    expect(count("/slow-4.js")).toBe(2);
  });

  it("logs and leaves frames untouched when a loader throws", async () => {
    vi.mocked(loadHttpSourceMap).mockRejectedValueOnce(new Error("kaputt"));
    const logger = silentLogger();
    const data = event([frame(`${origin}/mod-throw.js`, 2)]);
    const before = structuredClone(data);
    await expect(resolver({ logger }).resolveEvents([data])).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledOnce();
    expect(data).toEqual(before);
  });
});

describe("source roots", () => {
  it("adds idempotently, removes, and rejects relative paths", async () => {
    const instance = resolver({ sourceRoots: [] });
    instance.addSourceRoot(root);
    instance.addSourceRoot(`${root}/`);
    expect(instance.sourceRoots()).toEqual([root]);
    const file = await write("roots/index.vue", "<template />\n");
    const mapped = event([frame(file)]);
    await instance.resolveEvents([mapped]);
    expect(mapped.sourceMaps.candidateFrames).toBe(1);

    instance.removeSourceRoot(root);
    instance.removeSourceRoot("/never/added");
    expect(instance.sourceRoots()).toEqual([]);
    const unmapped = event([frame(file)]);
    await instance.resolveEvents([unmapped]);
    expect(unmapped.sourceMaps.status).toBe("not_applicable");

    expect(() => instance.addSourceRoot("relative/dir")).toThrow(SentraConfigError);
    try {
      instance.addSourceRoot("relative/dir");
    } catch (error) {
      expect(error).toMatchObject({ code: "invalid_option" });
    }
  });

  it("shares a passed Set with its owner", () => {
    const roots = new Set<string>();
    const instance = resolver({ sourceRoots: roots });
    roots.add("/a");
    expect(instance.sourceRoots()).toEqual(["/a"]);
    instance.addSourceRoot("/b");
    expect([...roots]).toEqual(["/a", "/b"]);
  });
});

describe("mapFrames", () => {
  it("maps error and message items and passes others through", async () => {
    const data = event([frame(`${origin}/mod-items.js`, 2)]);
    const messageData = event([], [frame(`${origin}/mod-items.js`, 2)]);
    const items: NewItem[] = [
      newItem({ ...summary("error"), kind: "error", data }),
      newItem({ ...summary("message"), kind: "message", data: messageData }),
      newItem({
        ...summary("log"),
        kind: "log",
        data: { body: "x", severityNumber: null, spanId: null, attributes: {} },
      }),
    ];
    const result = await resolver().mapFrames(items);
    expect(result).toHaveLength(3);
    expect(result[2]).toBe(items[2]);
    const [error, message] = result;
    expect(error?.item.kind === "error" ? error.item.data.sourceMaps.status : null).toBe("full");
    expect(
      message?.item.kind === "message" ? message.item.data.stacktrace[0]?.mapped?.lineno : null,
    ).toBe(2);
    // Inputs stay untouched.
    expect(data.sourceMaps.status).toBe("not_applicable");
  });
});
