import http from "node:http";
import type { AddressInfo } from "node:net";

import { toNodeListener } from "#src/node/listener.js";
import type { NodeListenerOptions } from "#src/node/listener.js";
import { createSentra } from "#src/sentra.js";
import type { Sentra } from "#src/sentra.js";

import { loadEnvelopeFixture } from "../../../../test/fixtures/envelopes.js";

const servers: http.Server[] = [];
const instances: Sentra[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      async (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => {
            resolve();
          });
        }),
    ),
  );
  await Promise.all(instances.splice(0).map(async (instance) => instance.close()));
});

async function listen(
  handle: (request: Request) => Promise<Response>,
  options?: NodeListenerOptions,
): Promise<string> {
  const server = http.createServer(toNodeListener(handle, options));
  servers.push(server);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("no address");
  }
  return `http://127.0.0.1:${(address satisfies AddressInfo).port}`;
}

async function sentraServer(
  options?: Parameters<typeof createSentra>[0],
): Promise<{ sentra: Sentra; base: string }> {
  const sentra = await createSentra(options);
  instances.push(sentra);
  return { sentra, base: await listen(sentra.handle) };
}

interface RawResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  chunks: string[];
}

/** Request over `node:http` that collects body chunks as they arrive. */
async function rawRequest(
  url: string,
  options: http.RequestOptions,
  write?: (request: http.ClientRequest) => void,
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const request = http.request(url, options, (response) => {
      const chunks: string[] = [];
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => chunks.push(chunk));
      response.on("end", () => {
        resolve({ status: response.statusCode ?? 0, headers: response.headers, chunks });
      });
      response.on("error", reject);
    });
    request.on("error", reject);
    if (write === undefined) {
      request.end();
    } else {
      write(request);
    }
  });
}

describe("toNodeListener with sentra.handle", () => {
  it("ingests an envelope", async () => {
    const { sentra, base } = await sentraServer();
    const fixture = loadEnvelopeFixture("node-error");
    const response = await fetch(`${base}/my-app/s1/web/api/1/envelope/`, {
      method: "POST",
      body: fixture.body,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: "5de6e5b4c2d54107b369e4ad5a6909cd" });
    const page = await sentra.query.listItems({ project: "my-app", session: "s1", service: "web" });
    expect(page.items.map((item) => item.kind)).toEqual(["error"]);
  });

  it("ingests a gzip body", async () => {
    const { base } = await sentraServer();
    const fixture = loadEnvelopeFixture("node-gzip");
    const response = await fetch(`${base}/my-app/s1/web/api/1/envelope/`, {
      method: "POST",
      headers: { "Content-Encoding": "gzip" },
      body: fixture.body,
    });
    expect(response.status).toBe(200);
  });

  it("answers preflight requests with CORS headers", async () => {
    const { base } = await sentraServer();
    const response = await fetch(`${base}/api/1/envelope/`, { method: "OPTIONS" });
    expect(response.status).toBe(204);
    expect(Object.fromEntries(response.headers)).toMatchObject({
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "POST, OPTIONS",
      "access-control-allow-headers":
        "content-type, content-encoding, x-sentry-auth, sentry-trace, baggage",
      "access-control-max-age": "86400",
    });
  });

  it("answers unknown paths with 404", async () => {
    const { base } = await sentraServer();
    const response = await fetch(`${base}/nope`);
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: "not_found" } });
  });

  it("rejects an oversized chunked upload with 413 and closes the connection", async () => {
    const { base } = await sentraServer({ limits: { maxEnvelopeBytes: 1024 } });
    const chunk = Buffer.alloc(64 * 1024, 97);
    const response = await rawRequest(
      `${base}/p/s/web/api/1/envelope/`,
      { method: "POST" },
      (request) => {
        let sent = 0;
        function pump(): void {
          while (sent < 1024 * 1024) {
            sent += chunk.byteLength;
            if (!request.write(chunk)) {
              request.once("drain", pump);
              return;
            }
          }
          request.end();
        }
        request.on("response", () => {
          sent = Number.POSITIVE_INFINITY;
        });
        pump();
      },
    );
    expect(response.status).toBe(413);
    expect(response.headers.connection).toBe("close");
    expect(JSON.parse(response.chunks.join(""))).toMatchObject({
      error: { code: "payload_too_large" },
    });
  });

  it("keeps keep-alive connections usable after unread request bodies", async () => {
    const { base } = await sentraServer();
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    try {
      const notFound = await rawRequest(`${base}/nope`, { method: "POST", agent }, (request) => {
        request.end("x".repeat(10_000));
      });
      expect(notFound.status).toBe(404);
      const fixture = loadEnvelopeFixture("node-error");
      const ok = await rawRequest(
        `${base}/p/s/web/api/1/envelope/`,
        { method: "POST", agent },
        (request) => {
          request.end(fixture.body);
        },
      );
      expect(ok.status).toBe(200);
      const preflight = await rawRequest(`${base}/api/1/envelope/`, { method: "OPTIONS", agent });
      expect(preflight.status).toBe(204);
    } finally {
      agent.destroy();
    }
  });
});

describe("toNodeListener client aborts", () => {
  it("logs an aborted ingest upload at debug level, not as error", async () => {
    const errors: string[] = [];
    const debugs: string[] = [];
    const sentra = await createSentra({
      logger: {
        debug: (message: string) => debugs.push(message),
        info: () => undefined,
        warn: () => undefined,
        error: (message: string) => errors.push(message),
      },
    });
    instances.push(sentra);
    let resolveStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    const base = await listen(async (incoming) => {
      resolveStarted();
      return sentra.handle(incoming);
    });
    const request = http.request(`${base}/p/s/web/api/1/envelope/`, { method: "POST" });
    request.on("error", () => undefined);
    request.write("{}\n");
    await started;
    request.destroy();
    await vi.waitFor(() => {
      expect(debugs.some((message) => message.startsWith("client aborted request"))).toBe(true);
    });
    expect(errors).toEqual([]);
  });

  it("cancels an endless response stream when the client disconnects", async () => {
    let cancelled = false;
    const encoder = new TextEncoder();
    const base = await listen(async () =>
      Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(encoder.encode("data: hello\n\n"));
            },
            cancel() {
              cancelled = true;
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
      ),
    );
    await new Promise<void>((resolve, reject) => {
      const request = http.get(base, (response) => {
        response.once("data", () => {
          request.destroy();
          resolve();
        });
      });
      request.on("error", (error) => {
        if (!request.destroyed) {
          reject(error);
        }
      });
    });
    await vi.waitFor(() => {
      expect(cancelled).toBe(true);
    });
  });

  it("destroys the socket when the body fails after headers were sent", async () => {
    const encoder = new TextEncoder();
    const base = await listen(async () =>
      Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            async pull(controller) {
              controller.enqueue(encoder.encode("a"));
              await new Promise<void>((resolve) => {
                setImmediate(resolve);
              });
              controller.error(new Error("late boom"));
            },
          }),
        ),
      ),
    );
    const outcome = await new Promise<string>((resolve) => {
      http
        .get(base, (response) => {
          response.on("data", () => undefined);
          response.on("end", () => {
            resolve("end");
          });
          response.on("error", () => {
            resolve("error");
          });
          response.on("aborted", () => {
            resolve("aborted");
          });
        })
        .on("error", () => {
          resolve("error");
        });
    });
    expect(outcome).not.toBe("end");
  });
});

describe("toNodeListener with custom handlers", () => {
  it("streams response chunks as they arrive", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const encoder = new TextEncoder();
    const base = await listen(async () =>
      Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            async start(controller) {
              controller.enqueue(encoder.encode("a"));
              await gate;
              controller.enqueue(encoder.encode("b"));
              controller.close();
            },
          }),
        ),
      ),
    );
    const chunks: string[] = [];
    await new Promise<void>((resolve, reject) => {
      http
        .get(base, (response) => {
          response.setEncoding("utf8");
          response.on("data", (chunk: string) => {
            chunks.push(chunk);
            // The second chunk is only produced after the first one reached the client.
            release();
          });
          response.on("end", resolve);
        })
        .on("error", reject);
    });
    expect(chunks).toEqual(["a", "b"]);
  });

  it("forwards repeated request headers and all Set-Cookie headers", async () => {
    let seen: string | null = null;
    const base = await listen(async (request) => {
      seen = request.headers.get("x-multi");
      const headers = new Headers();
      headers.append("set-cookie", "a=1");
      headers.append("set-cookie", "b=2");
      return Promise.resolve(new Response(null, { status: 204, headers }));
    });
    const response = await rawRequest(base, { headers: { "x-multi": ["one", "two"] } });
    expect(response.status).toBe(204);
    expect(response.headers["set-cookie"]).toEqual(["a=1", "b=2"]);
    expect(seen).toBe("one, two");
  });

  it("builds the request URL from the Host header", async () => {
    let url = "";
    const base = await listen(async (request) => {
      ({ url } = request);
      return Promise.resolve(new Response("ok"));
    });
    await rawRequest(`${base}/path?x=1`, { headers: { host: "example.test:8969" } });
    expect(url).toBe("http://example.test:8969/path?x=1");
  });

  it("answers 500 internal_error when the handler throws", async () => {
    const base = await listen(async () => Promise.reject(new Error("handler boom")));
    const response = await fetch(base);
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: { code: "internal_error", message: "handler boom" },
    });
  });

  it("answers a clean 500 when the response body fails before anything was sent", async () => {
    const base = await listen(async () => {
      const headers = new Headers({ "content-encoding": "gzip", "x-custom": "1" });
      headers.append("set-cookie", "session=1");
      return Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.error(new Error("stream boom"));
            },
          }),
          { headers },
        ),
      );
    });
    const response = await rawRequest(base, {});
    expect(response.status).toBe(500);
    expect(response.headers["content-encoding"]).toBeUndefined();
    expect(response.headers["set-cookie"]).toBeUndefined();
    expect(response.headers["x-custom"]).toBeUndefined();
    expect(response.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(response.chunks.join(""))).toEqual({
      error: { code: "internal_error", message: "stream boom" },
    });
  });

  describe("custom onError", () => {
    function onError(res: http.ServerResponse, error: unknown): void {
      res.writeHead(500, {
        "content-type": "text/plain",
        "x-seen": String(error instanceof Error),
      });
      res.end("custom");
    }

    it("is used when the handler throws", async () => {
      const base = await listen(async () => Promise.reject(new Error("secret")), { onError });
      const response = await rawRequest(base, {});
      expect(response.status).toBe(500);
      expect(response.headers["access-control-allow-origin"]).toBeUndefined();
      expect(response.headers["x-seen"]).toBe("true");
      expect(response.chunks.join("")).toBe("custom");
    });

    it("is used when the body fails before the first chunk, with response headers cleared", async () => {
      const base = await listen(
        async () =>
          Promise.resolve(
            new Response(
              new ReadableStream<Uint8Array>({
                start(controller) {
                  controller.error(new Error("secret"));
                },
              }),
              { headers: { "access-control-allow-origin": "*", "x-custom": "1" } },
            ),
          ),
        { onError },
      );
      const response = await rawRequest(base, {});
      expect(response.status).toBe(500);
      expect(response.headers["access-control-allow-origin"]).toBeUndefined();
      expect(response.headers["x-custom"]).toBeUndefined();
      expect(response.chunks.join("")).toBe("custom");
    });

    it("is used when the request cannot be converted", async () => {
      const handle = vi.fn(async () => Promise.resolve(new Response("unreachable")));
      const base = await listen(handle, { onError });
      vi.stubGlobal("Request", (): never => {
        throw new TypeError("bad request");
      });
      const response = await rawRequest(base, {}).finally(() => {
        vi.unstubAllGlobals();
      });
      expect(response.status).toBe(500);
      expect(response.chunks.join("")).toBe("custom");
      expect(handle).not.toHaveBeenCalled();
    });
  });

  describe("backpressure", () => {
    const CHUNK = 64 * 1024;
    const CHUNKS = 256;
    let writeResults: boolean[] = [];

    beforeEach(() => {
      writeResults = [];
      const original = http.ServerResponse.prototype.write;
      vi.spyOn(http.ServerResponse.prototype, "write").mockImplementation(function write(
        this: http.ServerResponse,
        ...args: Parameters<typeof original>
      ) {
        const result = Reflect.apply(original, this, args);
        writeResults.push(result);
        return result;
      });
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    function bigBody(onCancel: () => void): Response {
      let sent = 0;
      return new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            if (sent === CHUNKS) {
              controller.close();
              return;
            }
            sent += 1;
            controller.enqueue(new Uint8Array(CHUNK).fill(97));
          },
          cancel: onCancel,
        }),
      );
    }

    it("waits for drain when the client reads slowly", async () => {
      const base = await listen(async () => Promise.resolve(bigBody(() => undefined)));
      const response = await new Promise<http.IncomingMessage>((resolve, reject) => {
        http
          .get(base, (incoming) => {
            incoming.pause();
            resolve(incoming);
          })
          .on("error", reject);
      });
      await vi.waitFor(() => {
        expect(writeResults).toContain(false);
      });
      let received = 0;
      response.on("data", (chunk: Buffer) => {
        received += chunk.byteLength;
      });
      await new Promise<void>((resolve, reject) => {
        response.on("end", resolve);
        response.on("error", reject);
        response.resume();
      });
      expect(received).toBe(CHUNK * CHUNKS);
    });

    it("stops writing when the client disconnects while waiting for drain", async () => {
      let cancelled = false;
      const base = await listen(async () =>
        Promise.resolve(
          bigBody(() => {
            cancelled = true;
          }),
        ),
      );
      const request = http.get(base, (response) => {
        response.pause();
      });
      request.on("error", () => undefined);
      await vi.waitFor(() => {
        expect(writeResults).toContain(false);
      });
      request.destroy();
      await vi.waitFor(() => {
        expect(cancelled).toBe(true);
      });
    });
  });

  it("aborts the request signal when the client disconnects", async () => {
    let resolveAborted: (value: boolean) => void = () => undefined;
    const aborted = new Promise<boolean>((resolve) => {
      resolveAborted = resolve;
    });
    let resolveStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    const base = await listen(async (request) => {
      request.signal.addEventListener("abort", () => {
        resolveAborted(request.signal.aborted);
      });
      resolveStarted();
      try {
        await request.arrayBuffer();
      } catch {
        // Expected: the upload was cut off.
      }
      return new Response("late");
    });
    const request = http.request(base, { method: "POST" });
    request.on("error", () => undefined);
    request.write("partial");
    await started;
    request.destroy();
    expect(await aborted).toBe(true);
  });
});
