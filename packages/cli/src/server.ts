import { createServer } from "node:http";
import type { Server } from "node:http";

import { SentraConfigError, createSentra, toNodeListener } from "@bosdev/sentra-core";
import type { Sentra, SentraLogger } from "@bosdev/sentra-core";

import {
  CliRuntimeError,
  CliUsageError,
  createStderrLogger,
  toSentraOptions,
} from "#src/config.js";
import type { StartConfig } from "#src/config.js";
import { createGuard } from "#src/guard.js";
import { createRouter } from "#src/router.js";
import type { NodeListener } from "#src/router.js";

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

/** Runs on close before connections are dropped, e.g. to end SSE responses. */
type CloseHook = () => void;

const DRAIN_TIMEOUT_MS = 2000;

// Hooks for later route handlers; each returns `null` until implemented.
function createApiHandler(_sentra: Sentra, _config: StartConfig): NodeListener | null {
  return null;
}

function createStreamHandler(
  _sentra: Sentra,
  _config: StartConfig,
  _onClose: (hook: CloseHook) => void,
): NodeListener | null {
  return null;
}

function createMcpRoute(_sentra: Sentra, _config: StartConfig): NodeListener | null {
  return null;
}

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

async function startServer(
  config: StartConfig,
  io: ServerIo = { stdout: process.stdout, stderr: process.stderr },
): Promise<RunningServer> {
  const logger = createStderrLogger(config.logLevel, io.stderr);
  const sentra = await openSentra(config, logger);
  const closeHooks: CloseHook[] = [];
  const guard = createGuard({ boundHost: config.host, allowedHosts: config.allowedHosts });
  const routes = {
    ingest: toNodeListener(async (request) => sentra.handle(request)),
    api: config.api ? createApiHandler(sentra, config) : null,
    stream: config.api
      ? createStreamHandler(sentra, config, (hook) => {
          closeHooks.push(hook);
        })
      : null,
    mcp: config.mcp ? createMcpRoute(sentra, config) : null,
  };
  const server = createServer(createRouter(routes, guard, { logger }));
  try {
    await listen(server, config);
  } catch (error) {
    await sentra.close();
    throw error;
  }
  const port = boundPort(server);

  async function shutdown(): Promise<void> {
    const stopped = new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
    for (const hook of closeHooks.splice(0)) {
      hook();
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
    publicUrl: config.publicUrl ?? `http://localhost:${port}`,
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
export type { CloseHook, RunningServer, ServerIo };
