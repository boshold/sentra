import { ServerResponse, createServer } from "node:http";
import { PassThrough } from "node:stream";

import type { LiveEvent } from "@boshold/sentra-core";

import { resolveStartConfig } from "#src/config.js";
import { startServer } from "#src/server.js";
import type { RunningServer, ServerHooks } from "#src/server.js";
import { createStreamHandler, formatSseEvent } from "#src/sse.js";

import { loadEnvelopeFixture } from "../../../test/fixtures/envelopes.js";

import { httpRequest, parseJson } from "./http.js";

const running: RunningServer[] = [];
const aborts: AbortController[] = [];

afterEach(async () => {
  for (const controller of aborts.splice(0)) {
    controller.abort();
  }
  await Promise.all(running.splice(0).map(async (server) => server.close()));
});

async function boot(
  flags: Record<string, unknown> = {},
  hooks: ServerHooks = {},
): Promise<RunningServer> {
  const config = resolveStartConfig(
    { storage: "memory", port: 0, quiet: true, ...flags },
    {},
    process.cwd(),
  );
  const server = await startServer(
    config,
    { stdout: new PassThrough(), stderr: new PassThrough() },
    hooks,
  );
  running.push(server);
  return server;
}

async function post(server: RunningServer, name: string, service = "web"): Promise<void> {
  const result = await httpRequest(server.port, {
    method: "POST",
    path: `/my-app/3f9a1c/${service}/api/1/envelope/`,
    body: loadEnvelopeFixture(name).body,
  });
  expect(result.status).toBe(200);
}

interface OpenStream {
  response: Response;
  /** Everything received so far. */
  text(): string;
  /** Reads until `predicate(text)` holds. */
  until(predicate: (text: string) => boolean): Promise<string>;
  abort(): void;
}

async function openStream(server: RunningServer, query = ""): Promise<OpenStream> {
  const controller = new AbortController();
  aborts.push(controller);
  const response = await fetch(`http://127.0.0.1:${server.port}/api/sentra/stream${query}`, {
    signal: controller.signal,
  });
  const { body } = response;
  if (body === null) {
    throw new Error("no body");
  }
  const reader = body.pipeThrough(new TextDecoderStream()).getReader();
  let received = "";
  return {
    response,
    text: () => received,
    async until(predicate) {
      while (!predicate(received)) {
        const chunk = await reader.read();
        if (chunk.done) {
          throw new Error(`stream ended before condition; got ${received}`);
        }
        received += chunk.value;
      }
      return received;
    },
    abort: () => {
      controller.abort();
    },
  };
}

function events(text: string): LiveEvent[] {
  return text
    .split("\n\n")
    .filter((block) => block.startsWith("event: "))
    .map((block) => {
      const data = block.split("\n").find((line) => line.startsWith("data: "));
      const parsed: LiveEvent = JSON.parse(data?.slice("data: ".length) ?? "null");
      return parsed;
    });
}

function hasEvents(count: number): (text: string) => boolean {
  return (text) => events(text).length >= count;
}

const FAILED_ENVELOPE = {
  id: "e1",
  scope: { project: "p", session: "s", service: "x" },
  receivedAt: "2026-10-03T00:00:00.000Z",
  header: {},
  size: 1,
  contentEncoding: null,
  itemCount: 0,
  parseError: "line1\nline2",
  parseWarnings: [],
};

describe("formatSseEvent", () => {
  it("writes one data line", () => {
    const event: LiveEvent = {
      type: "envelope.failed",
      envelope: FAILED_ENVELOPE,
      error: "line1\nline2",
    };
    const text = formatSseEvent(event);
    expect(text).toBe(`event: envelope.failed\ndata: ${JSON.stringify(event)}\n\n`);
    expect(text.split("\n").filter((line) => line.startsWith("data:"))).toHaveLength(1);
  });
});

describe("GET /api/sentra/stream", () => {
  it("opens with a connected comment and streams created items", async () => {
    const server = await boot();
    const stream = await openStream(server);
    expect(stream.response.status).toBe(200);
    expect(stream.response.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
    expect(stream.response.headers.get("cache-control")).toContain("no-cache");
    expect(stream.response.headers.get("x-accel-buffering")).toBe("no");
    expect(stream.response.headers.get("access-control-allow-origin")).toBeNull();
    expect(await stream.until((text) => text.length > 0)).toBe(": connected\n\n");

    await post(server, "node-error");
    const [event] = events(await stream.until(hasEvents(1)));
    expect(event?.type).toBe("item.created");
    if (event?.type !== "item.created") {
      throw new Error("unexpected event");
    }
    expect(event.item.kind).toBe("error");
    expect(event.issue).toEqual(expect.objectContaining({ id: expect.any(String) }));
  });

  it("streams failed envelopes", async () => {
    const server = await boot();
    const stream = await openStream(server);
    await stream.until((text) => text.includes(": connected"));
    await httpRequest(server.port, {
      method: "POST",
      path: "/my-app/3f9a1c/web/api/1/envelope/",
      body: "nope\n",
    });
    const [event] = events(await stream.until(hasEvents(1)));
    expect(event?.type).toBe("envelope.failed");
  });

  it("filters by service", async () => {
    const server = await boot();
    const stream = await openStream(server, "?service=web");
    await stream.until((text) => text.includes(": connected"));
    await post(server, "node-message", "api");
    await post(server, "node-error", "web");
    const [first, ...rest] = events(await stream.until(hasEvents(1)));
    expect(rest).toEqual([]);
    expect(first?.type === "item.created" ? first.item.scope.service : null).toBe("web");
  });

  it("sends heartbeats", async () => {
    const server = await boot({}, { heartbeatMs: 50 });
    const stream = await openStream(server);
    const started = Date.now();
    await stream.until((text) => text.split(": ping\n\n").length > 2);
    expect(Date.now() - started).toBeLessThan(500);
  });

  it("unsubscribes when the client disconnects", async () => {
    const server = await boot();
    const unsubscribed = vi.fn();
    const original = server.sentra.subscribe.bind(server.sentra);
    vi.spyOn(server.sentra, "subscribe").mockImplementation((filter, listener) => {
      const stop = original(filter, listener);
      return () => {
        unsubscribed();
        stop();
      };
    });
    const stream = await openStream(server);
    await stream.until((text) => text.includes(": connected"));
    stream.abort();
    await vi.waitFor(() => {
      expect(unsubscribed).toHaveBeenCalledOnce();
    });
  });

  it("rejects bad filters and methods with JSON", async () => {
    const server = await boot();
    for (const query of ["since=60m", "from=1", "limit=1", "cursor=x", "foo=1", "minLevel=loud"]) {
      const result = await httpRequest(server.port, { path: `/api/sentra/stream?${query}` });
      expect(result.status).toBe(400);
      expect(result.headers["content-type"]).toBe("application/json; charset=utf-8");
      expect(parseJson(result.body)).toMatchObject({ error: { code: "invalid_filter" } });
    }
    const posted = await httpRequest(server.port, { method: "POST", path: "/api/sentra/stream" });
    expect(posted.status).toBe(405);
    expect(posted.headers.allow).toBe("GET");
  });

  it("closes the server promptly with an open stream", async () => {
    const server = await boot();
    const stream = await openStream(server);
    await stream.until((text) => text.includes(": connected"));
    const started = Date.now();
    await server.close();
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it("is disabled with api: false", async () => {
    const server = await boot({ noApi: true });
    const result = await httpRequest(server.port, { path: "/api/sentra/stream" });
    expect(result.status).toBe(404);
    expect(parseJson(result.body)).toMatchObject({ error: { code: "not_found" } });
  });

  it("matches on the normalized pathname", async () => {
    const server = await boot();
    const stream = await openStream(server, "/../stream");
    expect(stream.response.status).toBe(200);
  });
});

describe("createStreamHandler", () => {
  it("tracks connections and refuses new ones after closeAll", async () => {
    const server = await boot();
    const handler = createStreamHandler({ sentra: server.sentra });
    const http = createServer((req, res) => {
      void handler.listener(req, res);
    });
    await new Promise<void>((resolve) => {
      http.listen(0, "127.0.0.1", resolve);
    });
    const address = http.address();
    const port = address !== null && typeof address === "object" ? address.port : 0;
    const controller = new AbortController();
    aborts.push(controller);
    const response = await fetch(`http://127.0.0.1:${port}/`, { signal: controller.signal });
    expect(response.status).toBe(200);
    expect(handler.connections).toBe(1);
    controller.abort();
    await vi.waitFor(() => {
      expect(handler.connections).toBe(0);
    });
    handler.closeAll();
    const refused = await httpRequest(port, { path: "/" });
    expect(refused.status).toBe(503);
    await new Promise<void>((resolve) => {
      http.close(() => {
        resolve();
      });
    });
  });

  it("drops a client whose buffer exceeds 8 MiB", async () => {
    const server = await boot();
    const listeners: ((event: LiveEvent) => void)[] = [];
    const unsubscribed = vi.fn();
    const handler = createStreamHandler({
      sentra: {
        ...server.sentra,
        subscribe: (_filter, listener) => {
          listeners.push(listener);
          return unsubscribed;
        },
      },
    });
    const destroyed = vi.fn();
    const http = createServer((req, res) => {
      res.on("close", destroyed);
      void handler.listener(req, res);
    });
    await new Promise<void>((resolve) => {
      http.listen(0, "127.0.0.1", resolve);
    });
    const address = http.address();
    const port = address !== null && typeof address === "object" ? address.port : 0;
    const controller = new AbortController();
    aborts.push(controller);
    await fetch(`http://127.0.0.1:${port}/`, { signal: controller.signal });
    expect(handler.connections).toBe(1);
    const write = vi.spyOn(ServerResponse.prototype, "write");
    vi.spyOn(ServerResponse.prototype, "writableLength", "get").mockReturnValue(
      8 * 1024 * 1024 + 1,
    );
    const destroy = vi.spyOn(ServerResponse.prototype, "destroy");
    for (const listener of listeners) {
      listener({ type: "envelope.failed", envelope: FAILED_ENVELOPE, error: "x" });
    }
    expect(destroy).toHaveBeenCalledOnce();
    expect(write).not.toHaveBeenCalled();
    vi.restoreAllMocks();
    await vi.waitFor(() => {
      expect(handler.connections).toBe(0);
    });
    expect(unsubscribed).toHaveBeenCalledOnce();
    expect(destroyed).toHaveBeenCalledOnce();
    await new Promise<void>((resolve) => {
      http.close(() => {
        resolve();
      });
    });
  });
});
