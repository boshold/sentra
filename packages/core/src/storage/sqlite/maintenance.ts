import { int, nullable, object, string } from "zod";

import type { Connection } from "#src/storage/sqlite/connection.js";
import { and, buildItemWhere, inList, where } from "#src/storage/sqlite/queries.js";
import type { ResolvedItemFilter } from "#src/storage/types.js";
import type { ItemKind } from "#src/types.js";

const issueIdRowSchema = object({ issue_id: string() });
const countRowSchema = object({ count: int() });
const sessionRowSchema = object({ project: string(), session: string() });
const issueStatsRowSchema = object({
  count: int(),
  first_seen_at: nullable(int()),
  last_seen_at: nullable(int()),
  last_item_id: nullable(string()),
});

function recountIssue({ statements }: Connection, issueId: string): void {
  const stats = issueStatsRowSchema.parse(statements.issueStats.get(issueId));
  if (
    stats.count === 0 ||
    stats.first_seen_at === null ||
    stats.last_seen_at === null ||
    stats.last_item_id === null
  ) {
    statements.deleteIssue.run(issueId);
    return;
  }
  statements.updateIssueStats.run(
    stats.count,
    stats.first_seen_at,
    stats.last_seen_at,
    stats.last_item_id,
    issueId,
  );
}

/** Runs inside a write transaction. */
function deleteItems(connection: Connection, filter: ResolvedItemFilter): number {
  const { driver, statements } = connection;
  const condition = buildItemWhere(filter);
  const withIssue = and(condition, { sql: "issue_id IS NOT NULL", params: [] });
  const issueIds = driver
    .prepare(`SELECT DISTINCT issue_id FROM items ${where(withIssue)}`)
    .all(...withIssue.params)
    .map((row) => issueIdRowSchema.parse(row).issue_id);
  const { changes } = driver
    .prepare(`DELETE FROM items ${where(condition)}`)
    .run(...condition.params);
  statements.deleteOrphanEnvelopes.run();
  for (const issueId of issueIds) {
    recountIssue(connection, issueId);
  }
  statements.recountScopes.run();
  return changes;
}

/** Runs inside a write transaction. */
function pruneIdleSessions(
  { statements }: Connection,
  cutoff: Date,
): { sessionsDeleted: number; itemsDeleted: number } {
  const sessions = statements.idleSessions
    .all(cutoff.getTime())
    .map((row) => sessionRowSchema.parse(row));
  let itemsDeleted = 0;
  for (const { project, session } of sessions) {
    itemsDeleted += countRowSchema.parse(statements.countSessionItems.get(project, session)).count;
    statements.deleteSessionEnvelopes.run(project, session);
    statements.deleteSessionIssues.run(project, session);
    statements.deleteSessionScopes.run(project, session);
  }
  return { sessionsDeleted: sessions.length, itemsDeleted };
}

/** Runs inside a write transaction. Issues are untouched: only error/message records reference them. */
function pruneOldItems(
  { driver, statements }: Connection,
  kinds: ItemKind[],
  cutoff: Date,
): { itemsDeleted: number } {
  const kindCondition = inList("kind", kinds);
  const { changes } = driver
    .prepare(`DELETE FROM items WHERE ${kindCondition.sql} AND received_at < ?`)
    .run(...kindCondition.params, cutoff.getTime());
  statements.deleteOrphanEnvelopes.run();
  statements.deleteOldFailedEnvelopes.run(cutoff.getTime());
  statements.recountScopes.run();
  return { itemsDeleted: changes };
}

/** Outside any transaction: `VACUUM` fails inside one; the checkpoint shrinks the main file in WAL mode. */
function vacuum({ driver }: Connection): void {
  driver.exec("VACUUM");
  driver.exec("PRAGMA wal_checkpoint(TRUNCATE)");
}

export { deleteItems, pruneIdleSessions, pruneOldItems, vacuum };
