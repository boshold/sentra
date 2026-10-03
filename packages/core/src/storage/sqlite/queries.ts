import type { SqliteParam } from "#src/storage/sqlite/driver/types.js";
import { levelRank } from "#src/storage/sqlite/rows.js";
import type {
  ResolvedIssueFilter,
  ResolvedItemFilter,
  ResolvedScopeFilter,
  ResolvedScopeTimeFilter,
} from "#src/storage/types.js";
import { LEVELS } from "#src/types.js";
import type { Level, OneOrMany, ScopeFilter } from "#src/types.js";

interface SqlFragment {
  /** `""` or conditions joined with `AND`. */
  sql: string;
  params: SqliteParam[];
}

const EMPTY: SqlFragment = { sql: "", params: [] };

function fragment(sql: string, params: SqliteParam[] = []): SqlFragment {
  return { sql, params };
}

function toList(value: OneOrMany<string> | undefined): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  return typeof value === "string" ? [value] : value;
}

/** Bound as `ESCAPE ?` so the SQL text holds no backslash. */
const LIKE_ESCAPE = "\\";

function escapeLike(value: string): string {
  return value.replaceAll(/[\\%_]/g, (match) => `${LIKE_ESCAPE}${match}`);
}

/** Column names come from code only; an empty list adds no condition. */
function inList(column: string, values: readonly string[]): SqlFragment {
  if (values.length === 0) {
    return EMPTY;
  }
  return fragment(`${column} IN (${values.map(() => "?").join(", ")})`, [...values]);
}

function and(...fragments: SqlFragment[]): SqlFragment {
  const parts = fragments.filter((part) => part.sql !== "");
  return {
    sql: parts.map((part) => part.sql).join(" AND "),
    params: parts.flatMap((part) => part.params),
  };
}

/** `WHERE …` or `""`. */
function where(condition: SqlFragment): string {
  return condition.sql === "" ? "" : `WHERE ${condition.sql}`;
}

function levelsFrom(minLevel: Level): Level[] {
  const rank = levelRank(minLevel) ?? 0;
  return LEVELS.filter((_level, index) => index >= rank);
}

function scopeConditions(filter: ResolvedScopeFilter): SqlFragment[] {
  return [
    inList("project", filter.project ?? []),
    inList("session", filter.session ?? []),
    inList("service", filter.service ?? []),
  ];
}

function timeConditions(column: string, filter: ResolvedScopeTimeFilter): SqlFragment[] {
  return [
    filter.from === undefined ? EMPTY : fragment(`${column} >= ?`, [filter.from]),
    filter.to === undefined ? EMPTY : fragment(`${column} <= ?`, [filter.to]),
  ];
}

function equals(column: string, value: string | undefined): SqlFragment {
  return value === undefined ? EMPTY : fragment(`${column} = ?`, [value]);
}

/** ASCII-only case folding (SQLite `LIKE`); the memory adapter folds Unicode. */
function titleContains(q: string | undefined): SqlFragment {
  return q === undefined
    ? EMPTY
    : fragment("title LIKE '%' || ? || '%' ESCAPE ?", [escapeLike(q), LIKE_ESCAPE]);
}

function buildScopeWhere(filter: ScopeFilter): SqlFragment {
  return and(
    ...scopeConditions({
      project: toList(filter.project),
      session: toList(filter.session),
      service: toList(filter.service),
    }),
  );
}

function buildItemWhere(filter: ResolvedItemFilter): SqlFragment {
  return and(
    ...scopeConditions(filter),
    inList("kind", filter.kind ?? []),
    inList("item_type", filter.itemType ?? []),
    inList("level", filter.level ?? []),
    filter.minLevel === undefined
      ? EMPTY
      : fragment("level_rank >= ?", [levelRank(filter.minLevel)]),
    inList("environment", filter.environment ?? []),
    inList("release", filter.release ?? []),
    ...timeConditions("timestamp", filter),
    equals("event_id", filter.eventId),
    equals("issue_id", filter.issueId),
    equals("trace_id", filter.traceId),
    titleContains(filter.q),
  );
}

/** Issues with at least one record in one of the services. */
function issueServiceCondition(filter: ResolvedScopeFilter): SqlFragment {
  if (filter.service === undefined || filter.service.length === 0) {
    return EMPTY;
  }
  const inner = and(fragment("issue_id IS NOT NULL"), ...scopeConditions(filter));
  return fragment(`id IN (SELECT issue_id FROM items WHERE ${inner.sql})`, inner.params);
}

function buildIssueWhere(filter: ResolvedIssueFilter): SqlFragment {
  return and(
    inList("project", filter.project ?? []),
    inList("session", filter.session ?? []),
    issueServiceCondition(filter),
    inList("kind", filter.kind ?? []),
    inList("level", filter.level ?? []),
    filter.minLevel === undefined ? EMPTY : inList("level", levelsFrom(filter.minLevel)),
    ...timeConditions("last_seen_at", filter),
    titleContains(filter.q),
  );
}

function buildFailedEnvelopeWhere(filter: ResolvedScopeTimeFilter): SqlFragment {
  return and(...scopeConditions(filter), ...timeConditions("received_at", filter));
}

export {
  LIKE_ESCAPE,
  and,
  buildFailedEnvelopeWhere,
  buildIssueWhere,
  buildItemWhere,
  buildScopeWhere,
  escapeLike,
  inList,
  issueServiceCondition,
  toList,
  where,
};
export type { SqlFragment };
