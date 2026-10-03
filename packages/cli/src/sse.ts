import type { IncomingMessage, ServerResponse } from "node:http";

import { SentraValidationError, liveFilterSchema } from "@bosdev/sentra-core";
import type { LiveEvent, LiveFilter, Sentra } from "@bosdev/sentra-core";
import { prettifyError } from "zod";

import { LIVE_KEYS, parseFilterParams } from "#src/api.js";
import { routeSearchParams, sendError } from "#src/router.js";
import type { NodeListener } from "#src/router.js";

interface StreamHandler {
  listener: NodeListener;
  /** Ends every open stream; later connections get `503`. */
  closeAll(): void;
  readonly connections: number;
}

const DEFAULT_HEARTBEAT_MS = 15_000;
/** A client this far behind is dropped instead of buffering without bound. */
const MAX_BUFFERED_BYTES = 8 * 1024 * 1024;

function formatSseEvent(event: LiveEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

function parseLiveFilter(req: IncomingMessage): LiveFilter {
  const { filter } = parseFilterParams(routeSearchParams(req), LIVE_KEYS);
  const result = liveFilterSchema.safeParse(filter);
  if (!result.success) {
    throw new SentraValidationError(
      "invalid_filter",
      `invalid live filter: ${prettifyError(result.error)}`,
      { details: result.error.issues },
    );
  }
  return result.data;
}

/** Sends the `400` itself and returns `null` on a bad filter. */
function liveFilterOrReject(req: IncomingMessage, res: ServerResponse): LiveFilter | null {
  try {
    return parseLiveFilter(req);
  } catch (error) {
    if (error instanceof SentraValidationError) {
      sendError(res, 400, error.code, error.message, error.details);
      return null;
    }
    throw error;
  }
}

function createStreamHandler(deps: { sentra: Sentra; heartbeatMs?: number }): StreamHandler {
  const { sentra } = deps;
  const heartbeatMs = deps.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const open = new Set<ServerResponse>();
  let closed = false;

  function serve(req: IncomingMessage, res: ServerResponse): void {
    if (req.method !== "GET") {
      res.setHeader("allow", "GET");
      sendError(res, 405, "method_not_allowed", `${req.method ?? "?"} is not allowed here`);
      return;
    }
    if (closed) {
      sendError(res, 503, "shutting_down", "server is shutting down");
      return;
    }
    const filter = liveFilterOrReject(req, res);
    if (filter === null) {
      return;
    }

    req.socket.setTimeout(0);
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
      "x-content-type-options": "nosniff",
    });
    res.flushHeaders();
    res.write(": connected\n\n");
    open.add(res);

    function send(chunk: string): void {
      if (res.writableEnded || res.destroyed) {
        return;
      }
      if (res.writableLength > MAX_BUFFERED_BYTES) {
        res.destroy();
        return;
      }
      res.write(chunk);
    }

    const unsubscribe = sentra.subscribe(filter, (event) => {
      send(formatSseEvent(event));
    });
    const timer = setInterval(() => {
      send(": ping\n\n");
    }, heartbeatMs);
    timer.unref();
    res.on("close", () => {
      clearInterval(timer);
      unsubscribe();
      open.delete(res);
    });
  }

  return {
    listener: serve,
    closeAll() {
      closed = true;
      for (const res of open) {
        res.end();
      }
    },
    get connections() {
      return open.size;
    },
  };
}

export { createStreamHandler, formatSseEvent };
export type { StreamHandler };
