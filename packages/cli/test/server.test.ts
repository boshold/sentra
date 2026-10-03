import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import { resolveStartConfig, runCli } from "#src/cli.js";
import type { StartConfig } from "#src/cli.js";
import { CliRuntimeError } from "#src/config.js";
import { start, startServer } from "#src/server.js";
import type { RunningServer } from "#src/server.js";

import { loadEnvelopeFixture } from "../../../test/fixtures/envelopes.js";

import { httpRequest, parseJson } from "./http.js";

const running: RunningServer[] = [];

afterEach(async () => {
  await Promise.all(running.splice(0).map(async (server) => server.close()));
});

function memoryConfig(flags: Record<string, unknown> = {}): StartConfig {
  return resolveStartConfig({ storage: "memory", port: 0, ...flags }, {}, process.cwd());
}

async function startMemory(flags: Record<string, unknown> = {}): Promise<RunningServer> {
  const server = await startServer(memoryConfig(flags));
  running.push(server);
  return server;
}

async function canListen(port: number): Promise<boolean> {
  const probe = createServer();
  return new Promise((resolve) => {
    probe.once("error", () => {
      resolve(false);
    });
    probe.listen(port, "127.0.0.1", () => {
      probe.close(() => {
        resolve(true);
      });
    });
  });
}

describe("startServer", () => {
  it("listens on a random port and ingests envelopes", async () => {
    const server = await startMemory();
    expect(server.port).toBeGreaterThan(0);
    expect(server.url).toBe(`http://127.0.0.1:${server.port}`);
    expect(server.publicUrl).toBe(`http://localhost:${server.port}`);
    const fixture = loadEnvelopeFixture("node-error");
    const result = await httpRequest(server.port, {
      method: "POST",
      path: "/api/1/envelope/",
      headers: { host: "localhost" },
      body: fixture.body,
    });
    expect(result.status).toBe(200);
    expect(parseJson(result.body)).toEqual({ id: expect.any(String) });
  });

  it("keeps --public-url", async () => {
    const server = await startMemory({ publicUrl: "http://192.168.1.10:9000" });
    expect(server.publicUrl).toBe("http://192.168.1.10:9000");
  });

  it("rejects a port in use and runCli exits 1", async () => {
    const first = await startMemory();
    const failure: unknown = await startServer(memoryConfig({ port: first.port })).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(CliRuntimeError);
    expect(failure).toHaveProperty("message", `port ${first.port} is already in use on 127.0.0.1`);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const code = await runCli(["--storage", "memory", "--port", String(first.port)]);
      expect(code).toBe(1);
      expect(stderr).toHaveBeenCalledWith(expect.stringContaining("already in use"));
    } finally {
      stderr.mockRestore();
    }
  });

  it("maps other listen errors to CliRuntimeError", async () => {
    await expect(startServer(memoryConfig({ host: "192.0.2.123" }))).rejects.toBeInstanceOf(
      CliRuntimeError,
    );
  });

  it("maps storage failures to CliRuntimeError", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "sentra-cli-"));
    try {
      const blocker = path.join(dir, "file");
      writeFileSync(blocker, "");
      const config = resolveStartConfig(
        { port: 0, db: path.join(blocker, "s.db") },
        {},
        process.cwd(),
      );
      const failure: unknown = await startServer(config).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(CliRuntimeError);
      expect(failure).toMatchObject({ cause: { code: "storage_unavailable" } });
      const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      try {
        expect(await runCli(["--port", "0", "--db", path.join(blocker, "s.db")])).toBe(1);
      } finally {
        stderr.mockRestore();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("closes once and frees the port", async () => {
    const server = await startServer(memoryConfig());
    const close = vi.spyOn(server.sentra, "close");
    await Promise.all([server.close(), server.close()]);
    await server.close();
    expect(close).toHaveBeenCalledTimes(1);
    expect(await canListen(server.port)).toBe(true);
  });

  it("drops active connections after the drain timeout", async () => {
    const server = await startServer(memoryConfig());
    const socket = connect(server.port, "127.0.0.1");
    const closedSocket = new Promise<void>((resolve) => {
      socket.on("close", () => {
        resolve();
      });
    });
    const continued = new Promise<void>((resolve) => {
      socket.once("data", () => {
        resolve();
      });
    });
    socket.write(
      "POST /api/1/envelope/ HTTP/1.1\r\nHost: localhost\r\nContent-Length: 100\r\nExpect: 100-continue\r\n\r\n",
    );
    await continued;
    const startedAt = performance.now();
    await server.close();
    await closedSocket;
    expect(performance.now() - startedAt).toBeGreaterThanOrEqual(1900);
  });
});

describe("start", () => {
  it("shuts down on SIGINT", async () => {
    const before = process.listenerCount("SIGINT");
    const done = start(memoryConfig());
    await vi.waitFor(() => {
      expect(process.listenerCount("SIGINT")).toBe(before + 1);
    });
    process.emit("SIGINT");
    await done;
    expect(process.listenerCount("SIGINT")).toBe(before);
    expect(process.listenerCount("SIGTERM")).toBe(0);
  });
});
