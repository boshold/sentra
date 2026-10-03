import {
  and,
  buildFailedEnvelopeWhere,
  buildIssueWhere,
  buildItemWhere,
  buildScopeWhere,
  escapeLike,
  inList,
  where,
} from "#src/storage/sqlite/queries.js";

describe("escapeLike", () => {
  it("escapes backslash, percent and underscore", () => {
    expect(escapeLike(String.raw`50%_a\b`)).toBe(String.raw`50\%\_a\\b`);
    expect(escapeLike("plain")).toBe("plain");
  });
});

describe("inList / and / where", () => {
  it("builds placeholders and skips empty lists", () => {
    expect(inList("kind", ["a", "b"])).toEqual({ sql: "kind IN (?, ?)", params: ["a", "b"] });
    expect(inList("kind", [])).toEqual({ sql: "", params: [] });
    expect(and(inList("a", ["1"]), inList("b", []), inList("c", ["2"]))).toEqual({
      sql: "a IN (?) AND c IN (?)",
      params: ["1", "2"],
    });
    expect(where({ sql: "", params: [] })).toBe("");
    expect(where({ sql: "x = ?", params: [1] })).toBe("WHERE x = ?");
  });
});

describe("buildScopeWhere", () => {
  it("accepts single values and arrays", () => {
    expect(buildScopeWhere({ project: "p", session: ["s1", "s2"], service: [] })).toEqual({
      sql: "project IN (?) AND session IN (?, ?)",
      params: ["p", "s1", "s2"],
    });
    expect(buildScopeWhere({})).toEqual({ sql: "", params: [] });
  });
});

describe("buildItemWhere", () => {
  it.each([
    [{ project: ["p"] }, "project IN (?)", ["p"]],
    [{ session: ["s"] }, "session IN (?)", ["s"]],
    [{ service: ["web", "api"] }, "service IN (?, ?)", ["web", "api"]],
    [{ kind: ["error" as const] }, "kind IN (?)", ["error"]],
    [{ itemType: ["event"] }, "item_type IN (?)", ["event"]],
    [{ level: ["info" as const] }, "level IN (?)", ["info"]],
    [{ minLevel: "warning" as const }, "level_rank >= ?", [3]],
    [{ environment: ["dev"] }, "environment IN (?)", ["dev"]],
    [{ release: ["1.0"] }, "release IN (?)", ["1.0"]],
    [{ from: 10 }, "timestamp >= ?", [10]],
    [{ to: 20 }, "timestamp <= ?", [20]],
    [{ eventId: "e" }, "event_id = ?", ["e"]],
    [{ issueId: "i" }, "issue_id = ?", ["i"]],
    [{ traceId: "t" }, "trace_id = ?", ["t"]],
    [{ q: "x" }, String.raw`title LIKE '%' || ? || '%' ESCAPE '\'`, ["x"]],
  ])("maps %j", (filter, sql, params) => {
    expect(buildItemWhere(filter)).toEqual({ sql, params });
  });

  it("combines filters and returns an empty fragment without filters", () => {
    expect(buildItemWhere({ project: ["p"], kind: ["log"], from: 1, to: 2 })).toEqual({
      sql: "project IN (?) AND kind IN (?) AND timestamp >= ? AND timestamp <= ?",
      params: ["p", "log", 1, 2],
    });
    expect(buildItemWhere({})).toEqual({ sql: "", params: [] });
  });

  it("keeps hostile text out of the SQL", () => {
    const hostile = "x' OR 1=1 --";
    const built = buildItemWhere({ q: hostile, eventId: hostile, project: [hostile] });
    expect(built.sql).not.toContain("OR 1=1");
    expect(built.params).toEqual([hostile, hostile, hostile]);
  });
});

describe("buildIssueWhere", () => {
  it.each([
    [{ project: ["p"] }, "project IN (?)", ["p"]],
    [{ session: ["s"] }, "session IN (?)", ["s"]],
    [
      { service: ["web"] },
      "id IN (SELECT issue_id FROM items WHERE issue_id IS NOT NULL AND service IN (?))",
      ["web"],
    ],
    [{ kind: ["message" as const] }, "kind IN (?)", ["message"]],
    [{ level: ["error" as const] }, "level IN (?)", ["error"]],
    [{ minLevel: "warning" as const }, "level IN (?, ?, ?)", ["warning", "error", "fatal"]],
    [{ from: 10 }, "last_seen_at >= ?", [10]],
    [{ to: 20 }, "last_seen_at <= ?", [20]],
    [{ q: "50%" }, String.raw`title LIKE '%' || ? || '%' ESCAPE '\'`, [String.raw`50\%`]],
  ])("maps %j", (filter, sql, params) => {
    expect(buildIssueWhere(filter)).toEqual({ sql, params });
  });

  it("scopes the service subquery by project and session", () => {
    expect(buildIssueWhere({ project: ["p"], session: ["s"], service: ["web"] })).toEqual({
      sql: "project IN (?) AND session IN (?) AND id IN (SELECT issue_id FROM items WHERE issue_id IS NOT NULL AND project IN (?) AND session IN (?) AND service IN (?))",
      params: ["p", "s", "p", "s", "web"],
    });
    expect(buildIssueWhere({ service: [] })).toEqual({ sql: "", params: [] });
    expect(buildIssueWhere({})).toEqual({ sql: "", params: [] });
  });
});

describe("buildFailedEnvelopeWhere", () => {
  it("maps scope and received_at bounds", () => {
    expect(buildFailedEnvelopeWhere({ service: ["web"], from: 1, to: 2 })).toEqual({
      sql: "service IN (?) AND received_at >= ? AND received_at <= ?",
      params: ["web", 1, 2],
    });
    expect(buildFailedEnvelopeWhere({})).toEqual({ sql: "", params: [] });
  });
});
