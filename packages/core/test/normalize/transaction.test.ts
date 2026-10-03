import { normalizeTransaction } from "#src/normalize/transaction.js";

import { RECEIVED_AT, context, fixturePayload, itemsOf, only, records } from "./helpers.js";

function transaction(payload: unknown) {
  return only(itemsOf(records(normalizeTransaction(payload, context())), "transaction"));
}

describe("normalizeTransaction", () => {
  it("normalizes the static-lifecycle fixture", () => {
    const item = transaction(fixturePayload("node-transaction", "transaction"));
    expect(item).toMatchObject({
      id: "id-0001",
      kind: "transaction",
      itemType: "transaction",
      level: null,
      issueId: null,
      eventId: "b268d739558a415891349fb6c1620f5b",
      traceId: "b72a14fa3ca14868a2551df43a2d9bc4",
      title: "my-transaction",
      environment: "production",
      platform: "node",
    });
    expect(item.data).toMatchObject({
      name: "my-transaction",
      op: "test",
      status: "ok",
      spanId: "8d2d12e18699096e",
      parentSpanId: null,
    });
    expect(item.data.durationMs).toBeGreaterThan(0);
    expect(item.data.spans).toEqual([
      {
        spanId: "917ae37752f95a62",
        parentSpanId: "8d2d12e18699096e",
        op: "test.child",
        description: "child",
        status: "ok",
        startTimestamp: "2026-10-03T09:52:43.221Z",
        durationMs: expect.any(Number),
      },
    ]);
    expect(item.data.spans[0]?.durationMs).toBeGreaterThan(0);
    expect(item.data.sdk?.name).toBe("sentry.javascript.node");
  });

  it("falls back for missing timestamps and names", () => {
    const item = transaction({ timestamp: 1_727_950_000.5 });
    expect(item.timestamp).toBe("2024-10-03T10:06:40.500Z");
    expect(item.data.startTimestamp).toBe("2024-10-03T10:06:40.500Z");
    expect(item.data.durationMs).toBe(0);
    expect(item.data.name).toBe("<unnamed transaction>");
    expect(item.title).toBe("<unnamed transaction>");

    const empty = transaction({});
    expect(empty.timestamp).toBe(RECEIVED_AT);
    expect(empty.data.startTimestamp).toBe(RECEIVED_AT);
    expect(empty.data).toMatchObject({
      tags: {},
      contexts: {},
      request: null,
      sdk: null,
      spans: [],
    });
  });

  it("computes duration and clamps negative values", () => {
    expect(transaction({ start_timestamp: 10, timestamp: 10.25 }).data.durationMs).toBe(250);
    expect(transaction({ start_timestamp: 11, timestamp: 10 }).data.durationMs).toBe(0);
  });

  it("skips invalid spans and measurements", () => {
    const item = transaction({
      start_timestamp: 10,
      timestamp: 11,
      spans: [{ span_id: "a", start_timestamp: 10, timestamp: 10.5 }, { op: "no id" }, 3],
      measurements: {
        fcp: { value: 12, unit: "millisecond" },
        lcp: { value: 3 },
        bad: { unit: "x" },
      },
    });
    expect(item.data.spans).toEqual([
      {
        spanId: "a",
        parentSpanId: null,
        op: null,
        description: null,
        status: null,
        startTimestamp: "1970-01-01T00:00:10.000Z",
        durationMs: 500,
      },
    ]);
    expect(item.data.measurements).toEqual({
      fcp: { value: 12, unit: "millisecond" },
      lcp: { value: 3, unit: null },
    });
  });

  it("reports dropped fields", () => {
    const [result] = records(normalizeTransaction({ tags: 5, transaction: "t" }, context()));
    expect(result?.warnings).toEqual(["transaction: dropped invalid field 'tags'"]);
  });

  it.each([["x"], [null], [[]]])("rejects payload %j", (payload) => {
    expect(normalizeTransaction(payload, context()).ok).toBe(false);
  });
});
