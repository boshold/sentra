import { looseObject, number, record, string, unknown } from "zod";

import {
  breadcrumbsSchema,
  collectDropped,
  eventPayloadSchema,
  lenient,
  logContainerSchema,
  logEntrySchema,
  normalizeEventId,
  requestSchema,
  sdkSchema,
  spanContainerSchema,
  tagsSchema,
  transactionPayloadSchema,
  truncate,
} from "#src/normalize/schemas.js";
import { parseEnvelope } from "#src/parse/envelope.js";

import { loadEnvelopeFixture } from "../../../../test/fixtures/envelopes.js";

const EVENT_KEYS = [
  "event_id",
  "timestamp",
  "level",
  "platform",
  "environment",
  "release",
  "dist",
  "logger",
  "server_name",
  "transaction",
  "culprit",
  "message",
  "logentry",
  "exception",
  "stacktrace",
  "threads",
  "fingerprint",
  "user",
  "request",
  "tags",
  "contexts",
  "extra",
  "breadcrumbs",
  "sdk",
] as const;

const decoder = new TextDecoder();
const plainObjectSchema = record(string(), unknown());

function fixturePayload(name: string, type: string): Record<string, unknown> {
  const result = parseEnvelope(loadEnvelopeFixture(name).body);
  if (!result.ok) {
    throw new Error(result.error);
  }
  const item = result.envelope.items.find((candidate) => candidate.header.type === type);
  if (item === undefined) {
    throw new Error(`${name}: no ${type} item`);
  }
  return plainObjectSchema.parse(JSON.parse(decoder.decode(item.payload)));
}

describe("lenient", () => {
  const schema = looseObject({ n: lenient(number()), s: lenient(string()) });

  it.each([
    [
      { n: 1, s: "a" },
      { n: 1, s: "a" },
    ],
    [
      { n: null, s: "a" },
      { n: undefined, s: "a" },
    ],
    [
      { n: "x", s: 2 },
      { n: undefined, s: undefined },
    ],
    [{}, { n: undefined, s: undefined }],
  ])("parses %j", (input, expected) => {
    const parsed = schema.parse(input);
    expect(parsed.n).toBe(expected.n);
    expect(parsed.s).toBe(expected.s);
  });
});

describe("collectDropped", () => {
  it("lists keys present in input but undefined after parsing", () => {
    expect(
      collectDropped({ a: 1, b: null, c: "x", d: 2 }, { a: 1, c: undefined }, ["a", "b", "c", "d"]),
    ).toEqual(["c", "d"]);
  });
});

describe("eventPayloadSchema", () => {
  it("drops invalid optional fields and keeps unknown ones", () => {
    const input = { level: 5, tags: "x", user: { id: 1 }, extra_field: true };
    const parsed = eventPayloadSchema.parse(input);
    expect(parsed.level).toBeUndefined();
    expect(parsed.tags).toBeUndefined();
    expect(parsed.user).toEqual({ id: 1 });
    expect(parsed.extra_field).toBe(true);
    expect(collectDropped(input, parsed, EVENT_KEYS)).toEqual(["level", "tags"]);
  });

  it.each([["text"], [[1]], [null], [42]])("fails for %j", (input) => {
    expect(eventPayloadSchema.safeParse(input).success).toBe(false);
  });

  it("accepts exception and threads as { values }", () => {
    const parsed = eventPayloadSchema.parse({
      exception: { values: [{ type: "Error", value: "boom", mechanism: { type: "generic" } }] },
      threads: { values: [{ id: 1, stacktrace: { frames: [{ filename: "a.js", lineno: 1 }] } }] },
      message: { formatted: "hi" },
    });
    expect(parsed.exception?.values?.[0]?.type).toBe("Error");
    expect(parsed.exception?.values?.[0]?.mechanism?.handled).toBeUndefined();
    expect(parsed.threads?.values?.[0]?.stacktrace?.frames?.[0]?.filename).toBe("a.js");
    expect(parsed.message).toEqual({ formatted: "hi" });
  });

  it("drops invalid exception, thread and frame entries one by one", () => {
    const parsed = eventPayloadSchema.parse({
      exception: {
        values: [
          { type: "E", stacktrace: { frames: [{ filename: "a.js" }, null, 3, { lineno: 2 }] } },
          null,
          "junk",
        ],
      },
      threads: { values: [null, { name: "main" }] },
    });
    expect(parsed.exception?.values).toHaveLength(1);
    expect(
      parsed.exception?.values?.[0]?.stacktrace?.frames?.map((frame) => frame.filename),
    ).toEqual(["a.js", undefined]);
    expect(parsed.threads?.values?.map((thread) => thread.name)).toEqual(["main"]);
  });

  it("drops a non-array exception.values", () => {
    expect(
      eventPayloadSchema.parse({ exception: { values: "x" } }).exception?.values,
    ).toBeUndefined();
  });

  it("drops a fingerprint with a non-string entry as a whole", () => {
    expect(eventPayloadSchema.parse({ fingerprint: ["a", 1] }).fingerprint).toBeUndefined();
    expect(eventPayloadSchema.parse({ fingerprint: ["a", "b"] }).fingerprint).toEqual(["a", "b"]);
  });

  it.each([
    ["node-error", "event"],
    ["browser-error", "event"],
    ["node-message", "event"],
  ])("parses the %s fixture without dropping fields", (name, type) => {
    const payload = fixturePayload(name, type);
    const parsed = eventPayloadSchema.parse(payload);
    expect(collectDropped(payload, parsed, EVENT_KEYS)).toEqual([]);
    expect(parsed.exception?.values?.length).toBeGreaterThan(0);
  });

  it("parses the transaction fixture without dropping fields", () => {
    const payload = fixturePayload("node-transaction", "transaction");
    const parsed = transactionPayloadSchema.parse(payload);
    const keys = ["start_timestamp", "timestamp", "spans", "contexts", "sdk", "transaction"];
    expect(collectDropped(payload, parsed, keys)).toEqual([]);
    expect(parsed.spans?.[0]?.op).toBe("test.child");
  });
});

describe("transactionPayloadSchema", () => {
  it("drops invalid spans and measurements one by one", () => {
    const parsed = transactionPayloadSchema.parse({
      spans: [{ span_id: "a" }, null, "junk", { span_id: "b" }],
      measurements: {
        fcp: { value: 1, unit: "millisecond" },
        bad: 5,
        nil: null,
        lcp: { value: 2 },
      },
    });
    expect(parsed.spans?.map((span) => span.span_id)).toEqual(["a", "b"]);
    expect(parsed.measurements).toEqual({
      fcp: { value: 1, unit: "millisecond" },
      lcp: { value: 2, unit: undefined },
    });
  });

  it("drops non-array spans and non-object measurements", () => {
    const parsed = transactionPayloadSchema.parse({ spans: {}, measurements: [1] });
    expect(parsed.spans).toBeUndefined();
    expect(parsed.measurements).toBeUndefined();
  });
});

describe("tagsSchema", () => {
  it("accepts pairs", () => {
    expect(
      tagsSchema.parse([
        ["a", "1"],
        ["b", 2],
        ["c", true],
        ["d", null],
        ["e", { x: 1 }],
        ["bad"],
        "junk",
        [3, "x"],
      ]),
    ).toEqual({ a: "1", b: "2", c: "true" });
  });

  it("accepts an object", () => {
    expect(tagsSchema.parse({ a: "1", b: 2, c: null, d: [1] })).toEqual({ a: "1", b: "2" });
  });

  it("rejects a string", () => {
    expect(tagsSchema.safeParse("x").success).toBe(false);
  });
});

describe("breadcrumbsSchema", () => {
  const raw = [
    {
      timestamp: 1_727_950_000.123,
      type: "default",
      category: "console",
      level: "warn",
      message: "hi",
      data: { a: 1 },
    },
    { timestamp: "nope", level: 3, message: 5, data: [1] },
    "junk",
  ];
  const expected = [
    {
      timestamp: "2024-10-03T10:06:40.123Z",
      type: "default",
      category: "console",
      level: "warning",
      message: "hi",
      data: { a: 1 },
    },
    { timestamp: null, type: null, category: null, level: null, message: null, data: null },
  ];

  it("accepts an array", () => {
    expect(breadcrumbsSchema.parse(raw)).toEqual(expected);
  });

  it("accepts { values }", () => {
    expect(breadcrumbsSchema.parse({ values: raw })).toEqual(expected);
  });
});

describe("requestSchema", () => {
  it("drops non-object headers and keeps the rest", () => {
    expect(
      requestSchema.parse({
        method: "GET",
        url: "http://localhost/x",
        headers: "nope",
        data: { a: 1 },
        cookies: "c=1",
        env: { REMOTE_ADDR: "::1" },
      }),
    ).toEqual({
      method: "GET",
      url: "http://localhost/x",
      headers: {},
      query: null,
      data: { a: 1 },
    });
  });

  it("keeps string headers only", () => {
    expect(requestSchema.parse({ headers: { a: "1", b: 2 } }).headers).toEqual({ a: "1" });
  });

  it.each([
    ["a=1&b=2", "a=1&b=2"],
    [{ a: "1", b: "x y" }, "a=1&b=x+y"],
    [
      [
        ["a", "1"],
        ["a", "2"],
      ],
      "a=1&a=2",
    ],
    ["", null],
    [42, null],
  ])("serializes query_string %j", (queryString, expected) => {
    expect(requestSchema.parse({ query_string: queryString }).query).toBe(expected);
  });
});

describe("sdkSchema", () => {
  it("returns name and version", () => {
    expect(sdkSchema.parse({ name: "sentry.javascript.node", version: "11.1.0", x: 1 })).toEqual({
      name: "sentry.javascript.node",
      version: "11.1.0",
    });
  });

  it("returns undefined without version", () => {
    expect(sdkSchema.parse({ name: "sentry.javascript.node" })).toBeUndefined();
    expect(eventPayloadSchema.parse({ sdk: { name: "x" } }).sdk).toBeUndefined();
  });
});

describe("containers", () => {
  it.each([[spanContainerSchema], [logContainerSchema]])(
    "ignores version and extra fields",
    (schema) => {
      const parsed = schema.parse({ version: 3, ingest_settings: { x: 1 }, items: [{ a: 1 }, 2] });
      expect(parsed.items).toEqual([{ a: 1 }, 2]);
    },
  );

  it.each([[spanContainerSchema], [logContainerSchema]])("requires items", (schema) => {
    expect(schema.safeParse({ version: 2 }).success).toBe(false);
    expect(schema.safeParse({ items: "x" }).success).toBe(false);
  });

  it("parses log entries leniently", () => {
    const parsed = logEntrySchema.parse({ body: "hi", severity_number: "9", level: "info" });
    expect(parsed.body).toBe("hi");
    expect(parsed.severity_number).toBeUndefined();
  });
});

describe("normalizeEventId", () => {
  it.each([
    ["5DE6E5B4-C2D5-4107-B369-E4AD5A6909CD", "5de6e5b4c2d54107b369e4ad5a6909cd"],
    ["5de6e5b4c2d54107b369e4ad5a6909cd", "5de6e5b4c2d54107b369e4ad5a6909cd"],
    ["5de6e5b4c2d54107b369e4ad5a6909c", null],
    ["5de6e5b4c2d54107b369e4ad5a6909cz", null],
    [123, null],
    [null, null],
  ])("normalizes %j", (input, expected) => {
    expect(normalizeEventId(input)).toBe(expected);
  });
});

describe("truncate", () => {
  it("keeps short text", () => {
    expect(truncate("abc", 3)).toBe("abc");
  });

  it("cuts to max length with an ellipsis", () => {
    expect(truncate("abcdef", 4)).toBe("abc…");
    expect(truncate("x".repeat(600), 500)).toHaveLength(500);
  });

  it("does not split surrogate pairs", () => {
    expect(truncate("ab😀cd", 4)).toBe("ab…");
    expect(truncate("abc😀d", 4)).toBe("abc…");
    expect(truncate("a😀😀", 3)).toBe("a…");
  });

  it.each([[0], [-1]])("returns empty text for max %i", (max) => {
    expect(truncate("abc", max)).toBe("");
  });
});
