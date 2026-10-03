import { gunzipSync } from "node:zlib";

import type { IngestContext } from "#src/ingest/handler.js";
import { createPipeline } from "#src/ingest/pipeline.js";
import type { MapFramesStep } from "#src/ingest/pipeline.js";
import { createLiveBus } from "#src/live/bus.js";
import { resolveOptions } from "#src/options.js";
import { parseEnvelope } from "#src/parse/envelope.js";
import type { IngestBatch, StorageAdapter } from "#src/storage/types.js";
import type { LiveEvent, MappedLocation } from "#src/types.js";

import { loadEnvelopeFixture } from "../../../../test/fixtures/envelopes.js";
import { storageWithWrite } from "../helpers/storage.js";

const RECEIVED_AT = new Date("2026-10-03T12:00:00.000Z");
const SCOPE = { project: "p", session: "s", service: "web" };
const encoder = new TextEncoder();

interface Harness {
  sink: (ctx: IngestContext) => Promise<{ id: string }>;
  writes: IngestBatch[];
  events: LiveEvent[];
  order: string[];
}

function spyStorage(order: string[], writes: IngestBatch[], fail = false): StorageAdapter {
  return storageWithWrite(async (inner, batch) => {
    order.push("write");
    writes.push(batch);
    if (fail) {
      throw new Error("disk full");
    }
    return inner.write(batch);
  });
}

function harness(
  options: { fail?: boolean; rawEnvelopes?: boolean; mapFrames?: MapFramesStep } = {},
): Harness {
  const order: string[] = [];
  const writes: IngestBatch[] = [];
  const events: LiveEvent[] = [];
  const resolved = resolveOptions({ rawEnvelopes: options.rawEnvelopes });
  const storage = spyStorage(order, writes, options.fail);
  const bus = createLiveBus(resolved.logger);
  bus.subscribe({}, (event) => {
    order.push(event.type);
    events.push(event);
  });
  const sink = createPipeline({
    storage,
    bus,
    options: resolved,
    logger: resolved.logger,
    mapFrames: options.mapFrames,
  });
  return { sink, writes, events, order };
}

function parsedContext(raw: Uint8Array): IngestContext {
  const result = parseEnvelope(raw);
  if (!result.ok) {
    throw new Error(result.error);
  }
  return {
    scope: SCOPE,
    receivedAt: RECEIVED_AT,
    contentEncoding: null,
    raw,
    parsed: result.envelope,
    parseError: null,
  };
}

function fixtureContext(name: string): IngestContext {
  const fixture = loadEnvelopeFixture(name);
  const raw =
    fixture.meta.headers["content-encoding"] === "gzip" ? gunzipSync(fixture.body) : fixture.body;
  return parsedContext(raw);
}

function failedContext(): IngestContext {
  return {
    scope: SCOPE,
    receivedAt: RECEIVED_AT,
    contentEncoding: "gzip",
    raw: encoder.encode("not json\n"),
    parsed: null,
    parseError: "invalid envelope header",
  };
}

function onlyWrite(writes: IngestBatch[]): IngestBatch {
  const [batch] = writes;
  if (batch === undefined || writes.length !== 1) {
    throw new Error(`expected one write, got ${writes.length}`);
  }
  return batch;
}

describe("createPipeline", () => {
  it("builds one atomic batch for an error envelope", async () => {
    const { sink, writes } = harness();
    const ctx = fixtureContext("node-attachment");
    const response = await sink(ctx);
    const batch = onlyWrite(writes);
    expect(response).toEqual({ id: "a92e3187891e48d383e4222471890efa" });
    expect(batch.envelope).toMatchObject({
      scope: SCOPE,
      receivedAt: RECEIVED_AT.toISOString(),
      header: ctx.parsed?.header,
      size: ctx.raw.byteLength,
      contentEncoding: null,
      itemCount: 2,
      parseError: null,
      parseWarnings: [],
    });
    expect(batch.envelope.body).toBe(ctx.raw);
    expect(batch.items.map(({ item }) => item.kind)).toEqual(["error", "attachment"]);
    const [error, attachment] = batch.items;
    expect(error?.item.issueId).toMatch(/^[0-9a-f]{16}$/);
    expect(error?.item.receivedAt).toBe(RECEIVED_AT.toISOString());
    expect(attachment?.blob?.byteLength).toBe(12);
    expect(attachment?.item.issueId).toBeNull();
    const [issue] = batch.issues;
    expect(batch.issues).toHaveLength(1);
    expect(issue).toMatchObject({
      id: error?.item.issueId,
      project: "p",
      session: "s",
      kind: "error",
      title: "Error: boom with attachment",
      level: "error",
      platform: "node",
      itemId: error?.item.id,
      seenAt: RECEIVED_AT.toISOString(),
    });
    if (error?.item.kind === "error") {
      expect(error.item.data.fingerprint).toEqual(issue?.fingerprint);
      expect(error.item.data.fingerprint[0]).toBe("Error");
      expect(error.item.data.culprit).toBe(issue?.culprit);
      expect(issue?.culprit).toMatch(/^boom \(/);
    }
  });

  it("publishes item.created after the write, in order, with issue info", async () => {
    const { sink, order, events } = harness();
    await sink(fixtureContext("node-attachment"));
    await sink(fixtureContext("node-attachment"));
    expect(order).toEqual([
      "write",
      "item.created",
      "item.created",
      "write",
      "item.created",
      "item.created",
    ]);
    const issues = events.map((event) => (event.type === "item.created" ? event.issue : undefined));
    expect(issues[0]).toMatchObject({ isNew: true, count: 1 });
    expect(issues[1]).toBeNull();
    expect(issues[2]).toMatchObject({ isNew: false, count: 2 });
  });

  it("calls mapFrames between normalize and grouping", async () => {
    const mapped: MappedLocation = {
      source: "components/User/Card.vue",
      absPath: null,
      lineno: 42,
      colno: 1,
      function: "loadUser",
      contextLine: null,
      preContext: [],
      postContext: [],
    };
    const mapFrames: MapFramesStep = async (items) => {
      for (const { item } of items) {
        if (item.kind === "error") {
          for (const exception of item.data.exceptions) {
            for (const frame of exception.frames) {
              frame.mapped = mapped;
            }
          }
          expect(item.issueId).toBeNull();
        }
      }
      return items;
    };
    const { sink, writes } = harness({ mapFrames });
    await sink(fixtureContext("node-error"));
    const [issue] = onlyWrite(writes).issues;
    expect(issue?.fingerprint[1]).toBe("components/User/Card.vue:loadUser");
    expect(issue?.culprit).toBe("loadUser (components/User/Card.vue:42)");
  });

  it("uses the first record eventId, then the envelope id, as response id", async () => {
    const withEventId = harness();
    expect(
      await withEventId.sink(
        parsedContext(
          encoder.encode('{}\n{"type":"event"}\n{"event_id":"5de6e5b4c2d54107b369e4ad5a6909cd"}\n'),
        ),
      ),
    ).toEqual({ id: "5de6e5b4c2d54107b369e4ad5a6909cd" });
    const withoutEventId = harness();
    const response = await withoutEventId.sink(
      parsedContext(encoder.encode('{}\n{"type":"session"}\n{}\n')),
    );
    expect(response.id).toBe(onlyWrite(withoutEventId.writes).envelope.id);
  });

  it("omits the body when rawEnvelopes is false, but keeps it for parse failures", async () => {
    const { sink, writes } = harness({ rawEnvelopes: false });
    await sink(fixtureContext("node-error"));
    await sink(failedContext());
    const [ok, failed] = writes;
    expect(ok?.envelope).not.toHaveProperty("body");
    expect(failed?.envelope.body).toEqual(encoder.encode("not json\n"));
  });

  it("writes failed envelopes and publishes envelope.failed afterwards", async () => {
    const { sink, writes, order, events } = harness();
    const response = await sink(failedContext());
    const batch = onlyWrite(writes);
    expect(batch).toEqual({
      envelope: {
        id: response.id,
        scope: SCOPE,
        receivedAt: RECEIVED_AT.toISOString(),
        header: {},
        size: 9,
        contentEncoding: "gzip",
        itemCount: 0,
        parseError: "invalid envelope header",
        parseWarnings: [],
        body: encoder.encode("not json\n"),
      },
      items: [],
      issues: [],
    });
    expect(order).toEqual(["write", "envelope.failed"]);
    expect(events[0]).toMatchObject({ type: "envelope.failed", error: "invalid envelope header" });
    expect(events[0]?.type === "envelope.failed" && events[0].envelope).not.toHaveProperty("body");
  });

  it.each([
    ["parsed", () => fixtureContext("node-error")],
    ["failed", failedContext],
  ])("rejects and publishes envelope.failed when the %s write fails", async (_label, context) => {
    const { sink, order, events } = harness({ fail: true });
    await expect(sink(context())).rejects.toThrow("disk full");
    expect(order).toEqual(["write", "envelope.failed"]);
    expect(events[0]).toMatchObject({ type: "envelope.failed", error: "disk full" });
    expect(events[0]?.type === "envelope.failed" && events[0].envelope).not.toHaveProperty("body");
  });

  it("logs normalizer warnings at debug level", async () => {
    const debug: string[] = [];
    const resolved = resolveOptions({
      logger: {
        debug: (message: string) => debug.push(message),
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      },
    });
    const sink = createPipeline({
      storage: resolved.storage,
      bus: createLiveBus(resolved.logger),
      options: resolved,
      logger: resolved.logger,
    });
    await sink(parsedContext(encoder.encode('{}\n{"type":"event"}\n{"message":"m","tags":5}\n')));
    expect(debug).toEqual(["event: dropped invalid field 'tags'"]);
  });
});
