import { gzipSync } from "node:zlib";

import { createIngestHandler } from "#src/ingest/handler.js";
import type { IngestContext, IngestHandlerOptions } from "#src/ingest/handler.js";
import type { SentraLogger } from "#src/types.js";

const BASE = "http://localhost:8969";
const SCOPED = `${BASE}/my-app/3f9a1c/web/api/1/envelope/?sentry_version=7&sentry_key=sentra`;
const NOW = new Date("2026-10-03T10:00:00.000Z");
const ENVELOPE = '{"event_id":"a"}\n{"type":"event"}\n{"x":1}\n{"type":"event"}\n{"y":2}\n';
const encoder = new TextEncoder();

interface RecordingSink {
  onEnvelope: IngestHandlerOptions["onEnvelope"];
  calls: IngestContext[];
}

function recordingSink(): RecordingSink {
  const calls: IngestContext[] = [];
  return {
    calls,
    onEnvelope: async (ctx) => {
      calls.push(ctx);
      return { id: "test-id" };
    },
  };
}

type LogFn = SentraLogger["warn"];

function mockLogger() {
  return {
    debug: vi.fn<LogFn>(),
    info: vi.fn<LogFn>(),
    warn: vi.fn<LogFn>(),
    error: vi.fn<LogFn>(),
  };
}

function setup(
  options: Partial<IngestHandlerOptions> = {},
): RecordingSink & { handle: (request: Request) => Promise<Response> } {
  const sink = recordingSink();
  const handle = createIngestHandler({
    limits: { maxEnvelopeBytes: 1024 * 1024 },
    onEnvelope: sink.onEnvelope,
    now: () => NOW,
    ...options,
  });
  return { ...sink, handle };
}

function post(url: string, body: BodyInit | null, headers: Record<string, string> = {}): Request {
  return new Request(url, { method: "POST", body, headers });
}

function streamedPost(url: string, chunks: Uint8Array[]): Request {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });
  // `duplex` is required by Node for stream bodies but missing from the DOM RequestInit type.
  const init = { method: "POST", body, duplex: "half" };
  return new Request(url, init);
}

function only(calls: IngestContext[]): IngestContext {
  expect(calls).toHaveLength(1);
  const [call] = calls;
  if (call === undefined) {
    throw new Error("sink not called");
  }
  return call;
}

function envelopeWithDsn(dsn: unknown): string {
  return `${JSON.stringify({ event_id: "a", dsn })}\n{"type":"event"}\n{"x":1}\n`;
}

const responses: Response[] = [];

async function send(
  handle: (request: Request) => Promise<Response>,
  request: Request,
): Promise<Response> {
  const response = await handle(request);
  responses.push(response);
  return response;
}

async function expectError(response: Response, status: number, code: string): Promise<void> {
  expect(response.status).toBe(status);
  expect(response.headers.get("content-type")).toBe("application/json");
  const body: unknown = await response.json();
  expect(body).toEqual({ error: { code, message: expect.any(String) } });
  const message =
    typeof body === "object" &&
    body !== null &&
    "error" in body &&
    typeof body.error === "object" &&
    body.error !== null &&
    "message" in body.error
      ? String(body.error.message)
      : "";
  expect(response.headers.get("x-sentry-error")).toBe(message.slice(0, 200));
}

afterAll(() => {
  for (const response of responses) {
    expect(response.status).not.toBe(429);
    expect(response.headers.has("x-sentry-rate-limits")).toBe(false);
    expect(response.headers.has("retry-after")).toBe(false);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.get("access-control-expose-headers")).toBe(
      "x-sentry-error, x-sentry-rate-limits, retry-after",
    );
  }
});

describe("createIngestHandler", () => {
  it("answers a preflight without calling the sink", async () => {
    const { handle, calls } = setup();
    const response = await send(
      handle,
      new Request(`${BASE}/my-app/api/1/envelope/`, { method: "OPTIONS" }),
    );
    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
    expect(response.headers.get("access-control-allow-methods")).toBe("POST, OPTIONS");
    expect(response.headers.get("access-control-allow-headers")).toBe(
      "content-type, content-encoding, x-sentry-auth, sentry-trace, baggage",
    );
    expect(response.headers.get("access-control-max-age")).toBe("86400");
    expect(calls).toHaveLength(0);
  });

  const zeros = gzipSync(new Uint8Array(1024 * 1024));
  const errorCases: {
    name: string;
    request: () => Request;
    limit?: number;
    status: number;
    code: string;
    sinkCalled: boolean;
  }[] = [
    {
      name: "POST /foo",
      request: () => post(`${BASE}/foo`, ENVELOPE),
      status: 404,
      code: "not_found",
      sinkCalled: false,
    },
    {
      name: "GET /api/1/envelope/",
      request: () => new Request(`${BASE}/api/1/envelope/`),
      status: 405,
      code: "method_not_allowed",
      sinkCalled: false,
    },
    {
      name: "4 scope segments",
      request: () => post(`${BASE}/a/b/c/d/api/1/envelope/`, ENVELOPE),
      status: 400,
      code: "invalid_scope",
      sinkCalled: false,
    },
    {
      name: "percent-encoded segment",
      request: () => post(`${BASE}/my%20app/api/1/envelope/`, ENVELOPE),
      status: 400,
      code: "invalid_scope",
      sinkCalled: false,
    },
    {
      name: "empty body",
      request: () => post(SCOPED, ""),
      status: 400,
      code: "empty_body",
      sinkCalled: false,
    },
    {
      name: "invalid envelope header",
      request: () => post(SCOPED, "not json\n{}"),
      status: 400,
      code: "invalid_envelope",
      sinkCalled: true,
    },
    {
      name: "Content-Length above the limit",
      request: () => post(SCOPED, ENVELOPE, { "content-length": "999999999" }),
      limit: 1024,
      status: 413,
      code: "payload_too_large",
      sinkCalled: false,
    },
    {
      name: "streamed body above the limit",
      request: () => streamedPost(SCOPED, [new Uint8Array(1024), new Uint8Array(1024)]),
      limit: 1024,
      status: 413,
      code: "payload_too_large",
      sinkCalled: false,
    },
    {
      name: "gzip bomb",
      request: () => post(SCOPED, zeros, { "content-encoding": "gzip" }),
      limit: 64 * 1024,
      status: 413,
      code: "payload_too_large",
      sinkCalled: false,
    },
    {
      name: "Content-Encoding compress",
      request: () => post(SCOPED, ENVELOPE, { "content-encoding": "compress" }),
      status: 415,
      code: "unsupported_encoding",
      sinkCalled: false,
    },
    {
      name: "gzip header with plain bytes",
      request: () => post(SCOPED, ENVELOPE, { "content-encoding": "gzip" }),
      status: 415,
      code: "unsupported_encoding",
      sinkCalled: false,
    },
  ];

  it.each(errorCases)(
    "$name → $status $code",
    async ({ request, limit, status, code, sinkCalled }) => {
      const { handle, calls } = setup(
        limit === undefined ? {} : { limits: { maxEnvelopeBytes: limit } },
      );
      await expectError(await send(handle, request()), status, code);
      expect(calls.length > 0).toBe(sinkCalled);
    },
  );

  it("sets Allow on 405", async () => {
    const { handle } = setup();
    const response = await send(
      handle,
      new Request(`${BASE}/api/1/envelope/`, { method: "PUT", body: "x" }),
    );
    expect(response.headers.get("allow")).toBe("POST, OPTIONS");
  });

  it("passes the failed envelope to the sink with parseError", async () => {
    const { handle, calls } = setup();
    await send(handle, post(SCOPED, "not json\n{}"));
    const call = only(calls);
    expect(call.parsed).toBeNull();
    expect(call.parseError).toEqual(expect.any(String));
    expect(call.raw).toEqual(encoder.encode("not json\n{}"));
  });

  it("returns 500 storage_error when the sink rejects", async () => {
    const logger = mockLogger();
    const sink = recordingSink();
    const handle = createIngestHandler({
      limits: { maxEnvelopeBytes: 1024 },
      logger,
      onEnvelope: async (ctx) => {
        await sink.onEnvelope(ctx);
        throw new Error("disk full");
      },
    });
    await expectError(await send(handle, post(SCOPED, ENVELOPE)), 500, "storage_error");
    expect(sink.calls).toHaveLength(1);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("disk full"),
      expect.anything(),
    );
  });

  it.each([
    ["valid", () => ENVELOPE],
    ["invalid", () => "not json\n{}"],
  ])("catches a synchronous sink throw for a %s envelope", async (_name, body) => {
    const logger = mockLogger();
    const handle = createIngestHandler({
      limits: { maxEnvelopeBytes: 1024 },
      logger,
      onEnvelope: () => {
        throw new Error("sync boom");
      },
    });
    await expectError(await send(handle, post(SCOPED, body())), 500, "storage_error");
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("sync boom"),
      expect.anything(),
    );
  });

  it("works without a logger", async () => {
    const handle = createIngestHandler({
      limits: { maxEnvelopeBytes: 1024 },
      onEnvelope: () => {
        throw new Error("no logger");
      },
    });
    await expectError(
      await send(handle, post(`${BASE}/api/1/envelope/`, envelopeWithDsn("not a url"))),
      500,
      "storage_error",
    );
  });

  it("maps unexpected errors to 500 internal_error", async () => {
    const logger = mockLogger();
    const handle = createIngestHandler({
      limits: { maxEnvelopeBytes: 1024 },
      logger,
      onEnvelope: async () => ({ id: "x" }),
      now: () => {
        throw new Error("clock broke");
      },
    });
    await expectError(await send(handle, post(SCOPED, ENVELOPE)), 500, "internal_error");
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("clock broke"),
      expect.anything(),
    );
  });

  it("accepts a valid envelope and forwards it to the sink", async () => {
    const { handle, calls } = setup();
    const response = await send(handle, post(SCOPED, ENVELOPE));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(await response.json()).toEqual({ id: "test-id" });
    const call = only(calls);
    expect(call.scope).toEqual({ project: "my-app", session: "3f9a1c", service: "web" });
    expect(call.receivedAt).toBe(NOW);
    expect(call.contentEncoding).toBeNull();
    expect(call.raw).toEqual(encoder.encode(ENVELOPE));
    expect(call.parseError).toBeNull();
    expect(call.parsed?.items).toHaveLength(2);
  });

  it.each([undefined, "text/plain;charset=UTF-8", "application/x-sentry-envelope"])(
    "accepts Content-Type %s",
    async (contentType) => {
      const { handle, calls } = setup();
      const headers: Record<string, string> =
        contentType === undefined ? {} : { "content-type": contentType };
      const response = await send(handle, post(SCOPED, encoder.encode(ENVELOPE), headers));
      expect(response.status).toBe(200);
      expect(calls).toHaveLength(1);
    },
  );

  it("decompresses a gzip request", async () => {
    const { handle, calls } = setup();
    const response = await send(
      handle,
      post(SCOPED, gzipSync(ENVELOPE), { "content-encoding": "gzip" }),
    );
    expect(response.status).toBe(200);
    const call = only(calls);
    expect(call.contentEncoding).toBe("gzip");
    expect(new Uint8Array(call.raw)).toEqual(encoder.encode(ENVELOPE));
  });

  it("rejects a gzip body that decompresses to nothing", async () => {
    const { handle, calls } = setup();
    await expectError(
      await send(handle, post(SCOPED, gzipSync(""), { "content-encoding": "gzip" })),
      400,
      "empty_body",
    );
    expect(calls).toHaveLength(0);
  });

  it("ignores a non-numeric Content-Length", async () => {
    const { handle } = setup({ limits: { maxEnvelopeBytes: 1024 } });
    const response = await send(handle, post(SCOPED, ENVELOPE, { "content-length": "abc" }));
    expect(response.status).toBe(200);
  });

  describe("envelope header dsn fallback", () => {
    it("uses the header dsn for an unscoped URL", async () => {
      const { handle, calls } = setup();
      await send(
        handle,
        post(
          `${BASE}/api/1/envelope/`,
          envelopeWithDsn("http://sentra@example.invalid:9000/my-app/web/1"),
        ),
      );
      expect(only(calls).scope).toEqual({ project: "my-app", session: "web", service: "default" });
    });

    it("ignores the header dsn for a scoped URL", async () => {
      const { handle, calls } = setup();
      await send(
        handle,
        post(
          `${BASE}/other/api/1/envelope/`,
          envelopeWithDsn("http://sentra@example.invalid:9000/my-app/web/1"),
        ),
      );
      expect(only(calls).scope).toEqual({
        project: "other",
        session: "default",
        service: "default",
      });
    });

    it.each(["not a url", "http://sentra@example.invalid:9000/a/b/c/d/1"])(
      "keeps the default scope for invalid dsn %j",
      async (dsn) => {
        const logger = mockLogger();
        const { handle, calls } = setup({ logger });
        const response = await send(handle, post(`${BASE}/api/1/envelope/`, envelopeWithDsn(dsn)));
        expect(response.status).toBe(200);
        expect(only(calls).scope).toEqual({
          project: "default",
          session: "default",
          service: "default",
        });
        expect(logger.warn).toHaveBeenCalledTimes(1);
      },
    );

    it("ignores a non-string header dsn", async () => {
      const { handle, calls } = setup();
      await send(handle, post(`${BASE}/api/1/envelope/`, envelopeWithDsn(42)));
      expect(only(calls).scope).toEqual({
        project: "default",
        session: "default",
        service: "default",
      });
    });
  });

  it.each([
    ['{"event_id":"a"}\n{"type":"attachment","length":100}\nabc\n'],
    ['{"event_id":"a"}\n{"type":"event"}\n{"x":1}\nnot json\n'],
  ])("returns 200 for per-item problems: %j", async (body) => {
    const { handle, calls } = setup();
    const response = await send(handle, post(SCOPED, body));
    expect(response.status).toBe(200);
    expect(only(calls).parsed?.warnings.length).toBeGreaterThan(0);
  });
});
