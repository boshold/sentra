import {
  computeGrouping,
  defaultComponents,
  normPath,
  normalizeText,
} from "#src/grouping/fingerprint.js";
import type { GroupingKind } from "#src/grouping/fingerprint.js";
import type { GroupingInput } from "#src/normalize/types.js";
import type { EventData, Exception, Frame, MappedLocation, Scope } from "#src/types.js";

const SCOPE: Scope = { project: "p", session: "s", service: "web" };
const NO_GROUPING: GroupingInput = { payloadFingerprint: null, messageTemplate: null };

function frame(overrides: Partial<Frame> = {}): Frame {
  return {
    filename: "/src/a.ts",
    absPath: null,
    function: "load",
    module: null,
    lineno: 10,
    colno: 5,
    inApp: true,
    contextLine: null,
    preContext: [],
    postContext: [],
    positionReliable: true,
    mapped: null,
    ...overrides,
  };
}

function mapped(overrides: Partial<MappedLocation> = {}): MappedLocation {
  return {
    source: "components/User/Card.vue",
    absPath: null,
    lineno: 42,
    colno: 3,
    function: "loadUser",
    contextLine: null,
    preContext: [],
    postContext: [],
    ...overrides,
  };
}

function exception(overrides: Partial<Exception> = {}): Exception {
  return {
    type: "TypeError",
    value: "boom",
    module: null,
    mechanism: null,
    frames: [],
    ...overrides,
  };
}

function eventData(overrides: Partial<EventData> = {}): EventData {
  return {
    message: null,
    exceptions: [],
    stacktrace: [],
    culprit: null,
    transaction: null,
    logger: null,
    dist: null,
    serverName: null,
    user: null,
    request: null,
    tags: {},
    contexts: {},
    extra: {},
    breadcrumbs: [],
    sdk: null,
    fingerprint: [],
    sourceMaps: { status: "not_applicable", mappedFrames: 0, candidateFrames: 0, errors: [] },
    ...overrides,
  };
}

function errorWith(frames: Frame[], overrides: Partial<Exception> = {}): EventData {
  return eventData({ exceptions: [exception({ frames, ...overrides })] });
}

function group(
  data: EventData,
  options: { kind?: GroupingKind; grouping?: Partial<GroupingInput>; scope?: Scope } = {},
) {
  return computeGrouping({
    scope: options.scope ?? SCOPE,
    kind: options.kind ?? "error",
    data,
    grouping: { ...NO_GROUPING, ...options.grouping },
  });
}

describe("normalizeText", () => {
  it.each([
    ["id 3f2504e0-4f89-11d3-9a0c-0305e82c3301 gone", "id <id> gone"],
    ["hash deadbeef01", "hash <id>"],
    ["addr 0x1f3a9c00ff", "addr <id>"],
    ["count 42", "count <n>"],
    ["pi 3.14", "pi <n>"],
    ["order 12345678", "order <id>"],
    ["nothing to see", "nothing to see"],
  ])("normalizes %j", (input, expected) => {
    expect(normalizeText(input)).toBe(expected);
  });
});

describe("normPath", () => {
  it.each([
    [frame({ filename: "http://localhost:3000/src/a.ts?t=1#x" }), "/src/a.ts"],
    [frame({ absPath: "http://localhost:3000/src/b.ts", filename: "/x.ts" }), "/src/b.ts"],
    [frame({ filename: "file:///home/u/app/x.mjs" }), "/home/u/app/x.mjs"],
    [frame({ filename: "/abs/x.js" }), "/abs/x.js"],
    [frame({ filename: "/abs/x.js?v=2" }), "/abs/x.js"],
    [frame({ filename: "node:internal/process" }), "node:internal/process"],
    [frame({ filename: null }), "?"],
    [frame({ filename: "file:///home/u/bad%zz/x.mjs" }), "/home/u/bad%zz/x.mjs"],
    [frame({ mapped: mapped() }), "components/User/Card.vue"],
  ])("normalizes %#", (input, expected) => {
    expect(normPath(input)).toBe(expected);
  });
});

describe("normPath decoding", () => {
  it.each([
    ["file:///home/u/my app/x.mjs", "/home/u/my app/x.mjs"],
    ["file:///home/u/my%20app/x.mjs", "/home/u/my app/x.mjs"],
    ["file:///home/u/äpp/größe.mjs", "/home/u/äpp/größe.mjs"],
    ["http://localhost:3000/src/my%20dir/ä.ts?t=1", "/src/my dir/ä.ts"],
  ])("decodes %j to match the plain path", (url, plain) => {
    expect(normPath(frame({ filename: url }))).toBe(plain);
    const fromUrl = defaultComponents("error", errorWith([frame({ filename: url })]), null);
    const fromPlain = defaultComponents("error", errorWith([frame({ filename: plain })]), null);
    expect(fromUrl).toEqual(fromPlain);
  });
});

describe("defaultComponents", () => {
  it("uses type and in-app frames without line numbers", () => {
    const data = errorWith([
      frame({ function: "outer", filename: "/src/main.ts" }),
      frame({ function: "lib", filename: "/node_modules/x.js", inApp: false }),
      frame(),
    ]);
    expect(defaultComponents("error", data, null)).toEqual([
      "TypeError",
      "/src/main.ts:outer",
      "/src/a.ts:load",
    ]);
  });

  it("uses all frames if none is in-app and ? for missing functions", () => {
    const data = errorWith([frame({ inApp: false, function: null }), frame({ inApp: false })]);
    expect(defaultComponents("error", data, null)).toEqual([
      "TypeError",
      "/src/a.ts:?",
      "/src/a.ts:load",
    ]);
  });

  it("uses mapped source and function", () => {
    const data = errorWith([frame({ mapped: mapped() })]);
    expect(defaultComponents("error", data, null)).toEqual([
      "TypeError",
      "components/User/Card.vue:loadUser",
    ]);
  });

  it("uses type and normalized value without frames", () => {
    expect(
      defaultComponents("error", errorWith([], { value: "User 123 not found" }), null),
    ).toEqual(["TypeError", "User <n> not found"]);
    expect(defaultComponents("error", errorWith([], { type: null, value: null }), null)).toEqual([
      "Error",
      "",
    ]);
  });

  it("uses the message template for messages, never frames", () => {
    const data = eventData({ message: "user 12 logged in", stacktrace: [frame()] });
    expect(defaultComponents("message", data, "user %s logged in")).toEqual(["user %s logged in"]);
    expect(defaultComponents("message", data, null)).toEqual(["user <n> logged in"]);
    expect(defaultComponents("message", eventData(), null)).toEqual([""]);
  });
});

describe("computeGrouping", () => {
  it("returns the known-answer hash and issue id", () => {
    const result = group(errorWith([frame()]));
    expect(result.fingerprint).toEqual(["TypeError", "/src/a.ts:load"]);
    expect(result.fingerprintHash).toBe("d25ac587f41d430676363fb246af6124f8791c8b");
    expect(result.issueId).toBe("4b5979e900fc24d9");
  });

  it("ignores line and column changes", () => {
    const a = group(errorWith([frame({ lineno: 10, colno: 5 })]));
    const b = group(errorWith([frame({ lineno: 99, colno: 1 })]));
    expect(b.issueId).toBe(a.issueId);
    expect(a.fingerprint.join(",")).not.toMatch(/10|5/);
  });

  it("splits on a different in-app function name", () => {
    const a = group(errorWith([frame(), frame({ function: "a" })]));
    const b = group(errorWith([frame(), frame({ function: "b" })]));
    expect(b.issueId).not.toBe(a.issueId);
  });

  it("ignores library frames when in-app frames exist", () => {
    const a = group(errorWith([frame({ inApp: false, function: "libA" }), frame()]));
    const b = group(errorWith([frame({ inApp: false, function: "libB" }), frame()]));
    expect(b.issueId).toBe(a.issueId);
  });

  it("keeps the last 30 in-app frames", () => {
    const frames = Array.from({ length: 40 }, (_, index) => frame({ function: `f${index}` }));
    const { fingerprint } = group(errorWith(frames));
    expect(fingerprint).toHaveLength(31);
    expect(fingerprint[1]).toBe("/src/a.ts:f10");
    expect(fingerprint.at(-1)).toBe("/src/a.ts:f39");
  });

  it("groups frameless exceptions by normalized value", () => {
    const a = group(errorWith([], { value: "User 123 not found" }));
    const b = group(errorWith([], { value: "User 456 not found" }));
    const c = group(errorWith([], { value: "Order 123 not found" }));
    expect(b.issueId).toBe(a.issueId);
    expect(c.issueId).not.toBe(a.issueId);
  });

  it("defaults the type to Error", () => {
    expect(group(errorWith([], { type: null })).fingerprint[0]).toBe("Error");
  });

  it("uses a custom fingerprint", () => {
    const a = group(errorWith([frame()]), { grouping: { payloadFingerprint: ["checkout"] } });
    const b = group(errorWith([], { type: "RangeError" }), {
      grouping: { payloadFingerprint: ["checkout"] },
    });
    expect(a.fingerprint).toEqual(["checkout"]);
    expect(b.issueId).toBe(a.issueId);
  });

  it("splices default components into custom fingerprints", () => {
    const data = errorWith([frame()]);
    const spaced = group(data, { grouping: { payloadFingerprint: ["{{ default }}", "tenant-a"] } });
    const compact = group(data, { grouping: { payloadFingerprint: ["{{default}}", "tenant-a"] } });
    expect(spaced.fingerprint).toEqual(["TypeError", "/src/a.ts:load", "tenant-a"]);
    expect(compact.fingerprint).toEqual(spaced.fingerprint);
    expect(compact.issueId).toBe(spaced.issueId);
  });

  it("groups messages by template across call sites", () => {
    const a = group(
      eventData({ message: "user 12 logged in", stacktrace: [frame({ function: "a" })] }),
      {
        kind: "message",
        grouping: { messageTemplate: "user %s logged in" },
      },
    );
    const b = group(
      eventData({ message: "user 99 logged in", stacktrace: [frame({ function: "b" })] }),
      {
        kind: "message",
        grouping: { messageTemplate: "user %s logged in" },
      },
    );
    expect(b.issueId).toBe(a.issueId);
  });

  it("keys issues by project and session, not service", () => {
    const data = errorWith([frame()]);
    const base = group(data);
    expect(group(data, { scope: { ...SCOPE, session: "other" } }).issueId).not.toBe(base.issueId);
    expect(group(data, { scope: { ...SCOPE, service: "api" } }).issueId).toBe(base.issueId);
    expect(group(data, { scope: { ...SCOPE, project: "q" } }).fingerprintHash).toBe(
      base.fingerprintHash,
    );
  });

  describe("culprit", () => {
    it("prefers payload culprit, then transaction", () => {
      const frames = [frame()];
      expect(
        group(eventData({ ...errorWith(frames), culprit: "c", transaction: "t" })).culprit,
      ).toBe("c");
      expect(group(eventData({ ...errorWith(frames), transaction: "t" })).culprit).toBe("t");
    });

    it("treats an empty payload culprit as missing", () => {
      expect(
        group(eventData({ ...errorWith([frame()]), culprit: "", transaction: "t" })).culprit,
      ).toBe("t");
      expect(group(eventData({ ...errorWith([frame()]), culprit: "" })).culprit).toBe(
        "load (/src/a.ts:10)",
      );
    });

    it("uses the crashing in-app frame", () => {
      const data = errorWith([
        frame({ function: "outer", lineno: 3 }),
        frame({ lineno: 7 }),
        frame({ inApp: false, function: "lib" }),
      ]);
      expect(group(data).culprit).toBe("load (/src/a.ts:7)");
    });

    it("falls back to the last frame and omits a missing line", () => {
      const data = errorWith([
        frame({ inApp: false }),
        frame({ inApp: false, function: null, lineno: null }),
      ]);
      expect(group(data).culprit).toBe("? (/src/a.ts)");
    });

    it("prefers mapped values", () => {
      expect(group(errorWith([frame({ mapped: mapped() })])).culprit).toBe(
        "loadUser (components/User/Card.vue:42)",
      );
      expect(group(errorWith([frame({ mapped: mapped({ function: null }) })])).culprit).toBe(
        "load (components/User/Card.vue:42)",
      );
    });

    it("uses the message stacktrace for messages", () => {
      const data = eventData({
        message: "m",
        stacktrace: [frame({ function: "site", lineno: 4 })],
      });
      expect(group(data, { kind: "message" }).culprit).toBe("site (/src/a.ts:4)");
    });

    it("is null without frames", () => {
      expect(group(errorWith([])).culprit).toBeNull();
      expect(group(eventData({ message: "m" }), { kind: "message" }).culprit).toBeNull();
    });
  });

  describe("title", () => {
    it.each([
      [errorWith([]), "TypeError: boom"],
      [errorWith([], { value: null }), "TypeError"],
      [errorWith([], { type: null }), "boom"],
      [errorWith([], { type: null, value: "" }), "<unknown error>"],
      [eventData(), "<unknown error>"],
    ])("error title %#", (data, expected) => {
      expect(group(data).title).toBe(expected);
    });

    it("caps titles at 200 chars", () => {
      expect(group(errorWith([], { value: "x".repeat(300) })).title).toHaveLength(200);
    });

    it.each([
      ["first\nsecond", "first"],
      ["first\r\nsecond", "first"],
      ["", "<unknown error>"],
      ["\nsecond", "second"],
      ["  \r\n\nthird\nfourth", "third"],
      ["\n \n", "<unknown error>"],
    ])("message title for %j", (message, expected) => {
      expect(group(eventData({ message }), { kind: "message" }).title).toBe(expected);
    });
  });
});
