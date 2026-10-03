import { object, string } from "zod";

import { encodeCursor, encodeIssueCursor, parseIssueCursor } from "#src/query/cursor.js";
import type { Connection } from "#src/storage/sqlite/connection.js";
import type { SqliteDriver, SqliteParam } from "#src/storage/sqlite/driver/types.js";
import {
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
} from "#src/storage/sqlite/queries.js";
import type { SqlFragment } from "#src/storage/sqlite/queries.js";
import {
  ENVELOPE_COLUMNS,
  ITEM_SUMMARY_COLUMNS,
  blobRowSchema,
  rowToEnvelope,
  rowToIssue,
  rowToItem,
  rowToItemSummary,
  rowToScopeSummary,
} from "#src/storage/sqlite/rows.js";
import type {
  ResolvedIssueFilter,
  ResolvedItemFilter,
  ResolvedPage,
  ResolvedScopeTimeFilter,
} from "#src/storage/types.js";
import type {
  Envelope,
  Issue,
  Item,
  ItemSummary,
  Page,
  ScopeFilter,
  ScopeSummary,
} from "#src/types.js";

const ITEM_SUMMARY_SELECT = ITEM_SUMMARY_COLUMNS.join(", ");
const ENVELOPE_META_SELECT = ENVELOPE_COLUMNS.filter((column) => column !== "body").join(", ");
const FIND_ISSUES_LIMIT = 2;

const serviceRowSchema = object({ service: string() });
const issueServiceRowSchema = object({ issue_id: string(), service: string() });
const idRowSchema = object({ id: string() });

interface Query {
  sql: string;
  params: SqliteParam[];
}

function all(driver: SqliteDriver, sql: string, params: SqliteParam[]): unknown[] {
  return driver.prepare(sql).all(...params);
}

function pageOf<T extends { id: string }>(rows: T[], limit: number): Page<T> {
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  return {
    items,
    nextCursor: rows.length > limit && last !== undefined ? encodeCursor(last.id) : null,
  };
}

function idBefore(cursor: string | null): SqlFragment {
  return cursor === null ? { sql: "", params: [] } : { sql: "id < ?", params: [cursor] };
}

function servicesByIssue(driver: SqliteDriver, ids: string[]): Map<string, string[]> {
  const result = new Map<string, string[]>();
  if (ids.length === 0) {
    return result;
  }
  const condition = inList("issue_id", ids);
  for (const row of all(
    driver,
    `SELECT DISTINCT issue_id, service FROM items WHERE ${condition.sql}`,
    condition.params,
  )) {
    const { issue_id: issueId, service } = issueServiceRowSchema.parse(row);
    result.set(issueId, [...(result.get(issueId) ?? []), service]);
  }
  return result;
}

function toIssues(driver: SqliteDriver, rows: unknown[]): Issue[] {
  const ids = rows.map((row) => idRowSchema.parse(row).id);
  const services = servicesByIssue(driver, ids);
  return rows.map((row, index) =>
    rowToIssue(row, (services.get(ids[index] ?? "") ?? []).toSorted()),
  );
}

function listScopes({ driver }: Connection, filter: ScopeFilter): ScopeSummary[] {
  const condition = buildScopeWhere(filter);
  return all(
    driver,
    `SELECT project, session, service, first_seen_at, last_seen_at, item_count,
       (SELECT COUNT(DISTINCT issue_id) FROM items
         WHERE items.project = scopes.project AND items.session = scopes.session
           AND items.service = scopes.service AND issue_id IS NOT NULL) AS issue_count
     FROM scopes ${where(condition)}
     ORDER BY project, session, service`,
    condition.params,
  ).map(rowToScopeSummary);
}

/** Fetches `limit + 1` rows; the extra row only decides `nextCursor`. */
function listIssuesQuery(filter: ResolvedIssueFilter, page: ResolvedPage): Query {
  const after = page.cursor === null ? null : parseIssueCursor(page.cursor);
  const condition = and(
    buildIssueWhere(filter),
    after === null
      ? { sql: "", params: [] }
      : {
          sql: "(last_seen_at < ? OR (last_seen_at = ? AND id < ?))",
          params: [after.lastSeenAt, after.lastSeenAt, after.id],
        },
  );
  return {
    sql: `SELECT * FROM issues ${where(condition)} ORDER BY last_seen_at DESC, id DESC LIMIT ?`,
    params: [...condition.params, page.limit + 1],
  };
}

function listIssues(
  { driver }: Connection,
  filter: ResolvedIssueFilter,
  page: ResolvedPage,
): Page<Issue> {
  const query = listIssuesQuery(filter, page);
  const rows = all(driver, query.sql, query.params);
  const items = toIssues(driver, rows.slice(0, page.limit));
  const last = items.at(-1);
  return {
    items,
    nextCursor: rows.length > page.limit && last !== undefined ? encodeIssueCursor(last) : null,
  };
}

function findIssues({ driver }: Connection, idPrefix: string, scope: ScopeFilter): Issue[] {
  const scopeFilter = {
    project: toList(scope.project) ?? [],
    session: toList(scope.session) ?? [],
    service: toList(scope.service) ?? [],
  };
  const condition = and(
    {
      sql: "id LIKE ? || '%' ESCAPE '\\' AND substr(id, 1, ?) = ?",
      params: [escapeLike(idPrefix), idPrefix.length, idPrefix],
    },
    inList("project", scopeFilter.project),
    inList("session", scopeFilter.session),
    issueServiceCondition(scopeFilter),
  );
  const rows = all(driver, `SELECT * FROM issues ${where(condition)} ORDER BY id LIMIT ?`, [
    ...condition.params,
    FIND_ISSUES_LIMIT,
  ]);
  return toIssues(driver, rows);
}

function getIssue({ statements }: Connection, id: string): Issue | null {
  const row = statements.selectIssue.get(id);
  if (row === undefined) {
    return null;
  }
  const services = statements.selectIssueServices
    .all(id)
    .map((entry) => serviceRowSchema.parse(entry).service)
    .toSorted();
  return rowToIssue(row, services);
}

/** Fetches `limit + 1` rows; the extra row only decides `nextCursor`. */
function listItemsQuery(filter: ResolvedItemFilter, page: ResolvedPage): Query {
  const condition = and(buildItemWhere(filter), idBefore(page.cursor));
  return {
    sql: `SELECT ${ITEM_SUMMARY_SELECT} FROM items ${where(condition)} ORDER BY id DESC LIMIT ?`,
    params: [...condition.params, page.limit + 1],
  };
}

function listItems(
  { driver }: Connection,
  filter: ResolvedItemFilter,
  page: ResolvedPage,
): Page<ItemSummary> {
  const query = listItemsQuery(filter, page);
  return pageOf(all(driver, query.sql, query.params).map(rowToItemSummary), page.limit);
}

function getItem({ statements }: Connection, id: string): Item | null {
  const row = statements.selectItem.get(id);
  return row === undefined ? null : rowToItem(row);
}

function getItemByEventId({ statements }: Connection, eventId: string): Item | null {
  const row = statements.selectItemByEventId.get(eventId);
  return row === undefined ? null : rowToItem(row);
}

function getBlob({ statements }: Connection, itemId: string): Uint8Array | null {
  const row = statements.selectBlob.get(itemId);
  return row === undefined ? null : blobRowSchema.parse(row).data;
}

function getEnvelope({ statements }: Connection, id: string): Envelope | null {
  const row = statements.selectEnvelope.get(id);
  return row === undefined ? null : rowToEnvelope(row);
}

function listFailedEnvelopes(
  { driver }: Connection,
  filter: ResolvedScopeTimeFilter,
  page: ResolvedPage,
): Page<Omit<Envelope, "body">> {
  const condition = and(
    { sql: "parse_error IS NOT NULL", params: [] },
    buildFailedEnvelopeWhere(filter),
    idBefore(page.cursor),
  );
  const rows = all(
    driver,
    `SELECT ${ENVELOPE_META_SELECT} FROM envelopes ${where(condition)} ORDER BY id DESC LIMIT ?`,
    [...condition.params, page.limit + 1],
  ).map(rowToEnvelope);
  return pageOf(rows, page.limit);
}

export {
  findIssues,
  getBlob,
  getEnvelope,
  getIssue,
  getItem,
  getItemByEventId,
  listFailedEnvelopes,
  listIssues,
  listIssuesQuery,
  listItems,
  listItemsQuery,
  listScopes,
};
