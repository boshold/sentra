import { string } from "zod";

import { parseDsnScope } from "#src/dsn.js";
import { SentraError } from "#src/errors.js";
import { errorResponse, jsonResponse, preflightResponse } from "#src/ingest/cors.js";
import { decompress, readBodyCapped } from "#src/ingest/decompress.js";
import { isIngestPath, parseIngestPath } from "#src/ingest/route.js";
import { parseEnvelope } from "#src/parse/envelope.js";
import type { ParsedEnvelope } from "#src/parse/envelope.js";
import type { Scope, SentraLogger } from "#src/types.js";

interface IngestLimits {
  maxEnvelopeBytes: number;
}

type IngestContext = {
  scope: Scope;
  receivedAt: Date;
  /** Original `Content-Encoding` header value, `null` if absent. */
  contentEncoding: string | null;
  /** Decompressed body. */
  raw: Uint8Array;
} & ({ parsed: ParsedEnvelope; parseError: null } | { parsed: null; parseError: string });

interface IngestHandlerOptions {
  limits: IngestLimits;
  onEnvelope(ctx: IngestContext): Promise<{ id: string }>;
  logger?: SentraLogger;
  /** Defaults to `() => new Date()`. */
  now?: () => Date;
}

function noop(): void {
  // Silent default logger.
}

const SILENT_LOGGER: SentraLogger = { debug: noop, info: noop, warn: noop, error: noop };

const STATUS_BY_CODE: Readonly<Record<string, number>> = {
  invalid_scope: 400,
  payload_too_large: 413,
  unsupported_encoding: 415,
};

const dsnSchema = string();

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function emptyBody(): Response {
  return errorResponse(400, "empty_body", "request body is empty");
}

function contentLengthOf(request: Request): number | null {
  const header = request.headers.get("content-length");
  if (header === null) {
    return null;
  }
  const value = Number.parseInt(header, 10);
  return Number.isFinite(value) ? value : null;
}

/** Fetch-style ingest handler for `POST /[project/][session/][service/]api/<id>/envelope/`. */
function createIngestHandler(
  options: IngestHandlerOptions,
): (request: Request) => Promise<Response> {
  const logger = options.logger ?? SILENT_LOGGER;
  const now = options.now ?? (() => new Date());
  const { maxEnvelopeBytes } = options.limits;

  async function deliver(ctx: IngestContext): Promise<{ id: string } | null> {
    try {
      return await options.onEnvelope(ctx);
    } catch (error) {
      logger.error(`storing envelope failed: ${messageOf(error)}`, { error });
      return null;
    }
  }

  function resolveScope(scope: Scope, hasScopeSegments: boolean, parsed: ParsedEnvelope): Scope {
    const dsn = dsnSchema.safeParse(parsed.header.dsn);
    if (hasScopeSegments || !dsn.success) {
      return scope;
    }
    try {
      return parseDsnScope(dsn.data);
    } catch (error) {
      // ParseDsnScope only throws SentraScopeError.
      logger.warn(`ignoring envelope header dsn: ${messageOf(error)}`, { dsn: dsn.data });
      return scope;
    }
  }

  async function process(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (!isIngestPath(pathname)) {
      return errorResponse(404, "not_found", `no ingest route for ${pathname}`);
    }
    if (request.method === "OPTIONS") {
      return preflightResponse();
    }
    if (request.method !== "POST") {
      const response = errorResponse(
        405,
        "method_not_allowed",
        `method ${request.method} not allowed`,
      );
      response.headers.set("Allow", "POST, OPTIONS");
      return response;
    }
    const route = parseIngestPath(pathname);
    if (route === null) {
      return errorResponse(404, "not_found", `no ingest route for ${pathname}`);
    }
    const contentLength = contentLengthOf(request);
    if (contentLength !== null && contentLength > maxEnvelopeBytes) {
      return errorResponse(413, "payload_too_large", `body exceeds ${maxEnvelopeBytes} bytes`);
    }
    const receivedAt = now();
    const body = await readBodyCapped(request.body, maxEnvelopeBytes);
    if (body.byteLength === 0) {
      return emptyBody();
    }
    const contentEncoding = request.headers.get("content-encoding");
    const raw = await decompress(body, contentEncoding, maxEnvelopeBytes);
    if (raw.byteLength === 0) {
      return emptyBody();
    }

    const result = parseEnvelope(raw);
    if (!result.ok) {
      const stored = await deliver({
        scope: route.scope,
        receivedAt,
        contentEncoding,
        raw,
        parsed: null,
        parseError: result.error,
      });
      return stored === null
        ? errorResponse(500, "storage_error", "storing the envelope failed")
        : errorResponse(400, "invalid_envelope", result.error);
    }

    const scope = resolveScope(route.scope, route.hasScopeSegments, result.envelope);
    const stored = await deliver({
      scope,
      receivedAt,
      contentEncoding,
      raw,
      parsed: result.envelope,
      parseError: null,
    });
    return stored === null
      ? errorResponse(500, "storage_error", "storing the envelope failed")
      : jsonResponse(200, { id: stored.id });
  }

  return async function handle(request: Request): Promise<Response> {
    try {
      return await process(request);
    } catch (error) {
      const status = error instanceof SentraError ? STATUS_BY_CODE[error.code] : undefined;
      if (error instanceof SentraError && status !== undefined) {
        return errorResponse(status, error.code, error.message);
      }
      if (request.signal.aborted) {
        // The client is gone; nobody reads this response.
        logger.debug(`client aborted request: ${messageOf(error)}`, { error });
        return errorResponse(499, "client_closed_request", "client closed the request");
      }
      logger.error(`ingest failed: ${messageOf(error)}`, { error });
      return errorResponse(500, "internal_error", "internal error");
    }
  };
}

export { createIngestHandler };
export type { IngestContext, IngestHandlerOptions, IngestLimits };
