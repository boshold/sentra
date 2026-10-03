import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import {
  DEFAULT_ALLOWED_HOSTS,
  isAllowedUrl,
  loadHttpSourceMap,
  normalizeAllowedHosts,
} from "#src/sourcemaps/http-loader.js";
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
    const closed = await startServer(() => undefined);
    await stopServer(closed);
    const result = await loadHttpSourceMap(new URL(`${closed.origin}/a.js`), options());
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
    expect([...normalizeAllowedHosts([])].toSorted()).toEqual(
      [...DEFAULT_ALLOWED_HOSTS].toSorted(),
    );
  });
});
