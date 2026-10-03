import { normalizeOther } from "#src/normalize/other.js";

import { RECEIVED_AT, context, fixtureItem, rawItem } from "./helpers.js";

describe("normalizeOther", () => {
  it.each([
    ["node-session-1", "session", "2026-10-03T09:52:46.886Z"],
    ["node-client-report-2", "client_report", "2026-10-03T09:52:47.404Z"],
  ])("normalizes the %s fixture as json", (name, type, timestamp) => {
    const { item, blob } = normalizeOther(fixtureItem(name, type), context());
    expect(blob).toBeNull();
    expect(item).toMatchObject({
      kind: "other",
      itemType: type,
      title: type,
      level: null,
      timestamp,
      data: { payloadEncoding: "json", normalizeError: null },
    });
  });

  it("reads event_id from JSON objects", () => {
    const { item } = normalizeOther(
      rawItem("feedback", '{"event_id":"5de6e5b4c2d54107b369e4ad5a6909cd"}'),
      context(),
    );
    expect(item.eventId).toBe("5de6e5b4c2d54107b369e4ad5a6909cd");
    expect(item.timestamp).toBe(RECEIVED_AT);
  });

  it("keeps JSON non-objects without timestamp", () => {
    const { item } = normalizeOther(rawItem("x", "[1,2]"), context());
    expect(item).toMatchObject({
      timestamp: RECEIVED_AT,
      eventId: null,
      data: { payload: [1, 2], size: 5 },
    });
  });

  it("detects plain text", () => {
    const { item, blob } = normalizeOther(rawItem("statsd", "metric:1|c"), context());
    expect(blob).toBeNull();
    expect(item).toMatchObject({
      data: { payloadEncoding: "text", payload: "metric:1|c", size: 10 },
    });
  });

  it("stores binary payloads as blob", () => {
    const payload = new Uint8Array([0xff, 0xfe]);
    const { item, blob } = normalizeOther(rawItem("profile_chunk", payload), context());
    expect(blob).toEqual(payload);
    expect(item).toMatchObject({ data: { payloadEncoding: "binary", payload: null, size: 2 } });
  });

  it("sets normalizeError when given", () => {
    const { item } = normalizeOther(rawItem("event", "nope"), context(), "bad");
    expect(item).toMatchObject({
      itemType: "event",
      data: { normalizeError: "bad", payloadEncoding: "text" },
    });
  });
});
