import { record, string, unknown } from "zod";

import { normalizeEvent } from "#src/normalize/event.js";
import type { NewItem, NormalizeContext } from "#src/normalize/types.js";
import { parseEnvelope } from "#src/parse/envelope.js";
import type { EventData, Item } from "#src/types.js";

import { loadEnvelopeFixture } from "../../../../test/fixtures/envelopes.js";

const RECEIVED_AT = "2026-10-03T12:00:00.000Z";
const decoder = new TextDecoder();
const objectSchema = record(string(), unknown());

function context(overrides: Partial<NormalizeContext> = {}): NormalizeContext {
  let next = 0;
  return {
    scope: { project: "p", session: "s", service: "svc" },
    envelopeId: "env-1",
    envelopeHeader: {},
    receivedAt: RECEIVED_AT,
    maxAttachmentBytes: 1024,
    allowedHosts: [],
    newId: () => `id-${(next += 1)}`,
    ...overrides,
  };
}

function normalizeOne(payload: unknown): NewItem {
  const result = normalizeEvent(payload, context());
  if (!result.ok) {
    throw new Error(result.error);
  }
  const [first] = result.items;
  if (first === undefined || result.items.length !== 1) {
    throw new Error("expected one item");
  }
  return first;
}

function eventData(item: Item): EventData {
  if (item.kind !== "error" && item.kind !== "message") {
    throw new Error(`unexpected kind ${item.kind}`);
  }
  return item.data;
}

function fixtureEvent(name: string): Record<string, unknown> {
  const result = parseEnvelope(loadEnvelopeFixture(name).body);
  if (!result.ok) {
    throw new Error(result.error);
  }
  const item = result.envelope.items.find((candidate) => candidate.header.type === "event");
  if (item === undefined) {
    throw new Error(`${name}: no event item`);
  }
  return objectSchema.parse(JSON.parse(decoder.decode(item.payload)));
}

describe("normalizeEvent fixtures", () => {
  it("normalizes the Node error fixture", () => {
    const { item, grouping, warnings, blob } = normalizeOne(fixtureEvent("node-error"));
    const data = eventData(item);
    expect(item.kind).toBe("error");
    expect(item.title).toBe("Error: boom");
    expect(item.level).toBe("error");
    expect(item.platform).toBe("node");
    expect(item.eventId).toBe("5de6e5b4c2d54107b369e4ad5a6909cd");
    expect(item.traceId).toBe("43fd8eeb6c5f4161ba297e14cd9b7119");
    expect(item.itemType).toBe("event");
    expect(item.issueId).toBeNull();
    expect(data.exceptions.at(-1)?.frames.length).toBeGreaterThan(0);
    expect(data.exceptions.at(-1)?.mechanism).toEqual({ type: "generic", handled: true });
    expect(data.exceptions.at(-1)?.frames.at(-1)?.absPath).toBeNull();
    expect(data.stacktrace).toEqual([]);
    expect(data.sdk?.name).toBe("sentry.javascript.node");
    expect(data.serverName).toBe("sentra-fixture");
    expect(grouping).toEqual({ payloadFingerprint: null, messageTemplate: null });
    expect(warnings).toEqual([]);
    expect(blob).toBeNull();
  });

  it("classifies the captureMessage fixture as kind message", () => {
    const { item, grouping } = normalizeOne(fixtureEvent("node-message"));
    const data = eventData(item);
    expect(item.kind).toBe("message");
    expect(item.title).toBe("hello msg");
    expect(item.level).toBe("info");
    expect(data.exceptions).toEqual([]);
    expect(data.stacktrace.length).toBeGreaterThan(0);
    expect(data.message).toBe("hello msg");
    expect(grouping?.messageTemplate).toBe("hello msg");
  });

  it("normalizes the browser error fixture with recomputed inApp", () => {
    const { item, warnings } = normalizeOne(fixtureEvent("browser-error"));
    const data = eventData(item);
    expect(item.kind).toBe("error");
    expect(item.title).toBe("Error: browser boom");
    expect(item.platform).toBe("javascript");
    expect(data.request?.url).toBe("http://localhost:3000/app/page");
    expect(data.exceptions.at(-1)?.frames.every((frame) => frame.inApp)).toBe(true);
    expect(warnings).toEqual([]);
  });
});

describe("normalizeEvent classification", () => {
  it.each([
    [{ message: "m", exception: { values: [{ type: "E", value: "v" }] } }, "error", "E: v"],
    [{ exception: { values: [{ value: "only value" }] } }, "error", "only value"],
    [{ exception: { values: [{ type: "OnlyType" }] } }, "error", "OnlyType"],
    [{ exception: { values: [{}] } }, "error", "<unknown error>"],
    [{ message: "m", exception: { values: [{ value: "m" }] } }, "message", "m"],
    [{ logentry: { formatted: "f" }, exception: { values: [] } }, "message", "f"],
    [{}, "message", "<unknown error>"],
    [{ message: "" }, "message", "<unknown error>"],
  ])("classifies %j as %s", (payload, kind, title) => {
    const { item } = normalizeOne(payload);
    expect(item.kind).toBe(kind);
    expect(item.title).toBe(title);
  });

  it.each([
    [
      { type: "onerror", handled: false },
      { type: "onerror", handled: false },
    ],
    [{ type: "onerror" }, { type: "onerror", handled: null }],
    [{ handled: false }, { type: "generic", handled: false }],
    [
      { type: 5, handled: true },
      { type: "generic", handled: true },
    ],
    [{ synthetic: true }, null],
    ["junk", null],
  ])("maps mechanism %j", (mechanism, expected) => {
    const { item } = normalizeOne({ exception: { values: [{ type: "E", mechanism }] } });
    expect(eventData(item).exceptions[0]?.mechanism).toEqual(expected);
  });

  it("keeps all exceptions in Sentry order and titles from the last", () => {
    const { item } = normalizeOne({
      exception: {
        values: [
          { type: "Cause", value: "c" },
          { type: "Outer", value: "o" },
        ],
      },
    });
    const data = eventData(item);
    expect(data.exceptions.map((exception) => exception.type)).toEqual(["Cause", "Outer"]);
    expect(item.title).toBe("Outer: o");
  });

  it("resolves message from logentry and message objects", () => {
    const fromLogentry = normalizeOne({ logentry: { message: "user %s", formatted: "user 12" } });
    expect(eventData(fromLogentry.item).message).toBe("user 12");
    expect(fromLogentry.grouping?.messageTemplate).toBe("user %s");

    const fromObject = normalizeOne({ message: { message: "t %s", formatted: "t 1" } });
    expect(eventData(fromObject.item).message).toBe("t 1");
    expect(fromObject.grouping?.messageTemplate).toBe("t %s");
  });

  it("selects message stacktrace from payload stacktrace, then threads", () => {
    const fromStacktrace = normalizeOne({
      message: "m",
      stacktrace: { frames: [{ function: "a" }] },
      threads: { values: [{ stacktrace: { frames: [{ function: "t" }] } }] },
    });
    expect(eventData(fromStacktrace.item).stacktrace.map((frame) => frame.function)).toEqual(["a"]);

    const fromThreads = normalizeOne({
      message: "m",
      threads: { values: [{ id: 1 }, { stacktrace: { frames: [{ function: "t" }] } }] },
    });
    expect(eventData(fromThreads.item).stacktrace.map((frame) => frame.function)).toEqual(["t"]);
  });
});

describe("normalizeEvent common fields", () => {
  it.each([
    ["5DE6E5B4-C2D5-4107-B369-E4AD5A6909CD", "5de6e5b4c2d54107b369e4ad5a6909cd"],
    ["nope", null],
  ])("normalizes event_id %j", (eventId, expected) => {
    expect(normalizeOne({ event_id: eventId }).item.eventId).toBe(expected);
  });

  it.each([
    [1_727_950_000.123, "2024-10-03T10:06:40.123Z"],
    ["2024-10-03T10:06:40.123Z", "2024-10-03T10:06:40.123Z"],
    [undefined, RECEIVED_AT],
    ["bad", RECEIVED_AT],
  ])("normalizes timestamp %j", (timestamp, expected) => {
    expect(normalizeOne({ timestamp }).item.timestamp).toBe(expected);
  });

  it.each([
    [{ level: "warn" }, "warning"],
    [{ level: "bogus" }, "info"],
    [{ exception: { values: [{ type: "E" }] } }, "error"],
    [{ message: "m" }, "info"],
  ])("maps level for %j", (payload, expected) => {
    expect(normalizeOne(payload).item.level).toBe(expected);
  });

  it("copies ctx and payload fields", () => {
    const { item } = normalizeOne({
      environment: "dev",
      release: "1.0",
      platform: "python",
      culprit: "app.views",
      transaction: "/users",
      logger: "root",
      dist: "d1",
      contexts: { trace: { trace_id: 5 } },
    });
    const data = eventData(item);
    expect(item).toMatchObject({
      id: "id-1",
      envelopeId: "env-1",
      scope: { project: "p", session: "s", service: "svc" },
      receivedAt: RECEIVED_AT,
      environment: "dev",
      release: "1.0",
      platform: "python",
      traceId: null,
    });
    expect(data).toMatchObject({
      culprit: "app.views",
      transaction: "/users",
      logger: "root",
      dist: "d1",
      fingerprint: [],
      sourceMaps: { status: "not_applicable", mappedFrames: 0, candidateFrames: 0, errors: [] },
    });
  });

  it("defaults collections and nullable objects", () => {
    const data = eventData(normalizeOne({ user: "x", request: 1, sdk: { name: "n" } }).item);
    expect(data).toMatchObject({
      tags: {},
      contexts: {},
      extra: {},
      breadcrumbs: [],
      user: null,
      request: null,
      sdk: null,
    });
  });

  it("normalizes tags and breadcrumbs", () => {
    expect(eventData(normalizeOne({ tags: [["a", "1"]] }).item).tags).toEqual({ a: "1" });
    expect(eventData(normalizeOne({ tags: { a: 2 } }).item).tags).toEqual({ a: "2" });
    const data = eventData(
      normalizeOne({ breadcrumbs: { values: [{ timestamp: 1_727_950_000.123, message: "b" }] } })
        .item,
    );
    expect(data.breadcrumbs).toEqual([
      {
        timestamp: "2024-10-03T10:06:40.123Z",
        type: null,
        category: null,
        level: null,
        message: "b",
        data: null,
      },
    ]);
  });

  it("warns about dropped fields", () => {
    const { item, warnings } = normalizeOne({ tags: 5 });
    expect(eventData(item).tags).toEqual({});
    expect(warnings).toEqual(["event: dropped invalid field 'tags'"]);
  });

  it.each([
    [
      ["a", "{{ default }}"],
      ["a", "{{ default }}"],
    ],
    [[], null],
    [[1], null],
  ])("resolves payload fingerprint %j", (fingerprint, expected) => {
    expect(normalizeOne({ fingerprint }).grouping?.payloadFingerprint).toEqual(expected);
  });

  it("truncates long titles to 500 chars", () => {
    const { item } = normalizeOne({ message: "x".repeat(600) });
    expect(item.title).toHaveLength(500);
    expect(eventData(item).message).toHaveLength(600);
  });

  it("recomputes inApp for javascript events with allowedHosts from ctx", () => {
    const payload = {
      platform: "javascript",
      exception: {
        values: [
          {
            type: "E",
            stacktrace: {
              frames: [
                { filename: "https://cdn.example.com/lib.js", in_app: true },
                { filename: "http://localhost:3000/src/a.ts", in_app: true },
              ],
            },
          },
        ],
      },
    };
    const result = normalizeEvent(payload, context({ allowedHosts: ["cdn.example.com"] }));
    const strict = normalizeOne(payload);
    if (!result.ok) {
      throw new Error(result.error);
    }
    const [allowed] = result.items;
    expect(allowed && eventData(allowed.item).exceptions[0]?.frames.map((f) => f.inApp)).toEqual([
      true,
      true,
    ]);
    expect(eventData(strict.item).exceptions[0]?.frames.map((f) => f.inApp)).toEqual([false, true]);
  });
});

describe("normalizeEvent failures", () => {
  it.each([["text"], [null], [[]], [42]])("rejects payload %j", (payload) => {
    expect(normalizeEvent(payload, context()).ok).toBe(false);
  });
});
