import { createServer } from "node:http";
import type { Server } from "node:http";
import { PassThrough } from "node:stream";

import { createSentra, memoryStorage } from "@bosdev/sentra-core";
import type { Sentra } from "@bosdev/sentra-core";

import { createApiHandler } from "#src/api.js";
import { resolveStartConfig } from "#src/config.js";
import { startServer } from "#src/server.js";
import type { RunningServer } from "#src/server.js";

import { loadEnvelopeFixture } from "../../../test/fixtures/envelopes.js";

import { httpRequest, parseJson } from "./http.js";
import type { HttpResult } from "./http.js";

const SCOPE_PATH = "/my-app/3f9a1c/web/api/1/envelope/";

const running: RunningServer[] = [];
const servers: Server[] = [];
const instances: Sentra[] = [];

afterEach(async () => {
  await Promise.all(running.splice(0).map(async (server) => server.close()));
  await Promise.all(
    servers.splice(0).map(
      async (server) =>
        new Promise<void>((resolve) => {
          server.close(() => {
            resolve();
          });
        }),
    ),
  );
  await Promise.all(instances.splice(0).map(async (instance) => instance.close()));
});

async function boot(flags: Record<string, unknown> = {}): Promise<RunningServer> {
  const config = resolveStartConfig(
    { storage: "memory", port: 0, quiet: true, ...flags },
    {},
    process.cwd(),
  );
  const server = await startServer(config, {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  });
  running.push(server);
  return server;
}

async function post(server: RunningServer, name: string, path = SCOPE_PATH): Promise<HttpResult> {
  return httpRequest(server.port, {
    method: "POST",
    path,
    headers: { host: "localhost" },
    body: loadEnvelopeFixture(name).body,
  });
}

async function call(server: RunningServer, path: string, method = "GET"): Promise<HttpResult> {
  return httpRequest(server.port, { method, path, headers: { host: "localhost" } });
}

async function json(
  server: RunningServer,
  path: string,
  method = "GET",
): Promise<{ status: number; body: unknown }> {
  const result = await call(server, path, method);
  return { status: result.status, body: parseJson(result.body) };
}

async function statusOf(server: RunningServer, path: string, method = "GET"): Promise<number> {
  const result = await call(server, path, method);
  return result.status;
}

function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

describe("query API", () => {
  it("serves health", async () => {
    const server = await boot();
    const result = await call(server, "/api/sentra/health");
    expect(result.status).toBe(200);
    expect(result.headers["content-type"]).toBe("application/json; charset=utf-8");
    expect(result.headers["access-control-allow-origin"]).toBeUndefined();
    expect(result.headers["x-content-type-options"]).toBe("nosniff");
    expect(parseJson(result.body)).toEqual({
      ok: true,
      version: server.sentra.info().version,
      storage: { type: "memory", driver: null, path: null },
    });
  });

  it("lists scopes", async () => {
    const server = await boot();
    await post(server, "node-error");
    const { status, body } = await json(server, "/api/sentra/scopes?project=my-app");
    expect(status).toBe(200);
    const items = list(field(body, "items"));
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      project: "my-app",
      session: "3f9a1c",
      service: "web",
      issueCount: 1,
    });
    expect(field(items[0], "itemCount")).toBeGreaterThanOrEqual(1);
  });

  it("pages issues and validates filters", async () => {
    const server = await boot();
    await post(server, "node-error");
    await post(server, "node-message");
    const first = await json(server, "/api/sentra/issues?since=60m&limit=1");
    expect(first.status).toBe(200);
    expect(list(field(first.body, "items"))).toHaveLength(1);
    const cursor = field(first.body, "nextCursor");
    expect(typeof cursor).toBe("string");
    const second = await json(
      server,
      `/api/sentra/issues?since=60m&limit=1&cursor=${encodeURIComponent(String(cursor))}`,
    );
    expect(list(field(second.body, "items"))).toHaveLength(1);
    expect(field(list(field(second.body, "items"))[0], "id")).not.toBe(
      field(list(field(first.body, "items"))[0], "id"),
    );

    const badCursor = await json(server, "/api/sentra/issues?cursor=%25%25%25");
    expect(badCursor).toMatchObject({ status: 400, body: { error: { code: "invalid_cursor" } } });
    const badLevel = await json(server, "/api/sentra/issues?minLevel=loud");
    expect(badLevel).toMatchObject({
      status: 400,
      body: { error: { code: "invalid_filter", details: expect.anything() } },
    });
    expect(await json(server, "/api/sentra/issues?since=60m&from=1")).toMatchObject({
      status: 400,
      body: { error: { code: "invalid_filter" } },
    });
    expect(await json(server, "/api/sentra/issues?foo=1")).toMatchObject({
      status: 400,
      body: { error: { code: "invalid_filter", details: { unknown: ["foo"] } } },
    });
  });

  it("filters items by repeated and comma-separated kinds", async () => {
    const server = await boot();
    for (const name of ["node-error", "node-message", "node-logs", "node-transaction"]) {
      await post(server, name);
    }
    const { body } = await json(
      server,
      "/api/sentra/items?from=0&kind=error,message&kind=log&limit=100",
    );
    const kinds = list(field(body, "items")).map((item) => field(item, "kind"));
    expect(new Set(kinds)).toEqual(new Set(["error", "message", "log"]));
    expect(kinds).toHaveLength(4);
  });

  it("returns issue and item details", async () => {
    const server = await boot();
    await post(server, "node-error");
    const issues = await json(server, "/api/sentra/issues?since=60m");
    const issueId = String(field(list(field(issues.body, "items"))[0], "id"));
    const detail = await json(server, `/api/sentra/issues/${issueId}`);
    expect(detail.status).toBe(200);
    expect(field(field(detail.body, "latest"), "kind")).toBe("error");
    expect(await json(server, "/api/sentra/issues/ffffffffffffffff")).toMatchObject({
      status: 404,
      body: { error: { code: "not_found" } },
    });

    const items = await json(server, "/api/sentra/items?from=0");
    const [item] = list(field(items.body, "items"));
    const byId = await json(server, `/api/sentra/items/${String(field(item, "id"))}`);
    const byEventId = await json(server, `/api/sentra/items/${String(field(item, "eventId"))}/`);
    expect(byId.status).toBe(200);
    expect(byEventId).toEqual(byId);
    expect(await json(server, "/api/sentra/items/nope")).toMatchObject({
      status: 404,
      body: { error: { code: "not_found" } },
    });
    expect(await json(server, "/api/sentra/items/%E0%A4%A")).toMatchObject({
      status: 404,
      body: { error: { code: "not_found" } },
    });
  });

  it("returns raw envelopes", async () => {
    const server = await boot();
    await post(server, "node-error");
    const items = await json(server, "/api/sentra/items?from=0");
    const id = String(field(list(field(items.body, "items"))[0], "id"));
    const raw = await call(server, `/api/sentra/items/${id}/envelope`);
    expect(raw.status).toBe(200);
    expect(raw.headers["content-type"]).toBe("application/x-sentry-envelope");
    expect(raw.headers["content-security-policy"]).toBe("sandbox");
    expect(raw.headers["x-content-type-options"]).toBe("nosniff");
    expect(raw.headers["content-disposition"]).toMatch(/^attachment; filename="[\w-]+\.envelope"$/);
    expect(raw.headers["content-length"]).toBe(String(raw.bytes.byteLength));
    expect(new Uint8Array(raw.bytes)).toEqual(loadEnvelopeFixture("node-error").body);
    expect(await statusOf(server, "/api/sentra/items/nope/envelope")).toBe(404);

    const noRaw = await boot({ noRaw: true });
    await post(noRaw, "node-error");
    const noRawItems = await json(noRaw, "/api/sentra/items?from=0");
    const noRawId = String(field(list(field(noRawItems.body, "items"))[0], "id"));
    expect(await json(noRaw, `/api/sentra/items/${noRawId}/envelope`)).toMatchObject({
      status: 404,
      body: { error: { code: "raw_not_stored" } },
    });
  });

  it("serves attachments", async () => {
    const server = await boot();
    await post(server, "node-attachment");
    const attachments = await json(server, "/api/sentra/items?from=0&kind=attachment");
    const attachmentId = String(field(list(field(attachments.body, "items"))[0], "id"));
    const blob = await server.sentra.query.getBlob(attachmentId);
    if (blob === null) {
      throw new Error("blob missing");
    }
    const result = await call(server, `/api/sentra/attachments/${attachmentId}`);
    expect(result.status).toBe(200);
    expect(new Uint8Array(result.bytes)).toEqual(blob.data);
    expect(result.headers["content-type"]).toBe(blob.contentType ?? "application/octet-stream");
    expect(result.headers["content-disposition"]).toBe(`attachment; filename="${blob.filename}"`);
    expect(result.headers["x-content-type-options"]).toBe("nosniff");

    const errors = await json(server, "/api/sentra/items?from=0&kind=error");
    const errorId = String(field(list(field(errors.body, "items"))[0], "id"));
    expect(await json(server, `/api/sentra/attachments/${errorId}`)).toMatchObject({
      status: 404,
      body: { error: { code: "not_found" } },
    });
    expect(await statusOf(server, "/api/sentra/attachments/nope")).toBe(404);

    const tiny = await boot({ maxAttachment: "1b" });
    await post(tiny, "node-attachment");
    const tinyAttachments = await json(tiny, "/api/sentra/items?from=0&kind=attachment");
    const tinyId = String(field(list(field(tinyAttachments.body, "items"))[0], "id"));
    expect(await json(tiny, `/api/sentra/attachments/${tinyId}`)).toMatchObject({
      status: 404,
      body: { error: { code: "blob_not_stored" } },
    });
  });

  it("sanitizes attachment headers", async () => {
    const server = await boot();
    const items = [
      { filename: 'bad"name\\é\r\n.txt', content_type: "text/html" },
      { filename: "x.bin", content_type: "text/html\r\nx-evil: 1" },
    ];
    const body = [
      "{}",
      ...items.flatMap((header) => [
        JSON.stringify({ type: "attachment", length: 3, ...header }),
        "abc",
      ]),
    ].join("\n");
    const posted = await httpRequest(server.port, {
      method: "POST",
      path: SCOPE_PATH,
      headers: { host: "localhost" },
      body,
    });
    expect(posted.status).toBe(200);
    const page = await json(server, "/api/sentra/items?from=0&kind=attachment");
    const results = await Promise.all(
      list(field(page.body, "items")).map(async (item) =>
        call(server, `/api/sentra/attachments/${String(field(item, "id"))}`),
      ),
    );
    const byName = new Map(
      results.map((result) => [result.headers["content-disposition"], result]),
    );
    const html = byName.get('attachment; filename="bad_name____.txt"');
    expect(html?.headers["content-type"]).toBe("text/html");
    expect(html?.headers["content-security-policy"]).toBe("sandbox");
    const evil = byName.get('attachment; filename="x.bin"');
    expect(evil?.headers["content-type"]).toBe("application/octet-stream");
    expect(evil?.headers["x-evil"]).toBeUndefined();
  });

  it("lists failed envelopes without bodies", async () => {
    const server = await boot();
    await httpRequest(server.port, {
      method: "POST",
      path: SCOPE_PATH,
      headers: { host: "localhost" },
      body: "not a header\n",
    });
    const { status, body } = await json(server, "/api/sentra/envelopes/failed?project=my-app");
    expect(status).toBe(200);
    const items = list(field(body, "items"));
    expect(items).toHaveLength(1);
    expect(items[0]).not.toHaveProperty("body");
    expect(items[0]).toMatchObject({ scope: { project: "my-app" } });
  });

  it("deletes items only with a filter", async () => {
    const server = await boot();
    await post(server, "node-error");
    await post(server, "node-logs");
    expect(await json(server, "/api/sentra/items", "DELETE")).toMatchObject({
      status: 400,
      body: { error: { code: "filter_required" } },
    });
    for (const query of [
      "project=",
      "q=",
      "q=%20",
      "issueId=",
      "traceId=",
      "eventId=-",
      "eventId=--",
      "since=",
      "kind=,",
    ]) {
      expect(await json(server, `/api/sentra/items?${query}`, "DELETE")).toMatchObject({
        status: 400,
        body: { error: { code: "filter_required" } },
      });
    }
    expect(await json(server, "/api/sentra/items?limit=5", "DELETE")).toMatchObject({
      status: 400,
      body: { error: { code: "invalid_filter" } },
    });
    const before = await json(server, "/api/sentra/items?from=0&project=my-app");
    expect(list(field(before.body, "items"))).toHaveLength(3);
    const deleted = await json(server, "/api/sentra/items?project=my-app", "DELETE");
    expect(deleted.status).toBe(200);
    expect(field(deleted.body, "itemsDeleted")).toBeGreaterThanOrEqual(1);
    const after = await json(server, "/api/sentra/items?from=0&project=my-app");
    expect(list(field(after.body, "items"))).toEqual([]);
  });

  it("answers unknown paths and methods", async () => {
    const server = await boot();
    const post405 = await call(server, "/api/sentra/issues", "POST");
    expect(post405.status).toBe(405);
    expect(post405.headers.allow).toBe("GET");
    expect(parseJson(post405.body)).toMatchObject({ error: { code: "method_not_allowed" } });
    const put = await call(server, "/api/sentra/items", "PUT");
    expect(put.headers.allow).toBe("GET, DELETE");
    expect(await statusOf(server, "/api/sentra/health", "HEAD")).toBe(405);
    expect(await statusOf(server, "/api/sentra/health", "OPTIONS")).toBe(405);
    for (const path of [
      "/api/sentra/nope",
      "/api/sentra",
      "/api/sentra/items/a/b",
      "/api/sentra/items//envelope",
    ]) {
      expect(await json(server, path)).toMatchObject({
        status: 404,
        body: { error: { code: "not_found" } },
      });
    }
  });

  it("matches on the normalized pathname", async () => {
    const server = await boot();
    await post(server, "node-error");
    const dotted = await json(server, "/api/sentra/./issues?since=60m");
    expect(dotted.status).toBe(200);
    expect(list(field(dotted.body, "items"))).toHaveLength(1);
    const parent = await json(server, "/api/sentra/x/../issues?since=60m");
    expect(parent.status).toBe(200);
    const doubleSlash = await json(server, "//api/sentra/issues");
    expect(doubleSlash).toMatchObject({ status: 404, body: { error: { code: "not_found" } } });
    expect(doubleSlash.body).not.toHaveProperty("items");
  });
});

describe("query API errors", () => {
  it("hides internal error messages", async () => {
    const sentra = await createSentra({ storage: memoryStorage() });
    instances.push(sentra);
    const errors: string[] = [];
    const handler = createApiHandler({
      sentra: {
        ...sentra,
        query: {
          ...sentra.query,
          listIssues: async () => {
            throw new Error("boom");
          },
        },
      },
      logger: {
        debug: () => undefined,
        info: () => undefined,
        warn: () => undefined,
        error: (message) => errors.push(message),
      },
    });
    const server = createServer((req, res) => {
      void handler(req, res);
    });
    servers.push(server);
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    const port = address !== null && typeof address === "object" ? address.port : 0;
    const result = await httpRequest(port, {
      path: "/api/sentra/issues",
      headers: { host: "localhost" },
    });
    expect(result.status).toBe(500);
    expect(parseJson(result.body)).toEqual({
      error: { code: "internal_error", message: "Internal error" },
    });
    expect(result.body).not.toContain("boom");
    expect(errors).toEqual([expect.stringContaining("boom")]);
  });
});
