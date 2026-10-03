import { once } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";

type FetchHandler = (request: Request) => Promise<Response>;

/** `duplex` is required for stream bodies but missing from the DOM lib types. */
interface StreamingRequestInit extends RequestInit {
  duplex?: "half";
}

const BODYLESS_METHODS = new Set(["GET", "HEAD"]);

function noop(): void {
  // Errors are handled by the caller or are irrelevant after a disconnect.
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

function writeInternalError(res: ServerResponse, error: unknown): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  const body = JSON.stringify({ error: { code: "internal_error", message: messageOf(error) } });
  res.writeHead(500, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
    "access-control-allow-origin": "*",
  });
  res.end(body);
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

async function writeBody(res: ServerResponse, body: ReadableStream<Uint8Array>): Promise<void> {
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
    writeInternalError(res, error);
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
  request: Request,
  res: ServerResponse,
): Promise<Response | null> {
  try {
    return await handle(request);
  } catch (error) {
    writeInternalError(res, error);
    return null;
  }
}

async function serve(
  handle: FetchHandler,
  req: IncomingMessage,
  res: ServerResponse,
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

  const response = await respond(handle, toRequest(req, controller.signal), res);
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
  await writeBody(res, response.body);
}

async function serveSafely(
  handle: FetchHandler,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  try {
    await serve(handle, req, res);
  } catch (error) {
    writeInternalError(res, error);
  }
}

/** Mounts a fetch-style handler on `node:http`; streams request and response bodies. */
function toNodeListener(handle: FetchHandler): (req: IncomingMessage, res: ServerResponse) => void {
  return function listener(req, res) {
    void serveSafely(handle, req, res);
  };
}

export { toNodeListener };
