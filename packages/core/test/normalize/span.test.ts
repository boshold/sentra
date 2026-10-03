import { normalizeSpans } from "#src/normalize/span.js";

import { RECEIVED_AT, context, fixtureItem, fixturePayload, itemsOf, records } from "./helpers.js";

describe("normalizeSpans", () => {
  it("expands the streamed span fixture", () => {
    const item = fixtureItem("node-spans", "span");
    const newItems = records(normalizeSpans(fixturePayload("node-spans", "span"), context()));
    const spans = itemsOf(newItems, "span");
    expect(spans).toHaveLength(Number(item.header.item_count));
    expect(spans.map((span) => span.id)).toEqual(["id-0001", "id-0002"]);
    expect(spans.filter((span) => span.data.isSegment)).toHaveLength(1);
    expect(new Set(spans.map((span) => span.traceId))).toEqual(
      new Set(["562d24d893fd4aca980ce9017342903d"]),
    );
    const [child] = spans;
    expect(child).toMatchObject({
      kind: "span",
      itemType: "span",
      level: null,
      eventId: null,
      issueId: null,
      platform: null,
      title: "child",
      environment: "production",
      release: null,
    });
    expect(child?.data).toMatchObject({
      name: "child",
      spanId: "9278a02e45167281",
      parentSpanId: "82fccdc3074427e8",
      isSegment: false,
      status: "ok",
      op: "test.child",
    });
    expect(child?.data.durationMs).toBeGreaterThan(0);
    expect(child?.data.attributes["sentry.is_localhost"]).toBe(false);
    expect(child?.timestamp).toBe("2026-10-03T09:52:42.724Z");
  });

  it("parses unknown versions and ignores extra fields", () => {
    const newItems = records(
      normalizeSpans(
        { version: 3, ingest_settings: { infer_ip: "auto" }, items: [{ span_id: "a", name: "n" }] },
        context(),
      ),
    );
    expect(itemsOf(newItems, "span")).toHaveLength(1);
  });

  it("falls back when end_timestamp is missing", () => {
    const [span] = itemsOf(
      records(normalizeSpans({ items: [{ span_id: "a", start_timestamp: 10 }] }, context())),
      "span",
    );
    expect(span?.timestamp).toBe(RECEIVED_AT);
    expect(span?.data).toMatchObject({
      name: "<unnamed span>",
      durationMs: 0,
      isSegment: false,
      op: null,
      startTimestamp: "1970-01-01T00:00:10.000Z",
    });
  });

  it("falls back to timestamp for a missing start_timestamp and reads release", () => {
    const [span] = itemsOf(
      records(
        normalizeSpans(
          {
            items: [
              {
                span_id: "a",
                end_timestamp: 10,
                attributes: { "sentry.release": { value: "1.2.3", type: "string" } },
              },
            ],
          },
          context(),
        ),
      ),
      "span",
    );
    expect(span?.data.startTimestamp).toBe("1970-01-01T00:00:10.000Z");
    expect(span?.release).toBe("1.2.3");
  });

  it("turns invalid entries into other records and keeps the rest", () => {
    const newItems = records(
      normalizeSpans(
        { items: [{ span_id: "a" }, 5, { name: "no id" }, { span_id: "b" }] },
        context(),
      ),
    );
    expect(newItems.map(({ item }) => item.kind)).toEqual(["span", "other", "other", "span"]);
    const others = itemsOf(newItems, "other");
    expect(others.map((other) => other.itemType)).toEqual(["span", "span"]);
    expect(others[0]?.data).toMatchObject({ payloadEncoding: "json", payload: 5, size: 1 });
    expect(others[1]?.data.normalizeError).toBe("span entry has no string span_id");
  });

  it.each([[{ version: 2 }], [{ items: "x" }], ["x"]])("rejects container %j", (payload) => {
    expect(normalizeSpans(payload, context()).ok).toBe(false);
  });
});
