import type { output } from "zod";

import {
  envelopeToRow,
  itemRowSchema,
  itemToRow,
  levelRank,
  rowToEnvelope,
  rowToIssue,
  rowToItem,
  rowToItemSummary,
  rowToScopeSummary,
} from "#src/storage/sqlite/rows.js";
import type { EventData, Frame, Item, ItemKind } from "#src/types.js";

import { makeBatch } from "../../../../../test/storage-contract.js";

const frame: Frame = {
  filename: "app.js",
  absPath: "http://localhost/app.js",
  function: "run",
  module: null,
  lineno: 10,
  colno: 5,
  inApp: true,
  contextLine: "throw err",
  preContext: ["a"],
  postContext: ["b"],
  positionReliable: true,
  mapped: {
    source: "src/app.ts",
    absPath: null,
    lineno: 3,
    colno: null,
    function: "run",
    contextLine: null,
    preContext: [],
    postContext: [],
  },
};

const richEvent: Partial<EventData> = {
  message: "hello",
  exceptions: [
    {
      type: "Error",
      value: "boom",
      module: null,
      mechanism: { type: "onerror", handled: false },
      frames: [frame],
    },
  ],
  stacktrace: [frame],
  user: { id: 1 },
  request: { method: "GET", url: "/x", headers: { a: "b" }, query: "q=1", data: { nested: [1] } },
  tags: { t: "v" },
  breadcrumbs: [
    { timestamp: null, type: "http", category: null, level: "info", message: null, data: null },
  ],
  sdk: { name: "sentry.javascript.node", version: "11.1.0" },
  sourceMaps: {
    status: "partial",
    mappedFrames: 1,
    candidateFrames: 2,
    errors: [{ absPath: "x", reason: "y" }],
  },
};

/** Drops `undefined`-only differences, like the stored JSON. */
function jsonRoundTrip(value: unknown): unknown {
  const text = JSON.stringify(value);
  return JSON.parse(text);
}

const KINDS: ItemKind[] = ["error", "message", "transaction", "span", "log", "attachment", "other"];

function sampleItem(kind: ItemKind): Item {
  const batch = makeBatch({
    items: [
      {
        kind,
        level: "warning",
        environment: "dev",
        release: "1.0",
        platform: "node",
        eventId: "e1",
        traceId: "t1",
        issueId: kind === "error" || kind === "message" ? "00000000000000a1" : null,
        timestamp: "2026-10-01T00:00:01.234Z",
        data: richEvent,
      },
    ],
  });
  const [entry] = batch.items;
  if (!entry) {
    throw new Error("no item");
  }
  return entry.item;
}

describe("item rows", () => {
  it.each(KINDS)("round-trips a %s record", (kind) => {
    const item = sampleItem(kind);
    expect(rowToItem(itemToRow(item))).toEqual(jsonRoundTrip(item));
  });

  it("maps summary rows without data", () => {
    const item = sampleItem("log");
    const { data: _data, ...summary } = item;
    const { data: _rowData, ...row } = itemToRow(item);
    expect(rowToItemSummary(row)).toEqual(summary);
  });

  it("rejects invalid JSON and data that does not match the kind", () => {
    const row = itemToRow(sampleItem("span"));
    expect(() => rowToItem({ ...row, data: "{" })).toThrow(/invalid JSON/);
    expect(() => rowToItem({ ...row, data: "{}" })).toThrow();
    expect(() => rowToItem({ ...row, kind: "nope" })).toThrow();
  });

  it("row data schemas are assignable to the Item data types", () => {
    type Row<K extends ItemKind> = Extract<output<typeof itemRowSchema>, { kind: K }>["data"];
    type Data<K extends ItemKind> = Extract<Item, { kind: K }>["data"];
    expectTypeOf<Row<"error">>().toExtend<Data<"error">>();
    expectTypeOf<Row<"message">>().toExtend<Data<"message">>();
    expectTypeOf<Row<"transaction">>().toExtend<Data<"transaction">>();
    expectTypeOf<Row<"span">>().toExtend<Data<"span">>();
    expectTypeOf<Row<"log">>().toExtend<Data<"log">>();
    expectTypeOf<Row<"attachment">>().toExtend<Data<"attachment">>();
    expectTypeOf<Row<"other">>().toExtend<Data<"other">>();
  });
});

describe("levelRank", () => {
  it("ranks trace to fatal and null", () => {
    expect(
      (["trace", "debug", "info", "warning", "error", "fatal"] as const).map(levelRank),
    ).toEqual([0, 1, 2, 3, 4, 5]);
    expect(levelRank(null)).toBeNull();
  });
});

describe("envelope rows", () => {
  it("round-trips with and without body", () => {
    const withBody = makeBatch({ body: new Uint8Array([0, 10]), parseError: "x" }).envelope;
    expect(rowToEnvelope(envelopeToRow(withBody))).toEqual(withBody);
    const withoutBody = makeBatch({ items: [{}] }).envelope;
    const row = envelopeToRow(withoutBody);
    expect(row.body).toBeNull();
    expect(rowToEnvelope(row)).toEqual(withoutBody);
    expect("body" in rowToEnvelope(row)).toBe(false);
    const { body: _body, ...metaRow } = row;
    expect(rowToEnvelope(metaRow)).toEqual(withoutBody);
  });
});

describe("issue and scope rows", () => {
  it("maps issue rows with services and short id", () => {
    const services = ["api", "web"];
    const issue = rowToIssue(
      {
        id: "00000000000000a1",
        project: "p",
        session: "s",
        kind: "error",
        fingerprint: '["a","b"]',
        fingerprint_hash: "h",
        title: "t",
        culprit: null,
        level: "error",
        platform: "node",
        count: 3,
        first_seen_at: 0,
        last_seen_at: 1000,
        last_item_id: "i",
      },
      services,
    );
    expect(issue).toEqual({
      id: "00000000000000a1",
      shortId: "00000000",
      project: "p",
      session: "s",
      kind: "error",
      fingerprint: ["a", "b"],
      fingerprintHash: "h",
      title: "t",
      culprit: null,
      level: "error",
      platform: "node",
      count: 3,
      firstSeenAt: "1970-01-01T00:00:00.000Z",
      lastSeenAt: "1970-01-01T00:00:01.000Z",
      lastItemId: "i",
      services: ["api", "web"],
    });
    expect(issue.services).not.toBe(services);
  });

  it("maps scope rows", () => {
    expect(
      rowToScopeSummary({
        project: "p",
        session: "s",
        service: "web",
        first_seen_at: 0,
        last_seen_at: 5,
        item_count: 2,
        issue_count: 1,
      }),
    ).toEqual({
      project: "p",
      session: "s",
      service: "web",
      firstSeenAt: "1970-01-01T00:00:00.000Z",
      lastSeenAt: "1970-01-01T00:00:00.005Z",
      itemCount: 2,
      issueCount: 1,
    });
  });
});
