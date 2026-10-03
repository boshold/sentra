import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import type { HttpCacheInfo } from "#src/sourcemaps/extract.js";
import { LOOPBACK_HOSTS, isAllowedUrl, normalizeAllowedHosts } from "#src/sourcemaps/hosts.js";
import { loadHttpSourceMap } from "#src/sourcemaps/http-loader.js";
import type { HttpLoaderOptions } from "#src/sourcemaps/http-loader.js";

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

interface TestServer {
  server: Server;
  origin: string;
  port: number;
  requests: string[];
}

const map = { version: 3, sources: ["ok.ts"], names: [], mappings: "AAAA" };
const mapJson = JSON.stringify(map);
const inlineBase64 = `data:application/json;base64,${Buffer.from(mapJson).toString("base64")}`;
const inlineUri = `data:application/json;charset=utf-8,${encodeURIComponent(mapJson)}`;
const badMap = Buffer.from(JSON.stringify({ ...map, version: 2 })).toString("base64");

const mapVersion = { current: 1 };

let main: TestServer;
let other: TestServer;

function js(res: ServerResponse, body: string, headers: Record<string, string> = {}): void {
  res.writeHead(200, { "content-type": "text/javascript", ...headers });
  res.end(body);
}

function redirect(res: ServerResponse, location: string): void {
  res.writeHead(302, { location });
  res.end();
}

function routes(): Record<string, Handler> {
  const port2 = other.port;
  return {
    "/ok.js": (_req, res) => js(res, `export default 1;\n//# sourceMappingURL=${inlineBase64}\n`),
    "/uri.js": (_req, res) => js(res, `export default 1;\n//# sourceMappingURL=${inlineUri}`),
    "/ext.js": (_req, res) => js(res, "export default 1;\n//# sourceMappingURL=ext.js.map\n"),
    "/ext.js.map": (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(mapJson);
    },
    "/spa.vue": (_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<!doctype html><div id=app></div>");
    },
    "/stale.js": (_req, res) => {
      res.writeHead(504);
      res.end("Outdated Optimize Dep");
    },
    "/hdr.js": (_req, res) => js(res, "export default 1;\n", { SourceMap: "ext.js.map" }),
    "/both.js": (_req, res) =>
      js(res, `export default 1;\n//# sourceMappingURL=${inlineBase64}\n`, {
        SourceMap: "missing.js.map",
      }),
    "/nomap.js": (_req, res) => js(res, "export default 1;\n"),
    "/etag.js": (req, res) => {
      const headers = { etag: '"v1"', "last-modified": "Wed, 01 Jan 2025 00:00:00 GMT" };
      if (req.headers["if-none-match"] === '"v1"') {
        res.writeHead(304, headers);
        res.end();
        return;
      }
      js(res, `//# sourceMappingURL=${inlineBase64}`, headers);
    },
    "/cond.js": (req, res) => {
      if (req.headers["if-none-match"] === '"js"') {
        res.writeHead(304, { etag: '"js"' });
        res.end();
        return;
      }
      js(res, "//# sourceMappingURL=cond.js.map", { etag: '"js"' });
    },
    "/cond.js.map": (req, res) => {
      const etag = `"map-v${mapVersion.current}"`;
      if (req.headers["if-none-match"] === etag) {
        res.writeHead(304, { etag });
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json", etag });
      res.end(JSON.stringify({ ...map, sources: [`v${mapVersion.current}.ts`] }));
    },
    "/cond-plain-map.js": (req, res) => {
      if (req.headers["if-none-match"] === '"js"') {
        res.writeHead(304, { etag: '"js"' });
        res.end();
        return;
      }
      js(res, "//# sourceMappingURL=ext.js.map", { etag: '"js"' });
    },
    "/badmap.js": (_req, res) =>
      js(res, `//# sourceMappingURL=data:application/json;base64,${badMap}`),
    "/pathmap.js": (_req, res) => js(res, "//# sourceMappingURL=file:///etc/passwd"),
    "/slow.js": (_req, res) => {
      const timer = setTimeout(() => js(res, `//# sourceMappingURL=${inlineBase64}`), 500);
      res.on("close", () => clearTimeout(timer));
    },
    "/big.js": (_req, res) => {
      res.writeHead(200, { "content-type": "text/javascript" });
      for (let i = 0; i < 8; i += 1) {
        res.write("x".repeat(512));
      }
      res.end();
    },
    "/big-length.js": (_req, res) => {
      res.writeHead(200, { "content-type": "text/javascript", "content-length": "100000" });
      res.write("x".repeat(100));
    },
    "/redir-same": (_req, res) => redirect(res, "/ok.js"),
    "/redir-cross": (_req, res) => redirect(res, "http://example.invalid/x.js"),
    "/redir-port": (_req, res) => redirect(res, `http://127.0.0.1:${port2}/ok.js`),
    "/loop": (_req, res) => redirect(res, "/loop"),
    "/map-cross-host": (_req, res) =>
      js(res, `//# sourceMappingURL=http://localhost:${port2}/x.map`),
    "/map-protocol-relative": (_req, res) =>
      js(res, `//# sourceMappingURL=//localhost:${port2}/x.map`),
    "/map-invalid-host": (_req, res) =>
      js(res, "//# sourceMappingURL=http://example.invalid/x.map"),
    "/map-other-port": (_req, res) =>
      js(res, `//# sourceMappingURL=http://127.0.0.1:${port2}/x.map`),
  };
}

async function startServer(handler: Handler): Promise<TestServer> {
  const requests: string[] = [];
  const server = createServer((req, res) => {
    requests.push(req.url ?? "");
    handler(req, res);
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("server has no address");
  }
  const { port } = address satisfies AddressInfo;
  return { server, origin: `http://127.0.0.1:${port}`, port, requests };
}

async function stopServer(target: TestServer): Promise<void> {
  target.server.closeAllConnections();
  await new Promise<void>((resolve) => {
    target.server.close(() => resolve());
  });
}

function options(overrides: Partial<HttpLoaderOptions> = {}): HttpLoaderOptions {
  return { allowedHosts: new Set(["127.0.0.1"]), timeoutMs: 2000, ...overrides };
}

async function load(path: string, overrides: Partial<HttpLoaderOptions> = {}) {
  return loadHttpSourceMap(new URL(path, main.origin), options(overrides));
}

beforeAll(async () => {
  other = await startServer((_req, res) => {
    js(res, `//# sourceMappingURL=${inlineBase64}`);
  });
  let table: Record<string, Handler> = {};
  main = await startServer((req, res) => {
    const { pathname } = new URL(req.url ?? "/", "http://x");
    const handler = table[pathname];
    if (handler) {
      handler(req, res);
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  table = routes();
});

afterAll(async () => {
  await stopServer(main);
  await stopServer(other);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("loadHttpSourceMap", () => {
  it("loads an inline base64 map with sourcesBase incl. query", async () => {
    const result = await load("/ok.js?t=5");
    expect(result).toEqual({
      status: "loaded",
      map,
      sourcesBase: `${main.origin}/ok.js?t=5`,
      origin: "http",
      http: { module: null, mapUrl: null, map: null },
    });
  });

  it("keeps the module's ETag and Last-Modified as validators", async () => {
    expect(await load("/etag.js")).toMatchObject({
      status: "loaded",
      http: {
        module: { etag: '"v1"', lastModified: "Wed, 01 Jan 2025 00:00:00 GMT" },
        mapUrl: null,
        map: null,
      },
    });
  });

  it("loads an inline URI-encoded map", async () => {
    expect(await load("/uri.js")).toMatchObject({ status: "loaded", map });
  });

  it("loads an external map", async () => {
    const result = await load("/ext.js");
    expect(result).toMatchObject({ status: "loaded", map, origin: "http" });
    expect(result.status === "loaded" ? result.sourcesBase : "").toBe(`${main.origin}/ext.js.map`);
  });

  it("falls back to the SourceMap header", async () => {
    expect(await load("/hdr.js")).toMatchObject({
      status: "loaded",
      sourcesBase: `${main.origin}/ext.js.map`,
    });
  });

  it("prefers the comment over the header", async () => {
    expect(await load("/both.js")).toMatchObject({
      status: "loaded",
      sourcesBase: `${main.origin}/both.js`,
    });
  });

  it.each<[string, string]>([
    ["/spa.vue", "not_javascript"],
    ["/stale.js?v=old", "http_status_504"],
    ["/unknown.js", "http_status_404"],
    ["/nomap.js", "no_source_map"],
    ["/badmap.js", "invalid_source_map"],
    ["/pathmap.js", "invalid_source_map"],
  ])("%s fails with %s", async (path, reason) => {
    expect(await load(path)).toEqual({ status: "failed", reason });
  });

  it("times out", async () => {
    const start = performance.now();
    const result = await load("/slow.js", { timeoutMs: 50 });
    expect(result).toEqual({ status: "failed", reason: "timeout" });
    expect(performance.now() - start).toBeLessThan(400);
  });

  it("rejects a streamed body above maxBytes", async () => {
    expect(await load("/big.js", { maxBytes: 1024 })).toEqual({
      status: "failed",
      reason: "too_large",
    });
  });

  it("rejects a content-length above maxBytes without reading the body", async () => {
    // The body never completes: reading it would hit the timeout instead.
    expect(await load("/big-length.js", { maxBytes: 1024, timeoutMs: 1500 })).toEqual({
      status: "failed",
      reason: "too_large",
    });
  });

  it("follows a same-host redirect", async () => {
    expect(await load("/redir-same")).toMatchObject({
      status: "loaded",
      sourcesBase: `${main.origin}/ok.js`,
    });
  });

  it.each<[string]>([["/redir-cross"], ["/redir-port"], ["/loop"]])(
    "refuses redirect %s",
    async (path) => {
      const before = other.requests.length;
      expect(await load(path)).toEqual({ status: "failed", reason: "redirect_not_allowed" });
      expect(other.requests.length).toBe(before);
    },
  );

  it("stops a redirect loop after three hops", async () => {
    const before = main.requests.filter((url) => url === "/loop").length;
    await load("/loop");
    expect(main.requests.filter((url) => url === "/loop").length - before).toBe(4);
  });

  it.each<[string]>([
    ["/map-cross-host"],
    ["/map-protocol-relative"],
    ["/map-invalid-host"],
    ["/map-other-port"],
  ])("never fetches a map outside the module origin: %s", async (path) => {
    const before = other.requests.length;
    expect(await load(path)).toEqual({ status: "failed", reason: "map_not_allowed" });
    expect(other.requests.length).toBe(before);
  });

  it("skips a host outside the allowlist without fetching", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    const result = await loadHttpSourceMap(
      new URL("http://example.com/a.js"),
      options({ allowedHosts: normalizeAllowedHosts([]) }),
    );
    expect(result).toEqual({ status: "skipped", reason: "host_not_allowed" });
    expect(spy).not.toHaveBeenCalled();
  });

  it("reports a refused connection as fetch_failed", async () => {
    // Port 1 (tcpmux) is privileged and not listening on dev machines or CI.
    const result = await loadHttpSourceMap(new URL("http://127.0.0.1:1/a.js"), options());
    expect(result).toEqual({ status: "failed", reason: "fetch_failed" });
  });
});

describe("isAllowedUrl", () => {
  const defaults = normalizeAllowedHosts([]);

  it.each<[string, boolean]>([
    ["http://localhost:5173/a", true],
    ["http://LOCALHOST/a", true],
    ["https://127.0.0.1/a", true],
    ["http://[::1]:3000/a", true],
    ["ftp://localhost/a", false],
    ["http://user:pw@localhost/a", false],
    ["http://user@localhost/a", false],
    ["http://localhost.evil.test/a", false],
    ["http://192.168.1.10/a", false],
  ])("%s → %s", (url, expected) => {
    expect(isAllowedUrl(new URL(url), defaults)).toBe(expected);
  });

  it.each<[string]>([
    ["http://dev.local"],
    ["dev.local/path"],
    ["user@dev.local"],
    ["dev local"],
    [""],
  ])("ignores invalid host entry %j", (entry) => {
    expect([...normalizeAllowedHosts([entry])].toSorted()).toEqual([...LOOPBACK_HOSTS].toSorted());
  });

  it("does not allow the scheme of a URL-like entry as hostname", () => {
    expect(
      isAllowedUrl(new URL("http://http/a"), normalizeAllowedHosts(["http://dev.local"])),
    ).toBe(false);
  });

  it("accepts extra hosts", () => {
    const hosts = normalizeAllowedHosts([
      "192.168.1.10",
      "Dev.Local:3000",
      "fe80::1",
      "[fd00::2]:80",
    ]);
    expect(isAllowedUrl(new URL("http://192.168.1.10/a"), hosts)).toBe(true);
    expect(isAllowedUrl(new URL("http://dev.local:8080/a"), hosts)).toBe(true);
    expect(isAllowedUrl(new URL("http://[fe80::1]/a"), hosts)).toBe(true);
    expect(isAllowedUrl(new URL("http://[fd00::2]/a"), hosts)).toBe(true);
  });

  it("includes the loopback defaults", () => {
    expect([...normalizeAllowedHosts([])].toSorted()).toEqual([...LOOPBACK_HOSTS].toSorted());
  });
});

describe("conditional loads", () => {
  const url = (path: string): URL => new URL(path, main.origin);
  const v1 = { etag: '"v1"', lastModified: null };

  beforeEach(() => {
    mapVersion.current = 1;
    main.requests.length = 0;
  });

  async function first(path: string): Promise<HttpCacheInfo> {
    const result = await loadHttpSourceMap(url(path), options());
    if (result.status !== "loaded" || result.http === undefined) {
      throw new Error(`not loaded: ${result.status}`);
    }
    return result.http;
  }

  it("keeps the validators and URL of an external map", async () => {
    expect(await first("/cond.js")).toEqual({
      module: { etag: '"js"', lastModified: null },
      mapUrl: `${main.origin}/cond.js.map`,
      map: { etag: '"map-v1"', lastModified: null },
    });
  });

  it("is not_modified when module and map answer 304", async () => {
    const previous = await first("/cond.js");
    expect(await loadHttpSourceMap(url("/cond.js"), options(), previous)).toEqual({
      status: "not_modified",
    });
    expect(main.requests).toEqual(["/cond.js", "/cond.js.map", "/cond.js", "/cond.js.map"]);
  });

  it("reloads the external map when only the map changed", async () => {
    const previous = await first("/cond.js");
    mapVersion.current = 2;
    expect(await loadHttpSourceMap(url("/cond.js"), options(), previous)).toMatchObject({
      status: "loaded",
      map: { sources: ["v2.ts"] },
      http: { map: { etag: '"map-v2"' } },
    });
  });

  it("leaves an external map without validators to the cache TTL", async () => {
    const previous = await first("/cond-plain-map.js");
    expect(previous.map).toBeNull();
    expect(await loadHttpSourceMap(url("/cond-plain-map.js"), options(), previous)).toEqual({
      status: "not_modified",
    });
    expect(main.requests).toEqual(["/cond-plain-map.js", "/ext.js.map", "/cond-plain-map.js"]);
  });

  it("uses a 200 answer to the conditional request as the new module", async () => {
    const previous = { module: { etag: '"other"', lastModified: null }, mapUrl: null, map: null };
    expect(await loadHttpSourceMap(url("/ok.js"), options(), previous)).toMatchObject({
      status: "loaded",
      map,
    });
    expect(main.requests).toEqual(["/ok.js"]);
  });

  it("sends both validators", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const module = { etag: '"v1"', lastModified: "lm" };
    await loadHttpSourceMap(url("/etag.js"), options(), { module, mapUrl: null, map: null });
    const init = fetchSpy.mock.calls[0]?.[1];
    expect(new Headers(init?.headers).get("if-none-match")).toBe('"v1"');
    expect(new Headers(init?.headers).get("if-modified-since")).toBe("lm");
  });

  it("checks the cached map URL against the allowed hosts", async () => {
    const previous = {
      module: v1,
      mapUrl: `http://127.0.0.1:${other.port}/x.map`,
      map: v1,
    };
    expect(await loadHttpSourceMap(url("/etag.js"), options(), previous)).toEqual({
      status: "failed",
      reason: "map_not_allowed",
    });
  });

  it("fails when the conditional request fails", async () => {
    expect(
      await loadHttpSourceMap(url("/slow.js"), options({ timeoutMs: 20 }), {
        module: v1,
        mapUrl: null,
        map: null,
      }),
    ).toEqual({ status: "failed", reason: "timeout" });
  });
});
