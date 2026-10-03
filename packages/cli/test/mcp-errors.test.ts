import { createServer } from "node:http";
import type { Server } from "node:http";

import { createSentra, memoryStorage } from "@boshold/sentra-core";
import type { Sentra } from "@boshold/sentra-core";

import { createMcpRoute } from "#src/mcp.js";
import type { McpRoute } from "#src/mcp.js";

import { httpRequest, parseJson } from "./http.js";

const sdk = vi.hoisted(() => ({
  fetch: async (_request: Request): Promise<Response> => Promise.resolve(new Response(null)),
}));

vi.mock("@modelcontextprotocol/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@modelcontextprotocol/server")>();
  return {
    ...actual,
    createMcpHandler: () => ({
      fetch: async (request: Request) => sdk.fetch(request),
      close: async () => undefined,
    }),
  };
});

let sentra: Sentra;
let route: McpRoute;
let server: Server;
let port = 0;
const errors: string[] = [];

beforeEach(async () => {
  errors.length = 0;
  sentra = await createSentra({ storage: memoryStorage() });
  route = createMcpRoute({
    sentra,
    version: "1.0.0",
    logger: {
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: (text) => errors.push(text),
    },
  });
  server = createServer((req, res) => {
    void route.listener(req, res);
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  port = address !== null && typeof address === "object" ? address.port : 0;
});

afterEach(async () => {
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
  await route.close();
  await sentra.close();
});

async function expectGeneric500(): Promise<void> {
  const result = await httpRequest(port, { method: "POST", path: "/mcp", body: "{}" });
  expect(result.status).toBe(500);
  expect(result.headers["access-control-allow-origin"]).toBeUndefined();
  expect(result.headers["content-type"]).toBe("application/json; charset=utf-8");
  expect(parseJson(result.body)).toEqual({
    jsonrpc: "2.0",
    id: null,
    error: { code: -32_603, message: "Internal error" },
  });
  expect(result.body).not.toContain("boom");
  expect(errors).toEqual([expect.stringContaining("sdk boom")]);
}

describe("createMcpRoute errors", () => {
  it("maps a throwing SDK handler to a JSON-RPC 500", async () => {
    sdk.fetch = async () => Promise.reject(new Error("sdk boom"));
    await expectGeneric500();
  });

  it("maps a failing SDK body stream to a JSON-RPC 500", async () => {
    sdk.fetch = async () =>
      Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.error(new Error("sdk boom"));
            },
          }),
          { headers: { "content-type": "text/event-stream", "access-control-allow-origin": "*" } },
        ),
      );
    await expectGeneric500();
  });

  it("strips CORS headers from SDK responses", async () => {
    sdk.fetch = async () =>
      Promise.resolve(
        Response.json({ ok: true }, { headers: { "access-control-allow-origin": "*" } }),
      );
    const result = await httpRequest(port, { method: "POST", path: "/mcp", body: "{}" });
    expect(result.status).toBe(200);
    expect(result.headers["access-control-allow-origin"]).toBeUndefined();
  });
});
