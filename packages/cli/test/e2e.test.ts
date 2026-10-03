import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

import {
  cliEntry,
  ensureBuilt,
  killAll,
  postFixture,
  removeDataHome,
  runCliOnce,
  spawnCli,
} from "./helpers/spawn-cli.js";
import type { CliProcess } from "./helpers/spawn-cli.js";
import { httpRequest, parseJson } from "./http.js";

const TOOL_NAMES = [
  "sentra_list_scopes",
  "sentra_list_issues",
  "sentra_get_issue",
  "sentra_list_items",
  "sentra_get_item",
];
const MEMORY = ["--port", "0", "--storage", "memory"];

const processes: CliProcess[] = [];
const clients: Client[] = [];
let tempDir = "";
let version = "";

async function start(
  args: string[] = [],
  options: Parameters<typeof spawnCli>[1] = {},
): Promise<CliProcess> {
  const cli = await spawnCli([...MEMORY, ...args], options);
  processes.push(cli);
  return cli;
}

async function json(response: Response): Promise<unknown> {
  const body: unknown = await response.json();
  return body;
}

function field(value: unknown, ...keys: (string | number)[]): unknown {
  let current = value;
  for (const key of keys) {
    current =
      typeof current === "object" && current !== null ? Reflect.get(current, key) : undefined;
  }
  return current;
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

async function connectMcp(cli: CliProcess): Promise<Client> {
  const client = new Client({ name: "e2e", version: "1.0.0" });
  clients.push(client);
  await client.connect(new StreamableHTTPClientTransport(new URL(`${cli.baseUrl}/mcp`)));
  return client;
}

describe.skipIf("Bun" in globalThis)("sentra CLI (built binary)", { timeout: 20_000 }, () => {
  beforeAll(async () => {
    await ensureBuilt();
    tempDir = mkdtempSync(path.join(tmpdir(), "sentra-e2e-"));
    const result = await runCliOnce(["--version"]);
    version = result.stdout.trim();
  }, 180_000);

  afterEach(async () => {
    await Promise.all(clients.splice(0).map(async (client) => client.close()));
    const results = await Promise.all(processes.splice(0).map(async (cli) => cli.stop()));
    expect(results.every((result) => result.code === 0)).toBe(true);
    expect(await killAll()).toBe(0);
  });

  afterAll(() => {
    rmSync(tempDir, { recursive: true, force: true });
    removeDataHome();
  });

  describe("start", () => {
    it("prints the banner with the actual port", async () => {
      const cli = await start();
      expect(cli.port).toBeGreaterThan(0);
      const out = cli.stdout();
      expect(out).toContain(`sentra ${version}  listening on http://127.0.0.1:${cli.port}`);
      expect(out).toMatch(/^storage {7}memory/m);
      expect(out).toContain(`DSN           http://sentra@127.0.0.1:${cli.port}/1`);
      expect(out).toContain("scoped DSN");
      expect(out).toContain(`query API     http://127.0.0.1:${cli.port}/api/sentra`);
      expect(out).toContain(`MCP           http://127.0.0.1:${cli.port}/mcp`);
    });

    it("prints an error live", async () => {
      const cli = await start();
      const response = await postFixture(cli.baseUrl, "node-error");
      expect(response.status).toBe(200);
      expect(field(await json(response), "id")).toEqual(expect.any(String));
      await cli.waitForStdout(/^\d{2}:\d{2}:\d{2} ERROR my-app\/3f9a1c\/web {2}/m);
      await cli.waitForStdout(/issue [0-9a-f]{8} NEW · 1×/);
      await postFixture(cli.baseUrl, "node-error");
      const footer = await cli.waitForStdout(/^ {2}issue [0-9a-f]{8} .*2×.*$/m);
      expect(footer).not.toContain("NEW");
    });

    it("hides transactions by default and shows them with --show all", async () => {
      const hidden = await start();
      await postFixture(hidden.baseUrl, "node-transaction");
      // The error afterwards proves the transaction was processed (same connection order).
      await postFixture(hidden.baseUrl, "node-error");
      await hidden.waitForStdout(/ERROR my-app/);
      expect(hidden.stdout()).not.toContain(" TXN ");

      const shown = await start(["--show", "all"]);
      await postFixture(shown.baseUrl, "node-transaction");
      await shown.waitForStdout(/^\d{2}:\d{2}:\d{2} TXN /m);
    });

    it("--format json prints NDJSON on stdout and the banner on stderr", async () => {
      const cli = await start(["--format", "json"], { bannerStream: "stderr" });
      expect(cli.stderr()).toContain("listening on");
      await postFixture(cli.baseUrl, "node-error");
      await postFixture(cli.baseUrl, "node-logs");
      await cli.waitForStdout(/(?:\n.*){3}/);
      const lines = cli.stdout().trimEnd().split("\n");
      expect(lines.length).toBeGreaterThanOrEqual(3);
      for (const line of lines) {
        expect(field(JSON.parse(line), "type")).toBe("item.created");
      }
    });

    it("--quiet prints nothing on stdout", async () => {
      const cli = await start(["--quiet"], { bannerStream: "stderr" });
      await postFixture(cli.baseUrl, "node-error");
      const items = await json(await fetch(`${cli.baseUrl}/api/sentra/items?from=0`));
      expect(list(field(items, "items")).length).toBeGreaterThan(0);
      expect(cli.stdout()).toBe("");
      expect(cli.stderr()).toContain("listening on");
    });
  });

  describe("api", () => {
    it("serves the query API", async () => {
      const cli = await start();
      await postFixture(cli.baseUrl, "node-error");
      await postFixture(cli.baseUrl, "node-error");
      expect(await json(await fetch(`${cli.baseUrl}/api/sentra/health`))).toMatchObject({
        ok: true,
      });
      const issues = list(
        field(await json(await fetch(`${cli.baseUrl}/api/sentra/issues?project=my-app`)), "items"),
      );
      expect(issues).toHaveLength(1);
      expect(field(issues[0], "count")).toBe(2);
      const detail = await json(
        await fetch(`${cli.baseUrl}/api/sentra/issues/${String(field(issues[0], "id"))}`),
      );
      const latestId = field(detail, "latest", "id");
      expect(latestId).toEqual(expect.any(String));
      const raw = await fetch(`${cli.baseUrl}/api/sentra/items/${String(latestId)}/envelope`);
      expect(raw.status).toBe(200);
      expect(raw.headers.get("content-type")).toBe("application/x-sentry-envelope");
      const deleted = await fetch(`${cli.baseUrl}/api/sentra/items`, { method: "DELETE" });
      expect(deleted.status).toBe(400);
      expect(await json(deleted)).toMatchObject({ error: { code: "filter_required" } });
    });

    it("streams live events over SSE", async () => {
      const cli = await start();
      const controller = new AbortController();
      const response = await fetch(`${cli.baseUrl}/api/sentra/stream`, {
        signal: controller.signal,
      });
      const reader = response.body?.pipeThrough(new TextDecoderStream()).getReader();
      if (reader === undefined) {
        throw new Error("no stream body");
      }
      let text = "";
      async function readUntil(needle: string): Promise<void> {
        while (!text.includes(needle)) {
          const chunk = await reader?.read();
          if (chunk === undefined || chunk.done) {
            throw new Error(`stream ended: ${text}`);
          }
          text += chunk.value;
        }
      }
      try {
        await readUntil(": connected");
        await postFixture(cli.baseUrl, "node-error");
        await readUntil("event: item.created");
      } finally {
        controller.abort();
      }
    });

    it("guards API and MCP by Host and Origin", async () => {
      const cli = await start();
      const host = await httpRequest(cli.port, {
        path: "/api/sentra/health",
        headers: { host: "evil.example" },
      });
      expect(host.status).toBe(403);
      expect(parseJson(host.body)).toMatchObject({ error: { code: "forbidden_host" } });
      const origin = await fetch(`${cli.baseUrl}/api/sentra/health`, {
        headers: { origin: "https://evil.example" },
      });
      expect(origin.status).toBe(403);
      expect(await json(origin)).toMatchObject({ error: { code: "forbidden_origin" } });
      const mcp = await httpRequest(cli.port, {
        method: "POST",
        path: "/mcp",
        headers: { host: "evil.example", "content-type": "application/json" },
        body: "{}",
      });
      expect(mcp.status).toBe(403);
      expect(parseJson(mcp.body)).toMatchObject({ jsonrpc: "2.0", id: null });
      const preflight = await fetch(`${cli.baseUrl}/my-app/3f9a1c/web/api/1/envelope/`, {
        method: "OPTIONS",
        headers: { origin: "https://evil.example", "access-control-request-method": "POST" },
      });
      expect(preflight.status).toBe(204);
      expect(preflight.headers.get("access-control-allow-origin")).toBe("*");
    });

    it("--no-api and --no-mcp disable the routes", async () => {
      const cli = await start(["--no-api", "--no-mcp"]);
      const health = await fetch(`${cli.baseUrl}/api/sentra/health`);
      expect(health.status).toBe(404);
      const mcp = await fetch(`${cli.baseUrl}/mcp`, { method: "POST", body: "{}" });
      expect(mcp.status).toBe(404);
      expect(cli.stdout()).not.toContain("query API");
      expect(cli.stdout()).not.toMatch(/^MCP /m);
    });

    it("persists to SQLite across restarts", async () => {
      const db = path.join(tempDir, "nested", "sentra.db");
      const args = ["--port", "0", "--storage", "sqlite", "--db", db];
      const first = await spawnCli(args);
      processes.push(first);
      expect(first.stdout()).toMatch(/^storage {7}sqlite .*(?:better-sqlite3|node)/m);
      const posted = await postFixture(first.baseUrl, "node-error");
      expect(posted.status).toBe(200);
      expect(await first.stop()).toEqual({ code: 0, signal: null });

      const second = await spawnCli(args);
      processes.push(second);
      const issues = list(
        field(await json(await fetch(`${second.baseUrl}/api/sentra/issues`)), "items"),
      );
      expect(issues).toHaveLength(1);
      expect(first.stderr()).not.toContain("ExperimentalWarning");
      expect(second.stderr()).not.toContain("ExperimentalWarning");
    });
  });

  describe("mcp", () => {
    it("answers MCP tools/list", async () => {
      const cli = await start();
      await postFixture(cli.baseUrl, "node-error");
      const issues = list(
        field(await json(await fetch(`${cli.baseUrl}/api/sentra/issues`)), "items"),
      );
      const shortId = String(field(issues[0], "shortId"));
      const client = await connectMcp(cli);
      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name)).toEqual(TOOL_NAMES);
      const result = await client.callTool({ name: "sentra_list_issues", arguments: {} });
      expect(JSON.stringify(result.content)).toContain(shortId);
    });

    it("rejects GET and DELETE on /mcp", async () => {
      const cli = await start();
      for (const method of ["GET", "DELETE"]) {
        const response = await fetch(`${cli.baseUrl}/mcp`, { method });
        expect(response.status).toBe(405);
        expect(response.headers.get("allow")).toBe("POST");
      }
    });
  });

  describe("exit codes", () => {
    it("exits 0 on SIGTERM", async () => {
      const cli = await spawnCli(MEMORY);
      expect(await cli.stop("SIGTERM")).toEqual({ code: 0, signal: null });
    });

    it("exits 0 on SIGINT", async () => {
      const cli = await spawnCli(MEMORY);
      expect(await cli.stop("SIGINT")).toEqual({ code: 0, signal: null });
    });

    it("exits 1 when the port is in use", async () => {
      const cli = await start();
      const second = await runCliOnce(["--port", String(cli.port), "--storage", "memory"]);
      expect(second.code).toBe(1);
      expect(second.stderr).toContain("already in use");
    });

    it("prints plain help with core defaults when stdout is a pipe", async () => {
      const help = await runCliOnce(["--help"], { COLORTERM: "truecolor", NO_COLOR: "" });
      expect(help.code).toBe(0);
      expect(help.stdout).not.toContain("\u001B[");
      expect(help.stdout).toContain("USAGE:");
      expect(help.stdout).toContain("(default 20mb)");
      expect(help.stdout).toContain("(default 10000)");
    });

    it("exits 2 on invalid flags", async () => {
      const port = await runCliOnce(["--port", "abc"]);
      expect(port.code).toBe(2);
      expect(port.stderr).toContain("--port");
      const storage = await runCliOnce(["--storage", "pg"]);
      expect(storage.code).toBe(2);
    });
  });

  describe("dsn", () => {
    it("sentra dsn prints one line", async () => {
      const result = await runCliOnce([
        "dsn",
        "--project",
        "my-app",
        "--session",
        "3f9a1c",
        "--service",
        "web",
      ]);
      expect(result).toMatchObject({
        code: 0,
        stdout: "http://sentra@127.0.0.1:8969/my-app/3f9a1c/web/1\n",
      });
      const invalid = await runCliOnce(["dsn", "--project", "a/b"]);
      expect(invalid.code).toBe(2);
    });

    it("runs through a bin symlink", async () => {
      const link = path.join(tempDir, "sentra");
      symlinkSync(cliEntry(), link);
      const result = await runCliOnce(["dsn"], undefined, link);
      expect(result).toMatchObject({ code: 0, stdout: "http://sentra@127.0.0.1:8969/1\n" });
    });
  });
});
