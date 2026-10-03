import type { LiveEvent } from "@bosdev/sentra-core";

import { createLiveFilter } from "#src/printer/filter.js";
import type { LiveFilterOptions } from "#src/printer/filter.js";

import { created, eventData, logItem, otherItem, spanItem, summary } from "./events.js";

const DEFAULTS: LiveFilterOptions = {
  show: ["error", "message", "log"],
  minLevel: null,
  project: null,
  session: null,
  service: null,
};

function passes(event: LiveEvent, options: Partial<LiveFilterOptions> = {}): boolean {
  return createLiveFilter({ ...DEFAULTS, ...options })(event);
}

const error = created({
  ...summary({ kind: "error", itemType: "event", level: "error" }),
  kind: "error",
  data: eventData(),
});
const message = created({
  ...summary({ kind: "message", itemType: "event", level: "info" }),
  kind: "message",
  data: eventData(),
});
const infoLog = created(logItem({}, "info"));
const transaction = created({
  ...summary({ kind: "transaction", itemType: "transaction" }),
  kind: "transaction",
  data: {
    name: "GET /",
    op: null,
    status: null,
    startTimestamp: "2026-10-03T14:03:21.000Z",
    durationMs: 1,
    spanId: null,
    parentSpanId: null,
    spans: [],
    measurements: {},
    tags: {},
    contexts: {},
    request: null,
    sdk: null,
  },
});
const attachment = created({
  ...summary({ kind: "attachment", itemType: "attachment" }),
  kind: "attachment",
  data: { filename: "a.txt", contentType: null, attachmentType: null, size: 1, stored: true },
});
const failed: LiveEvent = {
  type: "envelope.failed",
  envelope: {
    id: "env",
    scope: { project: "x", session: "default", service: "default" },
    receivedAt: "2026-10-03T14:03:21.000Z",
    header: {},
    size: 1,
    contentEncoding: null,
    itemCount: 0,
    parseError: "bad",
    parseWarnings: [],
  },
  error: "bad",
};

describe("createLiveFilter", () => {
  it("uses the default kinds", () => {
    expect([error, message, infoLog].map((event) => passes(event))).toEqual([true, true, true]);
    expect(passes(transaction)).toBe(false);
    expect(passes(attachment)).toBe(false);
    expect(passes(created(otherItem("client_report", 10)))).toBe(false);
  });

  it("passes only segment spans", () => {
    expect(passes(created(spanItem(true)), { show: ["span"] })).toBe(true);
    expect(passes(created(spanItem(false)), { show: ["span"] })).toBe(false);
  });

  it("drops noise other records unless all", () => {
    for (const itemType of ["session", "sessions", "client_report"]) {
      expect(passes(created(otherItem(itemType, 1)), { show: ["other"] })).toBe(false);
      expect(passes(created(otherItem(itemType, 1)), { show: "all" })).toBe(true);
    }
    expect(passes(created(otherItem("profile", 1)), { show: ["other"] })).toBe(true);
    expect(passes(created(spanItem(false)), { show: "all" })).toBe(true);
  });

  it("always passes failed envelopes", () => {
    expect(passes(failed, { show: [], minLevel: "fatal", project: "nope", service: "nope" })).toBe(
      true,
    );
  });

  it("applies minLevel", () => {
    expect(passes(infoLog, { minLevel: "warning" })).toBe(false);
    expect(passes(error, { minLevel: "warning" })).toBe(true);
    expect(passes(created(logItem({}, null)), { minLevel: "trace" })).toBe(false);
    expect(passes(created(logItem({}, null)))).toBe(true);
  });

  it("applies scope flags", () => {
    expect(passes(error, { service: "web" })).toBe(false);
    expect(passes(error, { service: "api" })).toBe(true);
    expect(passes(error, { project: "my-app", session: "3f9a1c" })).toBe(true);
    expect(passes(error, { session: "other" })).toBe(false);
    expect(passes(error, { project: "other" })).toBe(false);
  });
});
