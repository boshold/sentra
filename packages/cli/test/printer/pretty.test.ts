import { PassThrough } from "node:stream";

import type { Item, LiveEvent } from "@bosdev/sentra-core";

import { formatLiveEvent } from "#src/printer/pretty.js";

import {
  created,
  eventData,
  fixtureEvents,
  frame,
  logItem,
  otherItem,
  spanItem,
  summary,
} from "./events.js";

const plain = { color: false };

beforeAll(() => {
  process.env.TZ = "UTC";
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function errorEvent(overrides: Partial<Item> = {}): LiveEvent {
  return created(
    {
      ...summary({
        kind: "error",
        itemType: "event",
        level: "error",
        title: "TypeError: Cannot read properties of undefined (reading 'id')\nsecond line",
        environment: "development",
        release: "1.2.0",
        scope: { project: "my-app", session: "3f9a1c", service: "web" },
        ...overrides,
      }),
      kind: "error",
      data: eventData({
        exceptions: [
          {
            type: "Error",
            value: "cause",
            module: null,
            mechanism: null,
            frames: [frame({ function: "ignored" })],
          },
          {
            type: "TypeError",
            value: "Cannot read properties of undefined (reading 'id')",
            module: null,
            mechanism: null,
            frames: [
              ...Array.from({ length: 6 }, () =>
                frame({ inApp: false, function: "lib", filename: "node_modules/x.js" }),
              ),
              frame({
                function: "setup",
                filename: "components/User/Profile/Card.vue",
                lineno: 12,
                colno: 5,
              }),
              frame({
                function: "loadUser",
                filename: "components/User/Profile/Card.vue",
                lineno: 42,
                colno: 13,
              }),
            ],
          },
        ],
      }),
    },
    { id: "7c2f91ab0000aaaa", isNew: false, count: 3 },
  );
}

describe("formatLiveEvent", () => {
  it("renders an error block", () => {
    expect(formatLiveEvent(errorEvent(), plain)).toEqual([
      "14:03:21 ERROR my-app/3f9a1c/web  TypeError: Cannot read properties of undefined (reading 'id')",
      "  at loadUser  components/User/Profile/Card.vue:42:13",
      "  at setup     components/User/Profile/Card.vue:12:5",
      "  … 6 more frames (library)",
      "  issue 7c2f91ab · 3× · env development · release 1.2.0",
    ]);
  });

  it("marks new issues and skips missing footer parts", () => {
    const event = errorEvent({ environment: null, release: null });
    const lines =
      event.type === "item.created"
        ? formatLiveEvent(
            { ...event, issue: { id: "abcdef0123456789", isNew: true, count: 1 } },
            plain,
          )
        : [];
    expect(lines.at(-1)).toBe("  issue abcdef01 NEW · 1×");
    const noIssue =
      event.type === "item.created" ? formatLiveEvent({ ...event, issue: null }, plain) : [];
    expect(noIssue.at(-1)).toMatch(/^ {2}… 6 more frames/);
  });

  it("renders fixture errors", async () => {
    const events = await fixtureEvents(["node-error"], "/my-app/3f9a1c/web/api/1/envelope/");
    const [event] = events;
    if (event === undefined) {
      throw new Error("no event");
    }
    const lines = formatLiveEvent(event, plain);
    expect(lines[0]).toMatch(/^\d{2}:\d{2}:\d{2} ERROR my-app\/3f9a1c\/web {2}Error: boom$/);
    expect(lines.filter((entry) => entry.startsWith("  at ")).length).toBeLessThanOrEqual(5);
    expect(lines.at(-1)).toMatch(/^ {2}issue [0-9a-f]{8}(?: NEW)? · \d+×/);
  });

  it("uses the stacktrace for messages and the ~ marker for unreliable frames", () => {
    const event = created(
      {
        ...summary({ kind: "message", itemType: "event", level: null, title: "hello" }),
        kind: "message",
        data: eventData({
          stacktrace: [
            frame({
              function: "render",
              absPath: "/app/pages/index.vue",
              lineno: 10,
              colno: 3,
              positionReliable: false,
            }),
          ],
        }),
      },
      null,
    );
    expect(formatLiveEvent(event, plain)).toEqual([
      "14:03:21 INFO  my-app/3f9a1c/api  hello",
      "  at render  /app/pages/index.vue:~10:3",
    ]);
  });

  it("renders TXN, log, ITEM and BAD lines", () => {
    const transaction = created({
      ...summary({ kind: "transaction", itemType: "transaction" }),
      kind: "transaction",
      data: {
        name: "GET /api/users",
        op: "http.server",
        status: "ok",
        startTimestamp: "2026-10-03T14:03:21.000Z",
        durationMs: 142,
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
    expect(formatLiveEvent(transaction, plain)).toEqual([
      "14:03:21 TXN   my-app/3f9a1c/api  GET /api/users  142ms  ok",
    ]);
    const span = spanItem(true);
    const spanNoStatus =
      span.kind === "span"
        ? { ...span, data: { ...span.data, status: null, durationMs: 1520 } }
        : span;
    expect(formatLiveEvent(created(spanNoStatus), plain)).toEqual([
      "14:03:21 TXN   my-app/3f9a1c/api  GET /api/users  1.52s",
    ]);
    expect(
      formatLiveEvent(created(logItem({ userId: 12, "sentry.sdk.name": "x" })), plain),
    ).toEqual(["14:03:21 INFO  my-app/3f9a1c/api  user logged in  {userId: 12}"]);
    expect(formatLiveEvent(created(logItem({ "sentry.only": 1 }, "warning")), plain)).toEqual([
      "14:03:21 WARN  my-app/3f9a1c/api  user logged in",
    ]);
    const long = formatLiveEvent(created(logItem({ text: "x".repeat(300) })), plain)[0] ?? "";
    expect(long.slice(long.indexOf("{"))).toHaveLength(120);
    expect(long.endsWith("…}")).toBe(true);
    expect(formatLiveEvent(created(otherItem("profile", 512)), plain)).toEqual([
      "14:03:21 ITEM  my-app/3f9a1c/api  profile 512 B",
    ]);
    expect(formatLiveEvent(created(otherItem("replay", 1229)), plain)[0]).toBe(
      "14:03:21 ITEM  my-app/3f9a1c/api  replay 1.2 KB",
    );
    expect(formatLiveEvent(created(otherItem("replay", 3_565_158)), plain)[0]).toBe(
      "14:03:21 ITEM  my-app/3f9a1c/api  replay 3.4 MB",
    );
    const failed: LiveEvent = {
      type: "envelope.failed",
      envelope: {
        id: "01J0ENV",
        scope: { project: "my-app", session: "default", service: "web" },
        receivedAt: "2026-10-03T14:03:23.000Z",
        header: {},
        size: 3,
        contentEncoding: null,
        itemCount: 0,
        parseError: "bad header",
        parseWarnings: [],
      },
      error: "bad header",
    };
    expect(formatLiveEvent(failed, plain)).toEqual([
      "14:03:23 BAD   my-app/web  invalid envelope: bad header (envelope 01J0ENV)",
    ]);
  });

  it("uses level labels", () => {
    const labels = (["fatal", "error", "warning", "info", "debug", "trace"] as const).map((level) =>
      (formatLiveEvent(created(logItem({}, level)), plain)[0] ?? "").slice(9, 14),
    );
    expect(labels).toEqual(["FATAL", "ERROR", "WARN ", "INFO ", "DEBUG", "TRACE"]);
  });

  it("strips control characters from titles", () => {
    const lines = formatLiveEvent(errorEvent({ title: "\u001b[2Jboom\u0007" }), plain);
    expect(lines.join("\n")).not.toContain("\u001b");
    expect(lines[0]).toContain("  boom");
  });

  it("honors color settings", () => {
    const stream = new PassThrough();
    expect(formatLiveEvent(errorEvent(), { color: false, stream }).join("\n")).not.toContain(
      "\u001b",
    );
    vi.stubEnv("NO_COLOR", undefined);
    vi.stubEnv("FORCE_COLOR", "1");
    const colored = formatLiveEvent(errorEvent(), { color: true, stream })[0] ?? "";
    expect(colored).toContain("\u001b[31mERROR\u001b[39m");
    vi.stubEnv("FORCE_COLOR", undefined);
    vi.stubEnv("NO_COLOR", "1");
    expect(formatLiveEvent(errorEvent(), { color: true, stream }).join("\n")).not.toContain(
      "\u001b",
    );
  });
});
