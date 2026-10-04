import { once } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";

import { errorResponse } from "#src/ingest/cors.js";
import { isIngestPath } from "#src/ingest/route.js";
import { messageOf } from "#src/util/error.js";

type FetchHandler = (request: Request) => Promise<Response>;

/** Writes the error response; called only before anything was sent, with all headers cleared. */
type ErrorWriter = (res: ServerResponse, error: unknown) => void;

interface NodeListenerOptions {
  /** Replaces the default `500 internal_error` body (which includes the message and CORS `*`). */
  onError?: ErrorWriter;
}

/** `duplex` is required for stream bodies but missing from the DOM lib types. */
interface StreamingRequestInit extends RequestInit {
  duplex?: "half";
}

const BODYLESS_METHODS = new Set(["GET", "HEAD"]);

function noop(): void {
  // Errors are handled by the caller or are irrelevant after a disconnect.
}

function requestUrl(req: IncomingMessage): URL {
  const path = req.url ?? "/";
  const { host } = req.headers;
  if (host !== undefined) {
    const url = URL.parse(path, `http://${host}`);
    if (url !== null) {
      return url;
    }
  }
  return new URL(path, "http://localhost");
}

const ABSOLUTE_FORM = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i;

/** First `.` / `..` segment of the raw request path (also `%2e`, `\` separators); URL parsing would drop it. */
function rawDotSegment(req: IncomingMessage): string | null {
  const [path = ""] = (req.url ?? "/").replace(ABSOLUTE_FORM, "").split(/[?#]/, 1);
  const found = path.split(/[/\\]/).find((segment) => /^(?:\.|%2e){1,2}$/i.test(segment));
  return found ?? null;
}

/** An ingest path with a dot segment would land in another scope after URL normalization. */
function dotSegmentRejection(req: IncomingMessage): Response | null {
  const segment = rawDotSegment(req);
  if (segment === null || !isIngestPath(requestUrl(req).pathname)) {
    return null;
  }
  return errorResponse(400, "invalid_scope", `invalid scope segment ${JSON.stringify(segment)}`);
}

function requestHeaders(req: IncomingMessage): Headers {
  const headers = new Headers();
  const raw = req.rawHeaders;
  for (let index = 0; index + 1 < raw.length; index += 2) {
    const name = raw[index];
    const value = raw[index + 1];
    // HTTP/2 pseudo headers are not valid in Headers.
    if (name !== undefined && value !== undefined && !name.startsWith(":")) {
      headers.append(name, value);
    }
  }
  return headers;
}

/** Pull-based body stream; pauses the socket under backpressure and after cancel. */
function requestBody(req: IncomingMessage): ReadableStream<Uint8Array> {
  let settled = false;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      req.on("data", (chunk: unknown) => {
        if (settled || !(chunk instanceof Uint8Array)) {
          return;
        }
        controller.enqueue(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
        if ((controller.desiredSize ?? 0) <= 0) {
          req.pause();
        }
      });
      req.once("end", () => {
        if (!settled) {
          settled = true;
          controller.close();
        }
      });
      req.once("error", (error) => {
        if (!settled) {
          settled = true;
          controller.error(error);
        }
      });
    },
    pull() {
      req.resume();
    },
    cancel() {
      settled = true;
      req.pause();
    },
  });
}

function toRequest(req: IncomingMessage, signal: AbortSignal): Request {
  const method = req.method ?? "GET";
  const init: StreamingRequestInit = { method, headers: requestHeaders(req), signal };
  if (!BODYLESS_METHODS.has(method)) {
    init.body = requestBody(req);
    init.duplex = "half";
  }
  return new Request(requestUrl(req), init);
}

function writeHeaders(res: ServerResponse, response: Response, closeConnection: boolean): void {
  res.statusCode = response.status;
  for (const [name, value] of response.headers) {
    if (name !== "set-cookie") {
      res.setHeader(name, value);
    }
  }
  const cookies = response.headers.getSetCookie();
  if (cookies.length > 0) {
    res.setHeader("set-cookie", cookies);
  }
  if (closeConnection) {
    res.setHeader("connection", "close");
  }
}

function defaultErrorWriter(res: ServerResponse, error: unknown): void {
  const body = JSON.stringify({ error: { code: "internal_error", message: messageOf(error) } });
  res.writeHead(500, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
    "access-control-allow-origin": "*",
  });
  res.end(body);
}

function failWith(writeError: ErrorWriter): ErrorWriter {
  return function fail(res, error) {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    // Drop headers copied from the failed response (e.g. content-encoding, set-cookie).
    for (const name of res.getHeaderNames()) {
      res.removeHeader(name);
    }
    try {
      writeError(res, error);
    } catch {
      // A failing error writer must not throw out of the listener.
      res.destroy();
    }
  };
}

/** `true` on `drain`, `false` if the response closed first. */
async function drained(res: ServerResponse): Promise<boolean> {
  const controller = new AbortController();
  const { signal } = controller;
  async function onDrain(): Promise<boolean> {
    await once(res, "drain", { signal });
    return true;
  }
  async function onClose(): Promise<boolean> {
    await once(res, "close", { signal });
    return false;
  }
  try {
    return await Promise.race([onDrain(), onClose()]);
  } finally {
    controller.abort();
  }
}

async function cancelStream(
  stream: ReadableStream<Uint8Array> | ReadableStreamDefaultReader<Uint8Array>,
): Promise<void> {
  try {
    await stream.cancel();
  } catch {
    // Already errored or closed.
  }
}

async function writeBody(
  res: ServerResponse,
  body: ReadableStream<Uint8Array>,
  fail: ErrorWriter,
): Promise<void> {
  const reader = body.getReader();
  // A disconnected client must not leave an endless stream (e.g. SSE) pending.
  function onClose(): void {
    void cancelStream(reader);
  }
  res.once("close", onClose);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done || res.destroyed) {
        break;
      }
      if (!res.write(value) && !(await drained(res))) {
        break;
      }
    }
  } catch (error) {
    await cancelStream(reader);
    fail(res, error);
    return;
  } finally {
    res.off("close", onClose);
  }
  if (!res.destroyed) {
    res.end();
  }
}

async function respond(
  handle: FetchHandler,
  req: IncomingMessage,
  res: ServerResponse,
  context: { signal: AbortSignal; fail: ErrorWriter },
): Promise<Response | null> {
  try {
    return dotSegmentRejection(req) ?? (await handle(toRequest(req, context.signal)));
  } catch (error) {
    context.fail(res, error);
    return null;
  }
}

async function serve(
  handle: FetchHandler,
  req: IncomingMessage,
  res: ServerResponse,
  fail: ErrorWriter,
): Promise<void> {
  const controller = new AbortController();
  function abort(): void {
    controller.abort();
  }
  req.once("error", abort);
  res.once("close", () => {
    if (!res.writableFinished) {
      abort();
    }
  });
  res.on("error", noop);
  const bodyless = BODYLESS_METHODS.has(req.method ?? "GET");
  if (bodyless) {
    // Discard any stray body so keep-alive connections are not stalled.
    req.resume();
  }

  const response = await respond(handle, req, res, { signal: controller.signal, fail });
  if (response === null) {
    return;
  }
  if (res.destroyed) {
    if (response.body !== null) {
      await cancelStream(response.body);
    }
    return;
  }
  // Unread upload (e.g. 413): close the connection instead of reading the rest.
  writeHeaders(res, response, !bodyless && !req.readableEnded);
  if (response.body === null) {
    res.end();
    return;
  }
  await writeBody(res, response.body, fail);
}

async function serveSafely(
  handle: FetchHandler,
  req: IncomingMessage,
  res: ServerResponse,
  fail: ErrorWriter,
): Promise<void> {
  try {
    await serve(handle, req, res, fail);
  } catch (error) {
    fail(res, error);
  }
}

/** Mounts a fetch-style handler on `node:http`; streams request and response bodies. */
function toNodeListener(
  handle: FetchHandler,
  options: NodeListenerOptions = {},
): (req: IncomingMessage, res: ServerResponse) => void {
  const fail = failWith(options.onError ?? defaultErrorWriter);
  return function listener(req, res) {
    void serveSafely(handle, req, res, fail);
  };
}

export { toNodeListener };
export type { NodeListenerOptions };
