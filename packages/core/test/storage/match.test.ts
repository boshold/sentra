import {
  matchesEnvelopeFilter,
  matchesIssueFilter,
  matchesItemFilter,
  matchesScope,
} from "#src/storage/match.js";
import type {
  ResolvedIssueFilter,
  ResolvedItemFilter,
  ResolvedScopeTimeFilter,
} from "#src/storage/types.js";
import { LEVELS } from "#src/types.js";
import type { Envelope, Issue, ItemSummary, Level, Scope, ScopeFilter } from "#src/types.js";

const TS = "2026-10-03T10:00:00.000Z";
const TS_MS = Date.parse(TS);

function summary(overrides: Partial<ItemSummary> = {}): ItemSummary {
  return {
    id: "id-1",
    envelopeId: "env-1",
    scope: { project: "p", session: "s", service: "web" },
    kind: "error",
    itemType: "event",
    receivedAt: TS,
    timestamp: TS,
    eventId: "5de6e5b4c2d54107b369e4ad5a6909cd",
    issueId: "0123456789abcdef",
    traceId: "trace-1",
    level: "error",
    environment: "dev",
    release: "1.0",
    platform: "node",
    title: "TypeError: x",
    ...overrides,
  };
}

function issue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "0123456789abcdef",
    shortId: "01234567",
    project: "p",
    session: "s",
    fingerprint: ["a"],
    fingerprintHash: "h",
    kind: "error",
    title: "TypeError: x",
    culprit: null,
    level: "error",
    platform: "node",
    count: 1,
    firstSeenAt: TS,
    lastSeenAt: TS,
    lastItemId: "id-1",
    services: ["web", "api"],
    ...overrides,
  };
}

function envelope(overrides: Partial<Omit<Envelope, "body">> = {}): Omit<Envelope, "body"> {
  return {
    id: "env-1",
    scope: { project: "p", session: "s", service: "web" },
    receivedAt: TS,
    header: {},
    size: 1,
    contentEncoding: null,
    itemCount: 0,
    parseError: "bad",
    parseWarnings: [],
    ...overrides,
  };
}

describe("matchesScope", () => {
  const scope: Scope = { project: "default", session: "default", service: "default" };

  it.each<[ScopeFilter, boolean]>([
    [{}, true],
    [{ project: "default" }, true],
    [{ project: ["x", "default"], session: "default", service: ["default"] }, true],
    [{ project: [] }, true],
    [{ project: "x" }, false],
    [{ service: ["a", "b"] }, false],
    [{ project: "Default" }, false],
  ])("%j → %j", (filter, expected) => {
    expect(matchesScope(scope, filter)).toBe(expected);
  });
});

describe("matchesItemFilter", () => {
  it.each<[ResolvedItemFilter, boolean]>([
    [{}, true],
    [{ project: ["p"] }, true],
    [{ project: ["q"] }, false],
    [{ session: ["s", "t"] }, true],
    [{ service: ["api"] }, false],
    [{ kind: ["error", "message"] }, true],
    [{ kind: ["log"] }, false],
    [{ itemType: ["event"] }, true],
    [{ itemType: ["log"] }, false],
    [{ level: ["error"] }, true],
    [{ level: ["info"] }, false],
    [{ environment: ["dev"] }, true],
    [{ environment: ["prod"] }, false],
    [{ release: ["1.0"] }, true],
    [{ release: ["2.0"] }, false],
    [{ eventId: "5de6e5b4c2d54107b369e4ad5a6909cd" }, true],
    [{ eventId: "other" }, false],
    [{ issueId: "0123456789abcdef" }, true],
    [{ issueId: "fedcba9876543210" }, false],
    [{ traceId: "trace-1" }, true],
    [{ traceId: "trace-2" }, false],
    [{ q: "typeerror" }, true],
    [{ q: "TYPEERROR: X" }, true],
    [{ q: "rangeerror" }, false],
    [{ from: TS_MS, to: TS_MS }, true],
    [{ from: TS_MS + 1 }, false],
    [{ to: TS_MS - 1 }, false],
    [{ project: ["p"], kind: ["error"], q: "type", minLevel: "warning" }, true],
    [{ project: ["p"], kind: ["error"], q: "type", minLevel: "fatal" }, false],
  ])("%j → %j", (filter, expected) => {
    expect(matchesItemFilter(summary(), filter)).toBe(expected);
  });

  it("does not match null fields when the filter is set", () => {
    const item = summary({
      environment: null,
      release: null,
      eventId: null,
      issueId: null,
      traceId: null,
      level: null,
    });
    expect(matchesItemFilter(item, { environment: ["dev"] })).toBe(false);
    expect(matchesItemFilter(item, { release: ["1.0"] })).toBe(false);
    expect(matchesItemFilter(item, { eventId: "x" })).toBe(false);
    expect(matchesItemFilter(item, { issueId: "x" })).toBe(false);
    expect(matchesItemFilter(item, { traceId: "x" })).toBe(false);
    expect(matchesItemFilter(item, { level: ["info"] })).toBe(false);
    expect(matchesItemFilter(item, {})).toBe(true);
  });

  it.each<[Level | null, boolean]>([
    ["trace", false],
    ["debug", false],
    ["info", false],
    ["warning", true],
    ["error", true],
    ["fatal", true],
    [null, false],
  ])("minLevel warning against %j → %j", (level, expected) => {
    expect(matchesItemFilter(summary({ level }), { minLevel: "warning" })).toBe(expected);
  });

  it("combines level and minLevel", () => {
    expect(
      LEVELS.filter((level) =>
        matchesItemFilter(summary({ level }), { level: ["debug", "error"], minLevel: "info" }),
      ),
    ).toEqual(["error"]);
  });
});

describe("matchesIssueFilter", () => {
  it.each<[ResolvedIssueFilter, boolean]>([
    [{}, true],
    [{ project: ["p"], session: ["s"] }, true],
    [{ session: ["other"] }, false],
    [{ service: ["api"] }, true],
    [{ service: ["worker", "web"] }, true],
    [{ service: ["worker"] }, false],
    [{ kind: ["message"] }, false],
    [{ kind: ["error"] }, true],
    [{ level: ["error"] }, true],
    [{ minLevel: "fatal" }, false],
    [{ q: "TYPEERROR" }, true],
    [{ q: "nope" }, false],
    [{ from: TS_MS, to: TS_MS }, true],
    [{ from: TS_MS + 1 }, false],
  ])("%j → %j", (filter, expected) => {
    expect(matchesIssueFilter(issue(), filter)).toBe(expected);
  });

  it("applies time bounds to lastSeenAt", () => {
    const old = issue({ firstSeenAt: "2026-10-01T00:00:00.000Z", lastSeenAt: TS });
    expect(matchesIssueFilter(old, { from: TS_MS })).toBe(true);
    expect(matchesIssueFilter(old, { to: TS_MS - 1 })).toBe(false);
  });
});

describe("matchesEnvelopeFilter", () => {
  it.each<[ResolvedScopeTimeFilter, boolean]>([
    [{}, true],
    [{ project: ["p"], service: ["web"] }, true],
    [{ service: ["api"] }, false],
    [{ from: TS_MS, to: TS_MS }, true],
    [{ to: TS_MS - 1 }, false],
  ])("%j → %j", (filter, expected) => {
    expect(matchesEnvelopeFilter(envelope(), filter)).toBe(expected);
  });
});
