import type { IncomingMessage, ServerResponse } from "node:http";

import type { SentraLogger } from "@boshold/sentra-core";

import type { Guard } from "#src/guard.js";

/** May return a promise; rejections become `500 internal_error`. */
type NodeListener = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;

interface Routes {
  /** `toNodeListener(sentra.handle)`. */
  ingest: NodeListener;
  /** `null` when `--no-api`. */
  api: NodeListener | null;
  /** `GET /api/sentra/stream` (SSE); `null` when `--no-api`. */
  stream: NodeListener | null;
  /** `null` when `--no-mcp`. */
  mcp: NodeListener | null;
}

const API_PREFIX = "/api/sentra";
const JSON_TYPE = "application/json; charset=utf-8";

function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": JSON_TYPE,
    "content-length": String(Buffer.byteLength(text)),
    "x-content-type-options": "nosniff",
    ...headers,
  });
  res.end(text);
}

function sendError(
  res: ServerResponse,
  status: number,
  code: string,
  message: string,
  details?: unknown,
): void {
  sendJson(res, status, {
    error: details === undefined ? { code, message } : { code, message, details },
  });
}

function sendJsonRpcError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { jsonrpc: "2.0", error: { code: -32_000, message }, id: null });
}

type Target = { kind: "ingest" } | { kind: "mcp" | "api"; handler: NodeListener };

/** Disabled routes fall through to ingest (404) without the guard. */
function selectTarget(routes: Routes, pathname: string): Target {
  if (pathname === "/mcp") {
    return routes.mcp ? { kind: "mcp", handler: routes.mcp } : { kind: "ingest" };
  }
  if (pathname === API_PREFIX || pathname.startsWith(`${API_PREFIX}/`)) {
    const handler = pathname === `${API_PREFIX}/stream` ? routes.stream : routes.api;
    return handler ? { kind: "api", handler } : { kind: "ingest" };
  }
  return { kind: "ingest" };
}

/** WHATWG-normalized pathname; handlers must match on this, never on raw `req.url`. */
function routePathname(req: IncomingMessage): string {
  return URL.parse(req.url ?? "/", "http://x")?.pathname ?? "/";
}

/** Normalized query parameters of the request. */
function routeSearchParams(req: IncomingMessage): URLSearchParams {
  return URL.parse(req.url ?? "/", "http://x")?.searchParams ?? new URLSearchParams();
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value.join(",") : value;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function createRouter(
  routes: Routes,
  guard: Guard,
  options: { logger?: SentraLogger } = {},
): (req: IncomingMessage, res: ServerResponse) => void {
  const { logger } = options;

  function fail(res: ServerResponse, error: unknown): void {
    logger?.error(`request handler failed: ${messageOf(error)}`, { error });
    if (res.headersSent) {
      res.destroy();
      return;
    }
    sendError(res, 500, "internal_error", "internal error");
  }

  async function dispatch(
    handler: NodeListener,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    try {
      await handler(req, res);
    } catch (error) {
      fail(res, error);
    }
  }

  return function router(req, res) {
    const pathname = routePathname(req);
    const target = selectTarget(routes, pathname);
    if (target.kind === "ingest") {
      void dispatch(routes.ingest, req, res);
      return;
    }
    const verdict = guard({ host: req.headers.host, origin: headerValue(req.headers.origin) });
    if (!verdict.ok) {
      if (target.kind === "mcp") {
        sendJsonRpcError(res, 403, verdict.message);
      } else {
        sendError(res, 403, verdict.code, verdict.message);
      }
      return;
    }
    void dispatch(target.handler, req, res);
  };
}

export { createRouter, routePathname, routeSearchParams, sendError, sendJson };
export type { NodeListener, Routes };
