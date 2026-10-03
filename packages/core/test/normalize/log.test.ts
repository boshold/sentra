import { normalizeLogs } from "#src/normalize/log.js";

import { RECEIVED_AT, context, fixturePayload, itemsOf, records } from "./helpers.js";

describe("normalizeLogs", () => {
  it("expands the Node logs fixture", () => {
    const logs = itemsOf(
      records(normalizeLogs(fixturePayload("node-logs", "log"), context())),
      "log",
    );
    expect(logs).toHaveLength(2);
    expect(logs.map((log) => log.level)).toEqual(["info", "warning"]);
    expect(logs.map((log) => log.title)).toEqual(["info log", "templ 42"]);
    const [info, warn] = logs;
    expect(info).toMatchObject({
      kind: "log",
      itemType: "log",
      eventId: null,
      issueId: null,
      platform: null,
      traceId: "c77433900ed84f5e9fd93cbaab10336e",
      timestamp: "2026-10-03T09:52:43.770Z",
    });
    expect(info?.data).toMatchObject({
      body: "info log",
      severityNumber: 9,
      spanId: null,
      attributes: { foo: 1, bar: "b", baz: true, q: 1.5 },
    });
    expect(warn?.data.attributes["sentry.message.template"]).toBe("templ %s");
  });

  it("takes spanId from the parent span attribute", () => {
    const [log] = itemsOf(
      records(normalizeLogs(fixturePayload("browser-logs-spans-1", "log"), context())),
      "log",
    );
    expect(log?.data.spanId).toBe("b5ebd546a44b8856");
  });

  it("prefers entry span_id and reads environment and release", () => {
    const [log] = itemsOf(
      records(
        normalizeLogs(
          {
            version: 2,
            ingest_settings: { infer_ip: "auto" },
            items: [
              {
                body: "b",
                span_id: "s1",
                attributes: {
                  "sentry.trace.parent_span_id": { value: "s2", type: "string" },
                  "sentry.environment": { value: "dev", type: "string" },
                  "sentry.release": { value: "1.0", type: "string" },
                },
              },
            ],
          },
          context(),
        ),
      ),
      "log",
    );
    expect(log).toMatchObject({
      environment: "dev",
      release: "1.0",
      timestamp: RECEIVED_AT,
      level: "info",
    });
    expect(log?.data.spanId).toBe("s1");
  });

  it("truncates long bodies in the title only", () => {
    const [log] = itemsOf(
      records(normalizeLogs({ items: [{ body: "x".repeat(600) }] }, context())),
      "log",
    );
    expect(log?.title).toHaveLength(500);
    expect(log?.data.body).toHaveLength(600);
  });

  it("turns entries without body into other records", () => {
    const newItems = records(
      normalizeLogs({ items: [{ level: "info" }, { body: "ok" }, null] }, context()),
    );
    expect(newItems.map(({ item }) => item.kind)).toEqual(["other", "log", "other"]);
    const [missingBody] = itemsOf(newItems, "other");
    expect(missingBody?.itemType).toBe("log");
    expect(missingBody?.data.normalizeError).toBe("log entry has no string body");
    expect(missingBody?.data.payload).toEqual({ level: "info" });
  });

  it("rejects a container without items", () => {
    expect(normalizeLogs({ version: 2 }, context()).ok).toBe(false);
  });
});
