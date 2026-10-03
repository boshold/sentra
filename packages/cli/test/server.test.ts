import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";

import { resolveStartConfig, runCli } from "#src/cli.js";
import type { StartConfig } from "#src/cli.js";
import { CliRuntimeError } from "#src/config.js";
import { start, startServer } from "#src/server.js";
import type { RunningServer } from "#src/server.js";

import { loadEnvelopeFixture } from "../../../test/fixtures/envelopes.js";

import { httpRequest, parseJson } from "./http.js";

const running: RunningServer[] = [];

interface CapturedIo {
  stdout: PassThrough;
  stderr: PassThrough;
  text: { stdout: string; stderr: string };
}

function captureIo(): CapturedIo {
  const io = {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    text: { stdout: "", stderr: "" },
  };
  io.stdout.on("data", (chunk: Buffer) => {
    io.text.stdout += chunk.toString("utf8");
  });
  io.stderr.on("data", (chunk: Buffer) => {
    io.text.stderr += chunk.toString("utf8");
  });
  return io;
}

afterEach(async () => {
  await Promise.all(running.splice(0).map(async (server) => server.close()));
});

function memoryConfig(flags: Record<string, unknown> = {}): StartConfig {
  return resolveStartConfig({ storage: "memory", port: 0, ...flags }, {}, process.cwd());
}

async function startMemory(
  flags: Record<string, unknown> = {},
  io: CapturedIo = captureIo(),
): Promise<RunningServer> {
  const server = await startServer(memoryConfig(flags), io);
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

describe("live output wiring", () => {
  async function postFixture(server: RunningServer, name: string): Promise<void> {
    const result = await httpRequest(server.port, {
      method: "POST",
      path: "/my-app/3f9a1c/web/api/1/envelope/",
      headers: { host: "localhost" },
      body: loadEnvelopeFixture(name).body,
    });
    expect(result.status).toBe(200);
  }

  it("prints the banner and pretty lines to stdout by default", async () => {
    const io = captureIo();
    const server = await startMemory({ noColor: true }, io);
    expect(io.text.stdout).toMatch(/^sentra .+ {2}listening on http:\/\/127\.0\.0\.1:\d+\n/);
    await postFixture(server, "node-error");
    await vi.waitFor(() => {
      expect(io.text.stdout).toMatch(/ERROR my-app\/3f9a1c\/web {2}Error: boom/);
    });
    expect(io.text.stdout).toMatch(/issue [0-9a-f]{8} NEW · 1×/);
    expect(io.text.stderr).toBe("");
  });

  it("writes the banner to stderr and no live output with --quiet", async () => {
    const io = captureIo();
    const server = await startMemory({ quiet: true }, io);
    expect(io.text.stderr).toContain("listening on");
    await postFixture(server, "node-error");
    const items = await server.sentra.query.listItems({ from: 0 });
    expect(items.items).toHaveLength(1);
    expect(io.text.stdout).toBe("");
  });

  it("writes one NDJSON line per passing event with --format json", async () => {
    const io = captureIo();
    const server = await startMemory({ format: "json" }, io);
    expect(io.text.stderr).toContain("listening on");
    await postFixture(server, "node-transaction");
    await postFixture(server, "node-error");
    await postFixture(server, "node-logs");
    await vi.waitFor(() => {
      expect(io.text.stdout.trimEnd().split("\n")).toHaveLength(3);
    });
    const events = io.text.stdout
      .trimEnd()
      .split("\n")
      .map((line) => parseJson(line));
    expect(events).toEqual([
      expect.objectContaining({
        type: "item.created",
        item: expect.objectContaining({ kind: "error" }),
      }),
      expect.objectContaining({ item: expect.objectContaining({ kind: "log" }) }),
      expect.objectContaining({ item: expect.objectContaining({ kind: "log" }) }),
    ]);
  });

  it("ends live output quietly when stdout fails with EPIPE", async () => {
    let writes = 0;
    const stdout = new Writable({
      write(_chunk, _encoding, done) {
        writes += 1;
        done(Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
      },
    });
    const io = { stdout, stderr: new PassThrough() };
    const server = await startServer(memoryConfig({ format: "json", quiet: false }), io);
    running.push(server);
    await postFixture(server, "node-error");
    await vi.waitFor(() => {
      expect(stdout.destroyed).toBe(true);
    });
    await postFixture(server, "node-error");
    expect(writes).toBe(1);
    expect(() => stdout.emit("error", new Error("write EPIPE again"))).not.toThrow();
  });

  it("stops live output after close", async () => {
    const io = captureIo();
    const server = await startServer(memoryConfig({ format: "json" }), io);
    const unsubscribed = vi.spyOn(server.sentra, "close");
    await server.close();
    expect(unsubscribed).toHaveBeenCalledTimes(1);
    expect(io.text.stdout).toBe("");
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
