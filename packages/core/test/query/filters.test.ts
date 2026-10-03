import { SentraValidationError } from "#src/errors.js";
import { encodeCursor } from "#src/query/cursor.js";
import {
  itemFilterSchema,
  resolveIssueFilter,
  resolveItemFilter,
  resolveLiveFilter,
  resolvePage,
  resolveScopeFilter,
  resolveScopeTimeFilter,
} from "#src/query/filters.js";

const NOW = 1_000_000_000_000;

function caught(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error("expected an error");
}

function expectCode(fn: () => unknown, code: string): SentraValidationError {
  const error = caught(fn);
  if (!(error instanceof SentraValidationError)) {
    throw new Error(`expected SentraValidationError, got ${String(error)}`);
  }
  expect(error.code).toBe(code);
  return error;
}

describe("resolveItemFilter", () => {
  it("treats undefined as {}", () => {
    expect(resolveItemFilter(undefined, NOW)).toEqual({});
    expect(resolveItemFilter({}, NOW)).toEqual({});
  });

  it("resolves since to from", () => {
    expect(resolveItemFilter({ since: "60m" }, NOW)).toEqual({ from: NOW - 3_600_000 });
  });

  it("resolves ISO and epoch dates", () => {
    expect(resolveItemFilter({ from: "2026-10-03T10:00:00Z", to: 5 }, NOW)).toEqual({
      from: Date.parse("2026-10-03T10:00:00Z"),
      to: 5,
    });
  });

  it("normalizes lists, eventId and empty values", () => {
    expect(
      resolveItemFilter(
        {
          project: "p",
          session: ["s1", "s2"],
          service: [],
          kind: "error",
          level: ["error", "fatal"],
          minLevel: "warning",
          itemType: "event",
          environment: "dev",
          release: ["1"],
          eventId: "5DE6E5B4-C2D5-4107-B369-E4AD5A6909CD",
          issueId: "0123456789abcdef",
          traceId: "t",
          q: "",
        },
        NOW,
      ),
    ).toEqual({
      project: ["p"],
      session: ["s1", "s2"],
      kind: ["error"],
      level: ["error", "fatal"],
      minLevel: "warning",
      itemType: ["event"],
      environment: ["dev"],
      release: ["1"],
      eventId: "5de6e5b4c2d54107b369e4ad5a6909cd",
      issueId: "0123456789abcdef",
      traceId: "t",
    });
  });

  it("uses Date.now() by default", () => {
    const before = Date.now();
    const from = resolveItemFilter({ since: "1s" }).from ?? 0;
    expect(from).toBeGreaterThanOrEqual(before - 1000);
    expect(from).toBeLessThanOrEqual(Date.now() - 1000);
  });

  it.each([
    [{ from: 1, since: "1h" }],
    [{ since: "5x" }],
    [{ since: "never" }],
    [{ from: "not a date" }],
    [{ to: Number.NaN }],
    [{ kind: ["error", "nope"] }],
    [{ level: "loud" }],
    [{ minLevel: "warn" }],
    [{ project: 5 }],
    [{ service: ["a", 1] }],
    [{ sevice: "x" }],
    ["text"],
    [[]],
  ])("rejects %j with invalid_filter", (input) => {
    const error = expectCode(() => resolveItemFilter(input, NOW), "invalid_filter");
    expect(Array.isArray(error.details)).toBe(true);
    expect(error.details).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: expect.any(String) })]),
    );
  });

  it("reports since/from on the since path", () => {
    const error = expectCode(
      () => resolveItemFilter({ from: 1, since: "1h" }, NOW),
      "invalid_filter",
    );
    expect(error.details).toEqual([expect.objectContaining({ path: ["since"] })]);
  });

  it("exposes a schema accepting the public input", () => {
    expect(itemFilterSchema.safeParse({ kind: ["log"], since: "2h" }).success).toBe(true);
  });
});

describe("resolveIssueFilter", () => {
  it("resolves fields", () => {
    expect(
      resolveIssueFilter({ kind: "message", service: "web", since: "1h", q: "Boom" }, NOW),
    ).toEqual({
      kind: ["message"],
      service: ["web"],
      q: "Boom",
      from: NOW - 3_600_000,
    });
  });

  it.each([[{ kind: "log" }], [{ itemType: "event" }]])("rejects %j", (input) => {
    expectCode(() => resolveIssueFilter(input, NOW), "invalid_filter");
  });
});

describe("resolveLiveFilter", () => {
  it("resolves item fields", () => {
    expect(resolveLiveFilter({ kind: "log", minLevel: "info" })).toEqual({
      kind: ["log"],
      minLevel: "info",
    });
  });

  it.each([[{ since: "1h" }], [{ from: 1 }], [{ to: 1 }]])("rejects time field %j", (input) => {
    expectCode(() => resolveLiveFilter(input), "invalid_filter");
  });
});

describe("resolveScopeFilter / resolveScopeTimeFilter", () => {
  it("resolves scope", () => {
    expect(resolveScopeFilter({ project: "p", session: [] })).toEqual({ project: ["p"] });
    expectCode(() => resolveScopeFilter({ since: "1h" }), "invalid_filter");
  });

  it("resolves scope and time", () => {
    expect(resolveScopeTimeFilter({ service: "s", since: "1s" }, NOW)).toEqual({
      service: ["s"],
      from: NOW - 1000,
    });
    expectCode(() => resolveScopeTimeFilter({ kind: "error" }, NOW), "invalid_filter");
  });
});

describe("resolvePage", () => {
  it.each([
    [undefined, { limit: 50, cursor: null }],
    [{}, { limit: 50, cursor: null }],
    [{ limit: 9999 }, { limit: 500, cursor: null }],
    [{ limit: 0 }, { limit: 1, cursor: null }],
    [{ limit: -5 }, { limit: 1, cursor: null }],
    [
      { limit: 20, cursor: encodeCursor("abc") },
      { limit: 20, cursor: "abc" },
    ],
  ])("resolves %j", (input, expected) => {
    expect(resolvePage(input)).toEqual(expected);
  });

  it.each([[{ limit: 1.5 }], [{ limit: "10" }], [{ page: 2 }]])(
    "rejects %j with invalid_filter",
    (input) => {
      expectCode(() => resolvePage(input), "invalid_filter");
    },
  );

  it.each(["%%%", ""])("rejects cursor %j with invalid_cursor", (cursor) => {
    expectCode(() => resolvePage({ cursor }), "invalid_cursor");
  });
});
