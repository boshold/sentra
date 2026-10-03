import { createServer } from "node:http";
import type { Server } from "node:http";
import { homedir } from "node:os";

import { SentraConfigError, createSentra, toNodeListener } from "@bosdev/sentra-core";
import type { Sentra, SentraLogger } from "@bosdev/sentra-core";

import { createApiHandler } from "#src/api.js";
import { renderBanner } from "#src/banner.js";
import {
  CliRuntimeError,
  CliUsageError,
  createStderrLogger,
  lanAddresses,
  toSentraOptions,
} from "#src/config.js";
import type { StartConfig } from "#src/config.js";
import { createGuard } from "#src/guard.js";
import { createMcpRoute } from "#src/mcp.js";
import { createLiveFilter } from "#src/printer/filter.js";
import { formatLiveEventJson } from "#src/printer/json.js";
import { formatLiveEvent } from "#src/printer/pretty.js";
import { createRouter } from "#src/router.js";
import { createStreamHandler } from "#src/sse.js";

interface ServerIo {
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
}

interface RunningServer {
  /** Listen URL, e.g. `http://127.0.0.1:8969`. */
  url: string;
  port: number;
  /** Base URL for DSNs: `--public-url` or `http://localhost:<port>`. */
  publicUrl: string;
  sentra: Sentra;
  /** Idempotent. */
  close(): Promise<void>;
}

const DRAIN_TIMEOUT_MS = 2000;

function urlHost(host: string): string {
  return host.includes(":") ? `[${host}]` : host;
}

function errorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null) {
    return null;
  }
  const code: unknown = Reflect.get(error, "code");
  return typeof code === "string" ? code : null;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function openSentra(config: StartConfig, logger: SentraLogger): Promise<Sentra> {
  try {
    return await createSentra(toSentraOptions(config, logger));
  } catch (error) {
    if (error instanceof SentraConfigError) {
      throw new CliUsageError(error.message);
    }
    throw new CliRuntimeError(`cannot start: ${messageOf(error)}`, { cause: error });
  }
}

async function listen(server: Server, config: StartConfig): Promise<void> {
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(config.port, config.host, () => {
        server.off("error", reject);
        resolve();
      });
    });
  } catch (error) {
    if (errorCode(error) === "EADDRINUSE") {
      throw new CliRuntimeError(`port ${config.port} is already in use on ${config.host}`, {
        cause: error,
      });
    }
    throw new CliRuntimeError(messageOf(error), { cause: error });
  }
}

function boundPort(server: Server): number {
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new CliRuntimeError("server has no TCP address");
  }
  return address.port;
}

function printBanner(
  config: StartConfig,
  io: ServerIo,
  sentra: Sentra,
  address: { port: number; publicUrl: string },
): void {
  const info = sentra.info();
  const lines = renderBanner({
    version: info.version,
    host: config.host,
    port: address.port,
    publicUrl: address.publicUrl,
    storage: info.storage,
    retention: info.retention,
    maxItems: config.maxItems,
    api: config.api,
    mcp: config.mcp,
    lanAddresses: lanAddresses(),
    homeDir: homedir(),
  });
  // Stdout stays clean NDJSON with --format json.
  const stream = config.quiet || config.format === "json" ? io.stderr : io.stdout;
  stream.write(`${lines.join("\n")}\n`);
}

function subscribeLive(
  config: StartConfig,
  stdout: NodeJS.WritableStream,
  sentra: Sentra,
): () => void {
  const passes = createLiveFilter(config);
  let active = true;
  const unsubscribe = sentra.subscribe({}, (event) => {
    if (!active || !passes(event)) {
      return;
    }
    const lines =
      config.format === "json"
        ? [formatLiveEventJson(event)]
        : formatLiveEvent(event, { color: config.color, stream: stdout });
    stdout.write(`${lines.join("\n")}\n`);
  });
  // Stays registered after stop() so later errors on a broken pipe are not unhandled.
  function stop(): void {
    if (active) {
      active = false;
      unsubscribe();
    }
  }
  // A closed pipe (EPIPE, e.g. `| head -1`) ends live output; the server keeps running.
  stdout.on("error", stop);
  return stop;
}

interface ServerHooks {
  /** SSE heartbeat; tests shorten it. */
  heartbeatMs?: number;
}

async function startServer(
  config: StartConfig,
  io: ServerIo = { stdout: process.stdout, stderr: process.stderr },
  hooks: ServerHooks = {},
): Promise<RunningServer> {
  const logger = createStderrLogger(config.logLevel, io.stderr);
  const sentra = await openSentra(config, logger);
  const guard = createGuard({ boundHost: config.host, allowedHosts: config.allowedHosts });
  const handlers = {
    ingest: toNodeListener(async (request) => sentra.handle(request)),
    api: config.api ? createApiHandler({ sentra, logger }) : null,
  };
  const stream = config.api
    ? createStreamHandler({ sentra, heartbeatMs: hooks.heartbeatMs })
    : null;
  const mcp = config.mcp
    ? createMcpRoute({ sentra, version: sentra.info().version, logger })
    : null;
  const routes = {
    ...handlers,
    stream: stream?.listener ?? null,
    mcp: mcp?.listener ?? null,
  };
  const server = createServer(createRouter(routes, guard, { logger }));
  try {
    await listen(server, config);
  } catch (error) {
    await mcp?.close();
    await sentra.close();
    throw error;
  }
  const port = boundPort(server);
  const publicUrl = config.publicUrl ?? `http://localhost:${port}`;
  printBanner(config, io, sentra, { port, publicUrl });
  const unsubscribe = config.quiet ? null : subscribeLive(config, io.stdout, sentra);

  async function shutdown(): Promise<void> {
    unsubscribe?.();
    const stopped = new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
    stream?.closeAll();
    try {
      await mcp?.close();
    } catch (error) {
      logger.warn(`mcp handler close failed: ${messageOf(error)}`);
    }
    server.closeIdleConnections();
    const timer = setTimeout(() => {
      server.closeAllConnections();
    }, DRAIN_TIMEOUT_MS);
    try {
      await stopped;
    } finally {
      clearTimeout(timer);
      await sentra.close();
    }
  }

  let closing: Promise<void> | null = null;
  return {
    url: `http://${urlHost(config.host)}:${port}`,
    port,
    publicUrl,
    sentra,
    close: async () => {
      closing ??= shutdown();
      return closing;
    },
  };
}

const SIGNALS = ["SIGINT", "SIGTERM"] as const;

/** Starts the server and resolves after a clean shutdown on SIGINT/SIGTERM; a second signal exits 1. */
async function start(config: StartConfig): Promise<void> {
  const running = await startServer(config);
  const waiters: (() => void)[] = [];
  const signalled = new Promise<void>((resolve) => {
    waiters.push(resolve);
  });
  let stopping = false;
  function onSignal(): void {
    if (stopping) {
      process.exit(1);
    }
    stopping = true;
    for (const wake of waiters) {
      wake();
    }
  }
  for (const signal of SIGNALS) {
    process.on(signal, onSignal);
  }
  try {
    await signalled;
    await running.close();
  } finally {
    for (const signal of SIGNALS) {
      process.off(signal, onSignal);
    }
  }
}

export { start, startServer };
export type { RunningServer, ServerHooks, ServerIo };
