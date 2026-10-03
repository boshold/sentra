import { gunzipSync } from "node:zlib";

import { SentraConfigError, SentraValidationError } from "#src/errors.js";
import { createSentra } from "#src/index.js";
import type { Sentra } from "#src/index.js";
import type { ItemKind, LiveEvent, SentraLogger } from "#src/types.js";

import {
  fixtureToRequest,
  loadEnvelopeFixture,
  loadEnvelopeFixtures,
} from "../../../test/fixtures/envelopes.js";
import type { EnvelopeFixture } from "../../../test/fixtures/envelopes.js";

import { storageWith } from "./helpers/storage.js";

const EXPECTED_KINDS: Record<string, ItemKind[]> = {
  "browser-attachment": ["message", "attachment"],
  "browser-error": ["error"],
  "browser-logs-spans-1": ["log"],
  "browser-logs-spans-2": ["span"],
  "node-attachment": ["error", "attachment"],
  "node-client-report-1": ["error"],
  "node-client-report-2": ["other"],
  "node-empty-attachment": ["error", "attachment"],
  "node-error": ["error"],
  "node-gzip": ["error"],
  "node-library-frame": ["error"],
  "node-logs": ["log", "log"],
  "node-message": ["message"],
  "node-session-1": ["other"],
  "node-session-2": ["other"],
  "node-spans": ["span", "span"],
  "node-transaction": ["transaction"],
  "node-tunnel": ["error"],
  "node-unscoped": ["error"],
};

const instances: Sentra[] = [];

async function sentra(options?: Parameters<typeof createSentra>[0]): Promise<Sentra> {
  const instance = await createSentra(options);
  instances.push(instance);
  return instance;
}

afterEach(async () => {
  await Promise.all(instances.splice(0).map(async (instance) => instance.close()));
});

/** Same body and headers as the recorded request, sent to another scope path. */
function requestAt(fixture: EnvelopeFixture, pathname: string): Request {
  const original = fixtureToRequest(fixture);
  return new Request(new URL(pathname, "http://localhost:8969"), {
    method: "POST",
    headers: original.headers,
    body: fixture.body,
  });
}

function envelopeRequest(body: string, pathname = "/p/s/web/api/1/envelope/"): Request {
  return new Request(new URL(pathname, "http://localhost:8969"), { method: "POST", body });
}

async function kindsOf(instance: Sentra, filter = {}): Promise<ItemKind[]> {
  const page = await instance.query.listItems(filter, { limit: 500 });
  return page.items.map((item) => item.kind).toReversed();
}

function errorLogger(): SentraLogger & { errors: string[] } {
  const errors: string[] = [];
  return {
    errors,
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: (message) => {
      errors.push(message);
    },
  };
}

async function caught(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected a rejection");
}

describe("createSentra end to end", () => {
  it.each(loadEnvelopeFixtures().map((fixture) => [fixture.meta.name, fixture] as const))(
    "ingests %s",
    async (name, fixture) => {
      const instance = await sentra();
      const response = await instance.handle(fixtureToRequest(fixture));
      expect(response.status).toBe(200);
      expect(await kindsOf(instance)).toEqual(EXPECTED_KINDS[name]);
    },
  );

  it("classifies the captureMessage fixture as message", async () => {
    const instance = await sentra();
    await instance.handle(fixtureToRequest(loadEnvelopeFixture("node-message")));
    const page = await instance.query.listIssues();
    expect(page.items.map((issue) => issue.kind)).toEqual(["message"]);
  });

  it("returns the event id and groups repeated errors into one issue", async () => {
    const instance = await sentra();
    const events: LiveEvent[] = [];
    instance.subscribe({}, (event) => events.push(event));
    const fixture = loadEnvelopeFixture("node-error");
    const first = await instance.handle(fixtureToRequest(fixture));
    await instance.handle(fixtureToRequest(fixture));
    expect(await first.json()).toEqual({ id: "5de6e5b4c2d54107b369e4ad5a6909cd" });
    const issues = await instance.query.listIssues();
    expect(issues.items).toHaveLength(1);
    expect(issues.items[0]?.count).toBe(2);
    const reported = events.map((event) =>
      event.type === "item.created" ? event.issue?.isNew : undefined,
    );
    expect(reported).toEqual([true, false]);
  });

  it("splits issues by session and merges services", async () => {
    const instance = await sentra();
    const fixture = loadEnvelopeFixture("node-error");
    await instance.handle(requestAt(fixture, "/app/a/web/api/1/envelope/"));
    await instance.handle(requestAt(fixture, "/app/b/web/api/1/envelope/"));
    await instance.handle(requestAt(fixture, "/app/a/api/api/1/envelope/"));
    const sessionA = await instance.query.listIssues({ session: "a" });
    const sessionB = await instance.query.listIssues({ session: "b" });
    expect(sessionA.items).toHaveLength(1);
    expect(sessionB.items).toHaveLength(1);
    expect(sessionA.items[0]?.id).not.toBe(sessionB.items[0]?.id);
    expect(sessionA.items[0]).toMatchObject({ count: 2, services: ["api", "web"] });
  });

  it("scopes log and span entries by the URL path", async () => {
    const instance = await sentra();
    await instance.handle(
      requestAt(loadEnvelopeFixture("node-logs"), "/my-app/s1/web/api/1/envelope/"),
    );
    await instance.handle(
      requestAt(loadEnvelopeFixture("node-spans"), "/my-app/s1/web/api/1/envelope/"),
    );
    const page = await instance.query.listItems({
      project: "my-app",
      session: "s1",
      service: "web",
    });
    expect(page.items.map((item) => item.kind).toSorted()).toEqual(["log", "log", "span", "span"]);
  });

  it("serves attachment blobs and prefers the error for its event id", async () => {
    const instance = await sentra();
    await instance.handle(fixtureToRequest(loadEnvelopeFixture("node-attachment")));
    const attachments = await instance.query.listItems({ kind: "attachment" });
    const blob = await instance.query.getBlob(attachments.items[0]?.id ?? "");
    expect(blob).toEqual({
      data: new TextEncoder().encode("line1\nline2\n"),
      contentType: "text/plain",
      filename: "a.txt",
    });
    const byEventId = await instance.query.getItemByEventId("A92E3187-891E-48D3-83E4-222471890EFA");
    expect(byEventId?.kind).toBe("error");
    expect(await instance.query.getItemByEventId("nope")).toBeNull();
    const errors = await instance.query.listItems({ kind: "error" });
    expect(await instance.query.getBlob(errors.items[0]?.id ?? "")).toBeNull();
    expect(await instance.query.getBlob("missing")).toBeNull();
  });

  it("serves binary other records as blobs", async () => {
    const instance = await sentra();
    const body = new Uint8Array([
      ...new TextEncoder().encode('{}\n{"type":"profile_chunk","length":2}\n'),
      0xff,
      0xfe,
    ]);
    await instance.handle(
      new Request("http://localhost/p/s/web/api/1/envelope/", { method: "POST", body }),
    );
    const page = await instance.query.listItems({ kind: "other" });
    expect(await instance.query.getBlob(page.items[0]?.id ?? "")).toEqual({
      data: new Uint8Array([0xff, 0xfe]),
      contentType: null,
      filename: "profile_chunk",
    });
  });

  it("returns issue details with the latest item", async () => {
    const instance = await sentra();
    await instance.handle(fixtureToRequest(loadEnvelopeFixture("node-error")));
    const issues = await instance.query.listIssues();
    const [issue] = issues.items;
    const detail = await instance.query.getIssue(issue?.id ?? "");
    expect(detail?.latest?.id).toBe(issue?.lastItemId);
    expect(detail?.latest?.kind).toBe("error");
    expect(await instance.query.getIssue("0000000000000000")).toBeNull();
  });

  it("returns issue details with latest null when the latest item is gone", async () => {
    const instance = await sentra({
      storage: storageWith({ getItem: async () => Promise.resolve(null) }),
    });
    await instance.handle(fixtureToRequest(loadEnvelopeFixture("node-error")));
    const issues = await instance.query.listIssues();
    const [issue] = issues.items;
    const detail = await instance.query.getIssue(issue?.id ?? "");
    expect(detail).toEqual({ ...issue, latest: null });
  });

  it("keeps raw envelopes unless disabled", async () => {
    const fixture = loadEnvelopeFixture("node-gzip");
    const withRaw = await sentra();
    await withRaw.handle(fixtureToRequest(fixture));
    const rawPage = await withRaw.query.listItems();
    const [item] = rawPage.items;
    const raw = await withRaw.query.getRawEnvelope(item?.envelopeId ?? "");
    expect(raw).toEqual(new Uint8Array(gunzipSync(fixture.body)));

    const withoutRaw = await sentra({ rawEnvelopes: false });
    await withoutRaw.handle(fixtureToRequest(fixture));
    const page = await withoutRaw.query.listItems();
    const [other] = page.items;
    expect(await withoutRaw.query.getRawEnvelope(other?.envelopeId ?? "")).toBeNull();
    expect(await withoutRaw.query.getRawEnvelope("missing")).toBeNull();
  });

  it("stores invalid envelopes as failed and answers 400", async () => {
    const instance = await sentra();
    const events: LiveEvent[] = [];
    instance.subscribe({ kind: "error" }, (event) => events.push(event));
    const response = await instance.handle(envelopeRequest("not json\n"));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "invalid_envelope" } });
    const failed = await instance.query.listFailedEnvelopes();
    expect(failed.items).toHaveLength(1);
    expect(failed.items[0]).toMatchObject({ itemCount: 0, header: {}, scope: { project: "p" } });
    expect(events).toEqual([expect.objectContaining({ type: "envelope.failed" })]);
    expect(await instance.query.getRawEnvelope(failed.items[0]?.id ?? "")).toEqual(
      new TextEncoder().encode("not json\n"),
    );
  });

  it("answers 500 storage_error when the write fails", async () => {
    const logger = errorLogger();
    const instance = await sentra({
      logger,
      storage: storageWith({ write: async () => Promise.reject(new Error("disk full")) }),
    });
    const events: LiveEvent[] = [];
    instance.subscribe({}, (event) => events.push(event));
    const response = await instance.handle(fixtureToRequest(loadEnvelopeFixture("node-error")));
    expect(response.status).toBe(500);
    expect(response.headers.get("x-sentry-error")).toBeTruthy();
    expect(await response.json()).toMatchObject({ error: { code: "storage_error" } });
    expect(events).toEqual([
      expect.objectContaining({ type: "envelope.failed", error: "disk full" }),
    ]);
    expect(logger.errors.some((message) => message.includes("disk full"))).toBe(true);
  });

  it("filters live events and isolates throwing listeners", async () => {
    const instance = await sentra();
    const errors: LiveEvent[] = [];
    instance.subscribe({ kind: "error" }, (event) => errors.push(event));
    instance.subscribe({}, () => {
      throw new Error("listener boom");
    });
    const logs = await instance.handle(fixtureToRequest(loadEnvelopeFixture("node-logs")));
    const error = await instance.handle(fixtureToRequest(loadEnvelopeFixture("node-error")));
    expect([logs.status, error.status]).toEqual([200, 200]);
    expect(
      errors.map((event) => (event.type === "item.created" ? event.item.kind : event.type)),
    ).toEqual(["error"]);
  });

  it("unsubscribes", async () => {
    const instance = await sentra();
    const received: LiveEvent[] = [];
    const unsubscribe = instance.subscribe({}, (event) => received.push(event));
    unsubscribe();
    await instance.handle(fixtureToRequest(loadEnvelopeFixture("node-error")));
    expect(received).toEqual([]);
  });

  it("validates filters, live filters and cursors", async () => {
    const instance = await sentra();
    const filterError = await caught(instance.query.listItems({ since: "60m", from: 1 }));
    expect(filterError).toBeInstanceOf(SentraValidationError);
    expect(filterError).toMatchObject({ code: "invalid_filter" });
    await expect(instance.query.listIssues({}, { cursor: "%%%" })).rejects.toMatchObject({
      code: "invalid_cursor",
    });
    await expect(instance.query.listFailedEnvelopes({ since: "-5m" })).rejects.toMatchObject({
      code: "invalid_filter",
    });
    // Non-literal objects skip excess property checks, so unknown keys reach runtime validation.
    const scopeFilter = { project: "p", sevice: "x" };
    await expect(instance.query.listScopes(scopeFilter)).rejects.toMatchObject({
      code: "invalid_filter",
    });
    const kind: ItemKind = "error";
    const liveFilter = { kind, since: "1h" };
    expect(() => instance.subscribe(liveFilter, () => undefined)).toThrow(
      expect.objectContaining({ code: "invalid_filter" }),
    );
  });

  it("clears records and their issues", async () => {
    const instance = await sentra();
    await instance.handle(
      requestAt(loadEnvelopeFixture("node-error"), "/keep/s/web/api/1/envelope/"),
    );
    await instance.handle(
      requestAt(loadEnvelopeFixture("node-error"), "/drop/s/web/api/1/envelope/"),
    );
    expect(await instance.clear({ project: "drop" })).toEqual({ itemsDeleted: 1 });
    const issues = await instance.query.listIssues();
    expect(issues.items.map((issue) => issue.project)).toEqual(["keep"]);
    expect(await instance.clear()).toEqual({ itemsDeleted: 1 });
    expect(await kindsOf(instance)).toEqual([]);
  });

  it("builds DSNs from publicUrl", async () => {
    const withUrl = await sentra({ publicUrl: "http://localhost:8969" });
    expect(withUrl.getDsn()).toBe("http://sentra@localhost:8969/1");
    expect(withUrl.getDsn({ project: "my-app", service: "web" })).toBe(
      "http://sentra@localhost:8969/my-app/_/web/1",
    );
    const withoutUrl = await sentra();
    expect(() => withoutUrl.getDsn()).toThrow(SentraConfigError);
    expect(() => withoutUrl.getDsn()).toThrow(
      expect.objectContaining({ code: "missing_public_url" }),
    );
  });

  it("reports info, stubs and closes idempotently", async () => {
    const instance = await createSentra({ retention: { maxIdle: "never", noiseMaxAge: "2d" } });
    expect(instance.info()).toEqual({
      version: "dev",
      storage: { type: "memory", driver: null, path: null },
      retention: "never idle, noise 2d",
    });
    expect(instance.mcpTools().map((tool) => tool.name)).toEqual([
      "sentra_list_scopes",
      "sentra_list_issues",
      "sentra_get_issue",
      "sentra_list_items",
      "sentra_get_item",
    ]);
    instance.addSourceRoot("/srv/app");
    instance.addSourceRoot("/srv/app");
    instance.removeSourceRoot("/srv/app");
    expect(() => {
      instance.addSourceRoot("relative");
    }).toThrow(expect.objectContaining({ code: "invalid_option" }));
    await expect(instance.vacuum()).resolves.toBeUndefined();
    await expect(instance.prune()).resolves.toEqual({ sessionsDeleted: 0, itemsDeleted: 0 });
    await instance.close();
    await expect(instance.close()).resolves.toBeUndefined();
  });

  it("handle is bound and never rejects", async () => {
    const instance = await sentra();
    const { handle } = instance;
    const response = await handle(
      new Request("http://localhost/nope", { method: "POST", body: "x" }),
    );
    expect(response.status).toBe(404);
  });

  it("rejects invalid options", async () => {
    await expect(createSentra({ limits: { maxEnvelopeBytes: 0 } })).rejects.toMatchObject({
      code: "invalid_option",
    });
  });
});
