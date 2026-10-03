import { PassThrough } from "node:stream";

import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

import { resolveStartConfig } from "#src/config.js";
import { startServer } from "#src/server.js";
import type { RunningServer } from "#src/server.js";

import { loadEnvelopeFixture } from "../../../test/fixtures/envelopes.js";

import { httpRequest, parseJson } from "./http.js";
import type { HttpResult } from "./http.js";

const TOOL_NAMES = [
  "sentra_list_scopes",
  "sentra_list_issues",
  "sentra_get_issue",
  "sentra_list_items",
  "sentra_get_item",
];

const running: RunningServer[] = [];
const clients: Client[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map(async (client) => client.close()));
  await Promise.all(running.splice(0).map(async (server) => server.close()));
});

async function boot(flags: Record<string, unknown> = {}): Promise<RunningServer> {
  const config = resolveStartConfig(
    { storage: "memory", port: 0, quiet: true, ...flags },
    {},
    process.cwd(),
  );
  const server = await startServer(config, {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  });
  running.push(server);
  return server;
}

let nextId = 1;

async function rpc(
  server: RunningServer,
  method: string,
  params: Record<string, unknown> = {},
  headers: Record<string, string> = {},
): Promise<HttpResult> {
  nextId += 1;
  return httpRequest(server.port, {
    method: "POST",
    path: "/mcp",
    headers: {
      host: "localhost",
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...headers,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextId, method, params }),
  });
}

/** JSON body or the first SSE `data:` message. */
function message(result: HttpResult): unknown {
  if (String(result.headers["content-type"]).startsWith("text/event-stream")) {
    const line = result.body.split("\n").find((entry) => entry.startsWith("data: "));
    return parseJson(line?.slice("data: ".length) ?? "null");
  }
  return parseJson(result.body);
}

function field(value: unknown, ...keys: (string | number)[]): unknown {
  let current = value;
  for (const key of keys) {
    current =
      typeof current === "object" && current !== null ? Reflect.get(current, key) : undefined;
  }
  return current;
}

function toolNames(value: unknown): unknown[] {
  const tools = field(value, "result", "tools");
  return Array.isArray(tools) ? tools.map((tool) => field(tool, "name")) : [];
}

describe("POST /mcp", () => {
  it("lists tools via a hand-built request", async () => {
    const server = await boot();
    const result = await rpc(server, "tools/list");
    expect(result.status).toBe(200);
    expect(result.headers["x-content-type-options"]).toBe("nosniff");
    expect(toolNames(message(result))).toEqual(TOOL_NAMES);
  });

  it("calls sentra_list_issues", async () => {
    const server = await boot();
    await httpRequest(server.port, {
      method: "POST",
      path: "/my-app/3f9a1c/web/api/1/envelope/",
      body: loadEnvelopeFixture("node-error").body,
    });
    const page = await server.sentra.query.listIssues({ since: "60m" });
    const [issue] = page.items;
    if (issue === undefined) {
      throw new Error("issue missing");
    }
    const result = await rpc(server, "tools/call", { name: "sentra_list_issues", arguments: {} });
    const text = field(message(result), "result", "content", 0, "text");
    expect(text).toEqual(expect.stringContaining(issue.shortId));
  });

  it("serves old clients that initialize first", async () => {
    const server = await boot();
    const init = await rpc(server, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "old", version: "1" },
    });
    expect(init.status).toBe(200);
    expect(field(message(init), "result", "serverInfo", "name")).toBe("sentra");
    const list = await rpc(server, "tools/list", {}, { "mcp-protocol-version": "2025-06-18" });
    expect(toolNames(message(list))).toEqual(TOOL_NAMES);
  });

  it("ignores session ids", async () => {
    const server = await boot();
    const result = await rpc(server, "tools/list", {}, { "mcp-session-id": "random-session" });
    expect(result.status).toBe(200);
    expect(result.headers["mcp-session-id"]).toBeUndefined();
    expect(toolNames(message(result))).toEqual(TOOL_NAMES);
  });

  it("answers other methods with 405", async () => {
    const server = await boot();
    for (const method of ["GET", "DELETE", "PUT", "OPTIONS"]) {
      const result = await httpRequest(server.port, {
        method,
        path: "/mcp",
        headers: { host: "localhost" },
      });
      expect(result.status).toBe(405);
      expect(result.headers.allow).toBe("POST");
      expect(parseJson(result.body)).toEqual({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32_000, message: "Method not allowed." },
      });
    }
  });

  it("rejects foreign origins and hosts", async () => {
    const server = await boot();
    const origin = await rpc(server, "tools/list", {}, { origin: "https://evil.example" });
    expect(origin.status).toBe(403);
    expect(parseJson(origin.body)).toMatchObject({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32_000 },
    });
    const host = await rpc(server, "tools/list", {}, { host: "evil.example" });
    expect(host.status).toBe(403);
    expect(parseJson(host.body)).toMatchObject({ id: null });
  });

  it("rejects bodies over 4 MiB", async () => {
    const server = await boot();
    const result = await httpRequest(server.port, {
      method: "POST",
      path: "/mcp",
      headers: {
        host: "localhost",
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: { pad: "x".repeat(5 * 1024 * 1024) },
      }),
    });
    expect(result.status).toBe(413);
  });

  it("is disabled with --no-mcp", async () => {
    const server = await boot({ noMcp: true });
    const result = await rpc(server, "tools/list");
    expect(result.status).toBe(404);
    expect(parseJson(result.body)).toMatchObject({ error: { code: "not_found" } });
  });
});

describe("MCP SDK client", () => {
  it("lists and calls tools", async () => {
    const server = await boot();
    const client = new Client({ name: "test", version: "1.0.0" });
    clients.push(client);
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`)),
    );
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(TOOL_NAMES);
    const result = await client.callTool({ name: "sentra_list_scopes", arguments: {} });
    expect(result.isError ?? false).toBe(false);
  });

  it("closes the server with a connected client", async () => {
    const server = await boot();
    const client = new Client({ name: "test", version: "1.0.0" });
    clients.push(client);
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`)),
    );
    const started = Date.now();
    await server.close();
    expect(Date.now() - started).toBeLessThan(3000);
  });
});
