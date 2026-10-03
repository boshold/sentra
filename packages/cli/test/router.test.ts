import { createServer } from "node:http";
import type { Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { createSentra, memoryStorage, toNodeListener } from "@bosdev/sentra-core";
import type { Sentra } from "@bosdev/sentra-core";

import { createGuard } from "#src/guard.js";
import { createRouter, sendError, sendJson } from "#src/router.js";
import type { NodeListener, Routes } from "#src/router.js";

import { httpRequest, parseJson } from "./http.js";

function stub(name: string): NodeListener {
  return (_req, res) => {
    sendJson(res, 200, { route: name });
  };
}

const servers: Server[] = [];
const instances: Sentra[] = [];

async function serve(
  routes: Partial<Routes>,
  logger?: { error: (message: string) => void },
): Promise<number> {
  const full: Routes = {
    ingest: stub("ingest"),
    api: stub("api"),
    stream: stub("stream"),
    mcp: stub("mcp"),
    ...routes,
  };
  const errors = logger ?? { error: () => undefined };
  const server = createServer(
    createRouter(full, createGuard({ boundHost: "127.0.0.1", allowedHosts: [] }), {
      logger: {
        debug: () => undefined,
        info: () => undefined,
        warn: () => undefined,
        error: errors.error,
      },
    }),
  );
  servers.push(server);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("no address");
  }
  return (address satisfies AddressInfo).port;
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      async (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => {
            resolve();
          });
        }),
    ),
  );
  await Promise.all(instances.splice(0).map(async (instance) => instance.close()));
});

async function coreIngest(): Promise<NodeListener> {
  const sentra = await createSentra({ storage: memoryStorage() });
  instances.push(sentra);
  return toNodeListener(sentra.handle);
}

describe("createRouter", () => {
  it.each([
    ["POST", "/my-app/api/1/envelope/", "ingest"],
    ["GET", "/api/sentra/health", "api"],
    ["GET", "/api/sentra", "api"],
    ["GET", "/api/sentra/items?kind=error", "api"],
    ["GET", "/api/sentra/stream", "stream"],
    ["GET", "/api/sentra/stream?kind=log", "stream"],
    ["POST", "/mcp", "mcp"],
    ["POST", "/mcp?x=1", "mcp"],
    ["GET", "/mcpx", "ingest"],
    ["GET", "/api/sentrax", "ingest"],
    ["GET", "/", "ingest"],
  ])("%s %s → %s", async (method, path, route) => {
    const port = await serve({});
    const result = await httpRequest(port, {
      method,
      path,
      headers: { host: `localhost:${port}` },
    });
    expect(parseJson(result.body)).toEqual({ route });
  });

  it("rejects foreign hosts on API routes without CORS headers", async () => {
    const port = await serve({});
    const result = await httpRequest(port, {
      path: "/api/sentra/health",
      headers: { host: "evil.example" },
    });
    expect(result.status).toBe(403);
    expect(parseJson(result.body)).toEqual({
      error: { code: "forbidden_host", message: expect.any(String) },
    });
    expect(result.headers["access-control-allow-origin"]).toBeUndefined();
    const origin = await httpRequest(port, {
      path: "/api/sentra/stream",
      headers: { host: "localhost", origin: "https://evil.example" },
    });
    expect(origin.status).toBe(403);
    expect(parseJson(origin.body)).toMatchObject({ error: { code: "forbidden_origin" } });
  });

  it("answers MCP guard failures with a JSON-RPC error", async () => {
    const port = await serve({});
    const result = await httpRequest(port, {
      method: "POST",
      path: "/mcp",
      headers: { host: "localhost", origin: "https://evil.example" },
    });
    expect(result.status).toBe(403);
    expect(parseJson(result.body)).toEqual({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32_000, message: expect.stringContaining("evil.example") },
    });
    expect(result.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("does not guard ingest routes", async () => {
    const port = await serve({});
    const result = await httpRequest(port, {
      method: "POST",
      path: "/x/api/1/envelope/",
      headers: { host: "evil.example", origin: "https://evil.example" },
    });
    expect(parseJson(result.body)).toEqual({ route: "ingest" });
  });

  it("falls through to the core handler for disabled routes", async () => {
    const port = await serve({ ingest: await coreIngest(), api: null, stream: null, mcp: null });
    for (const path of ["/api/sentra/health", "/api/sentra/stream", "/mcp"]) {
      const result = await httpRequest(port, { path, headers: { host: "localhost" } });
      expect(result.status).toBe(404);
      expect(parseJson(result.body)).toMatchObject({ error: { code: "not_found" } });
    }
  });

  it("answers 404 for disabled routes before the Host / Origin guard", async () => {
    const port = await serve({ ingest: await coreIngest(), api: null, stream: null, mcp: null });
    for (const path of ["/api/sentra/health", "/api/sentra/stream", "/mcp"]) {
      const result = await httpRequest(port, {
        path,
        headers: { host: "evil.example", origin: "https://evil.example" },
      });
      expect(result.status).toBe(404);
      expect(parseJson(result.body)).toMatchObject({ error: { code: "not_found" } });
    }
  });

  it("maps throwing and rejecting handlers to 500", async () => {
    const errors: string[] = [];
    const port = await serve(
      {
        api: () => {
          throw new Error("sync boom");
        },
        stream: async () => {
          throw new Error("async boom");
        },
      },
      { error: (message) => errors.push(message) },
    );
    for (const path of ["/api/sentra/health", "/api/sentra/stream"]) {
      const result = await httpRequest(port, { path, headers: { host: "localhost" } });
      expect(result.status).toBe(500);
      expect(parseJson(result.body)).toEqual({
        error: { code: "internal_error", message: "internal error" },
      });
    }
    expect(errors).toEqual([
      expect.stringContaining("sync boom"),
      expect.stringContaining("async boom"),
    ]);
  });

  it("destroys the response when a handler fails after sending headers", async () => {
    const port = await serve({
      api: async (_req, res: ServerResponse) => {
        res.writeHead(200);
        res.write("partial");
        throw new Error("late");
      },
    });
    await expect(
      httpRequest(port, { path: "/api/sentra/x", headers: { host: "localhost" } }),
    ).rejects.toThrow();
  });
});

describe("sendError", () => {
  it("includes details when given", async () => {
    const port = await serve({
      api: (_req, res) => {
        sendError(res, 400, "invalid_filter", "bad", [{ path: ["kind"] }]);
      },
    });
    const result = await httpRequest(port, {
      path: "/api/sentra/items",
      headers: { host: "localhost" },
    });
    expect(result.status).toBe(400);
    expect(result.headers["content-type"]).toBe("application/json; charset=utf-8");
    expect(parseJson(result.body)).toEqual({
      error: { code: "invalid_filter", message: "bad", details: [{ path: ["kind"] }] },
    });
  });
});
