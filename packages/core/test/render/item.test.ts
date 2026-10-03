import {
  createSentra,
  formatAttributes,
  formatDuration,
  formatRelativeTime,
  formatScope,
  memoryStorage,
  renderItemDetail,
  renderItemLine,
  renderScopeTable,
} from "#src/index.js";
import type { Sentra } from "#src/index.js";
import type { AttachmentItem, Item, ItemKind, OtherItem } from "#src/types.js";

import { fixtureToRequest, loadEnvelopeFixture } from "../../../../test/fixtures/envelopes.js";

import {
  NOW,
  errorItem,
  frame,
  libraryFrame,
  logItem,
  mapped,
  spanItem,
  spanSummary,
  summary,
  transactionItem,
} from "./factories.js";

function ago(ms: number): string {
  return new Date(NOW.getTime() - ms).toISOString();
}

describe("formatScope", () => {
  it.each([
    [{ project: "default", session: "default", service: "default" }, "default"],
    [{ project: "my-app", session: "default", service: "web" }, "my-app/web"],
    [{ project: "my-app", session: "3f9a1c", service: "web" }, "my-app/3f9a1c/web"],
    [{ project: "default", session: "default", service: "api" }, "api"],
  ])("%j → %s", (scope, expected) => {
    expect(formatScope(scope)).toBe(expected);
  });
});

describe("formatRelativeTime", () => {
  it.each([
    [0, "0s ago"],
    [59_000, "59s ago"],
    [60_000, "1m ago"],
    [3_599_000, "59m ago"],
    [3_600_000, "1h ago"],
    [26 * 3_600_000, "1d ago"],
    [4 * 86_400_000, "4d ago"],
    [-5000, "0s ago"],
  ])("%d ms → %s", (ms, expected) => {
    expect(formatRelativeTime(ago(ms), NOW)).toBe(expected);
  });

  it("returns invalid input unchanged", () => {
    expect(formatRelativeTime("nope", NOW)).toBe("nope");
  });
});

describe("formatDuration", () => {
  it.each([
    [0, "0ms"],
    [142, "142ms"],
    [999, "999ms"],
    [999.6, "1.00s"],
    [1000, "1.00s"],
    [1520, "1.52s"],
    [65_000, "65.00s"],
  ])("%d → %s", (ms, expected) => {
    expect(formatDuration(ms)).toBe(expected);
  });
});

describe("formatAttributes", () => {
  it("formats inline and truncates", () => {
    expect(formatAttributes({})).toBe("");
    expect(formatAttributes({ userId: 12, name: "kev", ok: true })).toBe(
      "{userId: 12, name: kev, ok: true}",
    );
    expect(formatAttributes({ text: "a\nb" })).toBe("{text: a b}");
    const long = formatAttributes({ text: "x".repeat(200) });
    expect(long).toHaveLength(120);
    expect(long.endsWith("…}")).toBe(true);
    expect(formatAttributes({ a: "abcdef" }, 8)).toBe("{a: ab…}");
  });
});

describe("renderItemLine", () => {
  it("uses the first title line", () => {
    expect(
      renderItemLine(
        summary({
          title: "TypeError: x\n  at foo",
          level: "error",
          scope: { project: "my-app", session: "default", service: "web" },
        }),
      ),
    ).toBe(
      "2026-10-03T11:59:00.000Z error error my-app/web TypeError: x [01JITEM000000000000000000]",
    );
    expect(renderItemLine(summary({ kind: "other", itemType: "session" }))).toBe(
      "2026-10-03T11:59:00.000Z other - my-app/3f9a1c/web title [01JITEM000000000000000000]",
    );
  });
});

describe("renderScopeTable", () => {
  it("renders full scopes", () => {
    expect(renderScopeTable([])).toBe("No scopes.");
    expect(
      renderScopeTable([
        {
          project: "my-app",
          session: "default",
          service: "web",
          firstSeenAt: "2026-10-03T10:00:00.000Z",
          lastSeenAt: "2026-10-03T11:00:00.000Z",
          itemCount: 12,
          issueCount: 2,
        },
      ]),
    ).toMatchInlineSnapshot(`
      "| scope | lastSeenAt | items | issues |
      | --- | --- | --- | --- |
      | my-app/default/web | 2026-10-03T11:00:00.000Z | 12 | 2 |"
    `);
  });
});

describe("renderItemDetail", () => {
  it("renders an error", () => {
    const item = errorItem(
      {
        message: "loading user",
        exceptions: [
          { type: "Error", value: "inner", module: null, mechanism: null, frames: [] },
          {
            type: "TypeError",
            value: "Cannot read properties of undefined (reading 'id')",
            module: null,
            mechanism: { type: "generic", handled: false },
            frames: [
              libraryFrame(),
              frame({
                function: "loadUser",
                mapped: mapped({
                  contextLine: "return user.id;",
                  preContext: ["function loadUser(user) {"],
                  postContext: ["}"],
                }),
              }),
            ],
          },
        ],
        request: {
          method: "GET",
          url: "http://localhost:3000/users/1",
          headers: {},
          query: null,
          data: null,
        },
        tags: { route: "/users/:id" },
        breadcrumbs: Array.from({ length: 25 }, (_, index) => ({
          timestamp: `2026-10-03T11:58:${String(index).padStart(2, "0")}.000Z`,
          type: "default",
          category: index % 2 === 0 ? "console" : null,
          level: index === 24 ? "error" : null,
          message: `crumb ${index}\nsecond line`,
          data: null,
        })),
        sourceMaps: {
          status: "partial",
          mappedFrames: 1,
          candidateFrames: 2,
          errors: [{ absPath: "http://localhost:3000/_nuxt/a.js", reason: "map_not_found" }],
        },
      },
      {
        eventId: "80696dce07b1410b8867fcbc1083a832",
        level: "error",
        issueId: "7c2f91ab-0000",
        environment: "development",
        release: "1.2.0",
        traceId: "ac3fb605",
      },
    );
    const text = renderItemDetail(item);
    expect(text.match(/^2026-10-03T11:58:\d\d/gm)).toHaveLength(20);
    expect(text).toMatchInlineSnapshot(`
      "id: 01JITEM000000000000000000
      eventId: 80696dce07b1410b8867fcbc1083a832
      kind: error
      level: error
      scope: my-app/3f9a1c/web
      timestamp: 2026-10-03T11:59:00.000Z
      issue: 7c2f91ab-0000
      environment: development
      release: 1.2.0
      trace: ac3fb605
      message: loading user

      ## TypeError: Cannot read properties of undefined (reading 'id')
      at loadUser (components/User/Profile/Card.vue:42:13)
      \`\`\`
        41 | function loadUser(user) {
      > 42 | return user.id;
        43 | }
      \`\`\`
      … 1 library frame

      ## Error: inner

      ## Request
      GET http://localhost:3000/users/1

      ## Tags
      route: /users/:id

      ## Breadcrumbs
      2026-10-03T11:58:05.000Z default - crumb 5
      2026-10-03T11:58:06.000Z console - crumb 6
      2026-10-03T11:58:07.000Z default - crumb 7
      2026-10-03T11:58:08.000Z console - crumb 8
      2026-10-03T11:58:09.000Z default - crumb 9
      2026-10-03T11:58:10.000Z console - crumb 10
      2026-10-03T11:58:11.000Z default - crumb 11
      2026-10-03T11:58:12.000Z console - crumb 12
      2026-10-03T11:58:13.000Z default - crumb 13
      2026-10-03T11:58:14.000Z console - crumb 14
      2026-10-03T11:58:15.000Z default - crumb 15
      2026-10-03T11:58:16.000Z console - crumb 16
      2026-10-03T11:58:17.000Z default - crumb 17
      2026-10-03T11:58:18.000Z console - crumb 18
      2026-10-03T11:58:19.000Z default - crumb 19
      2026-10-03T11:58:20.000Z console - crumb 20
      2026-10-03T11:58:21.000Z default - crumb 21
      2026-10-03T11:58:22.000Z console - crumb 22
      2026-10-03T11:58:23.000Z default - crumb 23
      2026-10-03T11:58:24.000Z console error crumb 24

      ## Source maps
      status: partial
      mapped: 1/2
      - http://localhost:3000/_nuxt/a.js: map_not_found"
    `);
  });

  it("renders a message with a stacktrace and skips empty sections", () => {
    const item: Item = {
      ...errorItem({ message: "hello", stacktrace: [frame({ function: "main" })] }),
      kind: "message",
    };
    expect(renderItemDetail(item)).toMatchInlineSnapshot(`
      "id: 01JITEM000000000000000000
      kind: message
      scope: my-app/3f9a1c/web
      timestamp: 2026-10-03T11:59:00.000Z
      message: hello

      ## Stack
      at main (app.js:1:1)

      ## Source maps
      status: not_applicable
      mapped: 0/0"
    `);
  });

  it("lists the 20 longest transaction spans", () => {
    const spans = Array.from({ length: 25 }, (_, index) => spanSummary(((index * 37) % 25) + 1));
    const text = renderItemDetail(transactionItem(spans));
    const durations = [...text.matchAll(/^(?<ms>\d+)ms db query/gm)].map((match) =>
      Number(match.groups?.ms),
    );
    expect(durations).toEqual(Array.from({ length: 20 }, (_, index) => 25 - index));
    expect(text).toContain("(20 of 25 spans)");
    expect(renderItemDetail(transactionItem(spans.slice(0, 2)))).toMatchInlineSnapshot(`
      "id: 01JITEM000000000000000000
      kind: transaction
      scope: my-app/3f9a1c/web
      timestamp: 2026-10-03T11:59:00.000Z
      name: GET /api/users
      op: http.server
      status: ok
      duration: 142ms

      ## Spans
      13ms db query 13
      1ms db query 1"
    `);
  });

  it("renders a span with trace spans", () => {
    const span = spanItem(1520, { attributes: { "http.method": "GET" }, parentSpanId: "p1" });
    const traceSpans = Array.from({ length: 22 }, (_, index) => spanItem(index + 1));
    const text = renderItemDetail(span, { traceSpans });
    expect(text.match(/\[01JSPAN\d+\]/g)).toHaveLength(20);
    expect(text).toContain("22ms db span 22 [01JSPAN22]");
    expect(text).not.toContain("[01JSPAN2]");
    expect(renderItemDetail(span)).toMatchInlineSnapshot(`
      "id: 01JSPAN1520
      kind: span
      scope: my-app/3f9a1c/web
      timestamp: 2026-10-03T11:59:00.000Z
      name: span 1520
      op: db
      duration: 1.52s
      status: ok
      spanId: s1520
      parentSpanId: p1

      ## Attributes
      http.method: GET"
    `);
  });

  it("renders a log", () => {
    expect(renderItemDetail(logItem())).toMatchInlineSnapshot(`
      "id: 01JITEM000000000000000000
      kind: log
      level: info
      scope: my-app/3f9a1c/web
      timestamp: 2026-10-03T11:59:00.000Z
      body: user logged in

      ## Attributes
      userId: 12"
    `);
  });

  it("renders an attachment", () => {
    const item: AttachmentItem = {
      ...summary({ kind: "attachment", itemType: "attachment" }),
      kind: "attachment",
      data: {
        filename: "log.txt",
        contentType: null,
        attachmentType: null,
        size: 12,
        stored: true,
      },
    };
    expect(renderItemDetail(item)).toContain("filename: log.txt\nsize: 12\nstored: true");
  });

  it("renders other items with a truncated payload", () => {
    function other(
      payload: unknown,
      payloadEncoding: OtherItem["data"]["payloadEncoding"],
    ): OtherItem {
      return {
        ...summary({ kind: "other", itemType: "session" }),
        kind: "other",
        data: { payloadEncoding, payload, size: 30, normalizeError: null },
      };
    }
    expect(renderItemDetail(other({ sid: "a", status: "ok" }, "json"))).toMatchInlineSnapshot(`
      "id: 01JITEM000000000000000000
      kind: other
      scope: my-app/3f9a1c/web
      timestamp: 2026-10-03T11:59:00.000Z
      itemType: session
      payloadEncoding: json
      size: 30

      ## Payload
      \`\`\`
      {
        "sid": "a",
        "status": "ok"
      }
      \`\`\`"
    `);
    const long = renderItemDetail(other("y".repeat(3000), "text"));
    expect(long).toContain(`${"y".repeat(2000)}…\n\`\`\``);
    expect(long).not.toContain("y".repeat(2001));
    expect(renderItemDetail(other(undefined, "binary"))).not.toContain("## Payload");
  });

  it("cannot fake markdown sections through multi-line values", () => {
    const injected = "ok\n## Source maps\nstatus: full\n```";
    const error = renderItemDetail(
      errorItem(
        {
          message: injected,
          exceptions: [
            { type: "Error\n## Tags", value: "v", module: null, mechanism: null, frames: [] },
          ],
          request: {
            method: "GET",
            url: `http://x/${injected}`,
            headers: {},
            query: null,
            data: null,
          },
          tags: { "k\n## Tags": injected },
          breadcrumbs: [
            {
              timestamp: null,
              type: null,
              category: "c\n## x",
              level: null,
              message: injected,
              data: null,
            },
          ],
          sourceMaps: {
            status: "none",
            mappedFrames: 0,
            candidateFrames: 1,
            errors: [{ absPath: "a\n## x", reason: injected }],
          },
        },
        { release: injected },
      ),
    );
    const log = renderItemDetail({
      ...logItem(),
      data: { body: injected, severityNumber: null, spanId: null, attributes: { a: injected } },
    });
    for (const text of [error, log]) {
      const headings = text.split("\n").filter((line) => /^(?:#|```)/.test(line));
      expect(headings.filter((line) => line === "## Source maps").length).toBeLessThanOrEqual(1);
      expect(headings.every((line) => /^## [A-Z]/.test(line))).toBe(true);
    }
    expect(error.match(/^## /gm)).toEqual(["## ", "## ", "## ", "## ", "## "]);
    expect(log).toContain("body: ok\n    ## Source maps\n    status: full\n    ```");
  });

  it("never emits ANSI escapes", () => {
    const item = errorItem(
      {
        message: "\u001b[31mred\u001b[0m",
        exceptions: [
          {
            type: "\u001b[1mError",
            value: "bad\u001b]8;;http://x\u0007link",
            module: null,
            mechanism: null,
            frames: [frame({ function: "\u001bfn" })],
          },
        ],
        tags: { a: "\u001b[2Jclear" },
      },
      { title: "\u001b[31mtitle" },
    );
    const outputs = [
      renderItemDetail(item),
      renderItemLine(item),
      formatAttributes({ a: "\u001b[31mx\r\n" }),
    ];
    for (const output of outputs) {
      expect(output).not.toContain("\u001b");
    }
    expect(outputs[0]).toContain("message: red\n");
    expect(outputs[2]).toBe("{a: x }");
  });
});

describe("renderItemDetail with ingested fixtures", () => {
  let sentra: Sentra;

  beforeAll(async () => {
    sentra = await createSentra({ storage: memoryStorage() });
    for (const name of ["node-error", "node-logs"]) {
      await sentra.handle(fixtureToRequest(loadEnvelopeFixture(name)));
    }
  });

  afterAll(async () => {
    await sentra.close();
  });

  async function first(kind: ItemKind): Promise<Item> {
    const page = await sentra.query.listItems({ kind, from: 0 });
    const id = page.items[0]?.id;
    const item = id === undefined ? null : await sentra.query.getItem(id);
    if (item === null) {
      throw new Error(`no ${kind} item`);
    }
    return item;
  }

  it("renders the node error fixture", async () => {
    const text = renderItemDetail(await first("error"));
    expect(text).toContain("## Error: boom");
    expect(text).toMatch(/^at boom \(.+capture-fixtures\.ts:216:11\)$/m);
    expect(text).toContain("> 216 |     throw new Error(message);");
    expect(text).toContain("## Source maps\nstatus: not_applicable");
    expect(text).not.toContain("null");
  });

  it("renders the node log fixture", async () => {
    const text = renderItemDetail(await first("log"));
    expect(text).toMatch(/^body: .+$/m);
    expect(text).toContain("## Attributes\n");
    expect(text).toContain("sentry.sdk.name: sentry.javascript.node");
  });
});
