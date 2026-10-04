import type { SqliteDriver, SqliteStatement } from "#src/storage/sqlite/driver/types.js";
import { ENVELOPE_COLUMNS, ITEM_COLUMNS } from "#src/storage/sqlite/rows.js";

function insertSql(table: string, columns: readonly string[]): string {
  return `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`;
}

/**
 * Writes can finish out of receipt order: latest-event fields follow receipt time, then item id.
 */
function latestOnly(column: string): string {
  return `${column} = CASE WHEN excluded.last_seen_at > last_seen_at
    OR (excluded.last_seen_at = last_seen_at AND excluded.last_item_id > last_item_id)
    THEN excluded.${column} ELSE ${column} END`;
}

export function createStatements(driver: SqliteDriver) {
  return {
    touchScope: driver.prepare(
      `INSERT INTO scopes (project, session, service, first_seen_at, last_seen_at, item_count)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(project, session, service) DO UPDATE SET
         last_seen_at = MAX(last_seen_at, excluded.last_seen_at),
         item_count = item_count + excluded.item_count`,
    ),
    insertEnvelope: driver.prepare(insertSql("envelopes", ENVELOPE_COLUMNS)),
    insertItem: driver.prepare(insertSql("items", ITEM_COLUMNS)),
    insertBlob: driver.prepare("INSERT INTO blobs (item_id, data) VALUES (?, ?)"),
    selectIssueCount: driver.prepare("SELECT count FROM issues WHERE id = ?"),
    upsertIssue: driver.prepare(
      `INSERT INTO issues (id, project, session, kind, fingerprint, fingerprint_hash, title, culprit, level, platform,
                           count, first_seen_at, last_seen_at, last_item_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET count = count + 1,
         first_seen_at = MIN(first_seen_at, excluded.first_seen_at),
         last_seen_at = MAX(last_seen_at, excluded.last_seen_at),
         ${latestOnly("last_item_id")}, ${latestOnly("title")}, ${latestOnly("culprit")},
         ${latestOnly("level")}, ${latestOnly("platform")}`,
    ),
    selectItem: driver.prepare("SELECT * FROM items WHERE id = ?"),
    selectItemByEventId: driver.prepare(
      `SELECT * FROM items WHERE event_id = ?
       ORDER BY CASE WHEN kind IN ('error', 'message', 'transaction') THEN 0 ELSE 1 END, id
       LIMIT 1`,
    ),
    selectIssue: driver.prepare("SELECT * FROM issues WHERE id = ?"),
    selectIssueServices: driver.prepare("SELECT DISTINCT service FROM items WHERE issue_id = ?"),
    selectBlob: driver.prepare("SELECT data FROM blobs WHERE item_id = ?"),
    selectEnvelope: driver.prepare("SELECT * FROM envelopes WHERE id = ?"),
    deleteOrphanEnvelopes: driver.prepare(
      `DELETE FROM envelopes WHERE parse_error IS NULL
         AND NOT EXISTS (SELECT 1 FROM items WHERE envelope_id = envelopes.id)`,
    ),
    recountScopes: driver.prepare(
      `UPDATE scopes SET item_count = (SELECT COUNT(*) FROM items i
         WHERE i.project = scopes.project AND i.session = scopes.session AND i.service = scopes.service)`,
    ),
    issueStats: driver.prepare(
      `SELECT COUNT(*) AS count, MIN(received_at) AS first_seen_at, MAX(received_at) AS last_seen_at,
         (SELECT id FROM items l WHERE l.issue_id = items.issue_id
          ORDER BY l.received_at DESC, l.id DESC LIMIT 1) AS last_item_id
       FROM items WHERE issue_id = ?`,
    ),
    deleteIssue: driver.prepare("DELETE FROM issues WHERE id = ?"),
    updateIssueStats: driver.prepare(
      `UPDATE issues SET count = ?, first_seen_at = ?, last_seen_at = ?, last_item_id = ?,
         title = ?, culprit = ?, level = ?, platform = ?
       WHERE id = ?`,
    ),
    idleSessions: driver.prepare(
      "SELECT project, session FROM scopes GROUP BY project, session HAVING MAX(last_seen_at) < ?",
    ),
    countSessionItems: driver.prepare(
      "SELECT COUNT(*) AS count FROM items WHERE project = ? AND session = ?",
    ),
    deleteSessionEnvelopes: driver.prepare(
      "DELETE FROM envelopes WHERE project = ? AND session = ?",
    ),
    deleteSessionIssues: driver.prepare("DELETE FROM issues WHERE project = ? AND session = ?"),
    deleteSessionScopes: driver.prepare("DELETE FROM scopes WHERE project = ? AND session = ?"),
    deleteOldFailedEnvelopes: driver.prepare(
      "DELETE FROM envelopes WHERE parse_error IS NOT NULL AND received_at < ?",
    ),
  } satisfies Record<string, SqliteStatement>;
}

export type Statements = ReturnType<typeof createStatements>;

export interface Connection {
  driver: SqliteDriver;
  statements: Statements;
}
