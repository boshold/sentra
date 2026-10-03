import { mkdirSync } from "node:fs";
import path from "node:path";

import { int, literal, object, strictObject, string } from "zod";

import { SentraConfigError, SentraStorageError } from "#src/errors.js";
import { encodeCursor, encodeIssueCursor, parseIssueCursor } from "#src/query/cursor.js";
import { loadDriver } from "#src/storage/sqlite/driver/load.js";
import { withWriteTransaction } from "#src/storage/sqlite/driver/transaction.js";
import type {
  SqliteDriver,
  SqliteDriverOption,
  SqliteParam,
  SqliteStatement,
} from "#src/storage/sqlite/driver/types.js";
import {
  assertSupportedVersion,
  readUserVersion,
  runMigrations,
} from "#src/storage/sqlite/migrations.js";
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
  ITEM_COLUMNS,
  ITEM_SUMMARY_COLUMNS,
  envelopeToRow,
  itemToRow,
  rowToEnvelope,
  rowToIssue,
  rowToItem,
  rowToItemSummary,
  rowToScopeSummary,
  toMs,
} from "#src/storage/sqlite/rows.js";
import { applyPragmas } from "#src/storage/sqlite/schema.js";
import type {
  IngestBatch,
  ResolvedIssueFilter,
  ResolvedItemFilter,
  ResolvedPage,
  ResolvedScopeTimeFilter,
  StorageAdapter,
} from "#src/storage/types.js";
import type {
  Envelope,
  Issue,
  Item,
  ItemKind,
  ItemSummary,
  Page,
  ScopeFilter,
  ScopeSummary,
} from "#src/types.js";

const MEMORY_PATH = ":memory:";

const optionsSchema = strictObject({
  path: string().min(1),
  driver: literal(["auto", "better-sqlite3", "node"]).default("auto"),
});

const issueCountRowSchema = object({ count: int() });

function insertSql(table: string, columns: readonly string[]): string {
  return `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`;
}

function createStatements(driver: SqliteDriver) {
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
       ON CONFLICT(id) DO UPDATE SET count = count + 1, last_seen_at = excluded.last_seen_at,
         last_item_id = excluded.last_item_id, title = excluded.title, culprit = excluded.culprit,
         level = excluded.level, platform = excluded.platform`,
    ),
    selectItem: driver.prepare("SELECT * FROM items WHERE id = ?"),
    selectItemByEventId: driver.prepare(
      `SELECT * FROM items WHERE event_id = ?
       ORDER BY CASE WHEN kind IN ('error', 'message', 'transaction') THEN 0 ELSE 1 END, id
       LIMIT 1`,
    ),
    selectIssue: driver.prepare("SELECT * FROM issues WHERE id = ?"),
    selectIssueServices: driver.prepare("SELECT DISTINCT service FROM items WHERE issue_id = ?"),
  } satisfies Record<string, SqliteStatement>;
}

type Statements = ReturnType<typeof createStatements>;

interface Connection {
  driver: SqliteDriver;
  statements: Statements;
}

function writeBatch(
  { statements }: Connection,
  batch: IngestBatch,
): { issues: { id: string; isNew: boolean; count: number }[] } {
  const { envelope } = batch;
  const receivedAt = toMs(envelope.receivedAt);
  statements.touchScope.run(
    envelope.scope.project,
    envelope.scope.session,
    envelope.scope.service,
    receivedAt,
    receivedAt,
    batch.items.length,
  );
  const envelopeRow = envelopeToRow(envelope);
  statements.insertEnvelope.run(...ENVELOPE_COLUMNS.map((column) => envelopeRow[column]));
  for (const { item, blob } of batch.items) {
    const itemRow = itemToRow(item);
    statements.insertItem.run(...ITEM_COLUMNS.map((column) => itemRow[column]));
    if (blob !== null) {
      statements.insertBlob.run(item.id, blob);
    }
  }
  const issues = batch.issues.map((entry) => {
    const previous = issueCountRowSchema
      .optional()
      .parse(statements.selectIssueCount.get(entry.id));
    const seenAt = toMs(entry.seenAt);
    statements.upsertIssue.run(
      entry.id,
      entry.project,
      entry.session,
      entry.kind,
      JSON.stringify(entry.fingerprint),
      entry.fingerprintHash,
      entry.title,
      entry.culprit,
      entry.level,
      entry.platform,
      seenAt,
      seenAt,
      entry.itemId,
    );
    return previous === undefined
      ? { id: entry.id, isNew: true, count: 1 }
      : { id: entry.id, isNew: false, count: previous.count + 1 };
  });
  return { issues };
}

const ITEM_SUMMARY_SELECT = ITEM_SUMMARY_COLUMNS.join(", ");
const ENVELOPE_META_SELECT = ENVELOPE_COLUMNS.filter((column) => column !== "body").join(", ");
const FIND_ISSUES_LIMIT = 2;

const serviceRowSchema = object({ service: string() });
const issueServiceRowSchema = object({ issue_id: string(), service: string() });

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
  const ids = rows.map((row) => object({ id: string() }).parse(row).id);
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

function listIssues(
  { driver }: Connection,
  filter: ResolvedIssueFilter,
  page: ResolvedPage,
): Page<Issue> {
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
  const rows = all(
    driver,
    `SELECT * FROM issues ${where(condition)} ORDER BY last_seen_at DESC, id DESC LIMIT ?`,
    [...condition.params, page.limit + 1],
  );
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

function listItems(
  { driver }: Connection,
  filter: ResolvedItemFilter,
  page: ResolvedPage,
): Page<ItemSummary> {
  const condition = and(buildItemWhere(filter), idBefore(page.cursor));
  const rows = all(
    driver,
    `SELECT ${ITEM_SUMMARY_SELECT} FROM items ${where(condition)} ORDER BY id DESC LIMIT ?`,
    [...condition.params, page.limit + 1],
  ).map(rowToItemSummary);
  return pageOf(rows, page.limit);
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

class SqliteStorage implements StorageAdapter {
  public readonly type = "sqlite";

  readonly #path: string;
  readonly #driverOption: SqliteDriverOption;
  #connection: Connection | null = null;
  #initPromise: Promise<Connection> | null = null;
  /** Bumped by `close()`; an `init()` started before that fails. */
  #generation = 0;

  public constructor(file: string, driver: SqliteDriverOption) {
    this.#path = file === MEMORY_PATH ? file : path.resolve(file);
    this.#driverOption = driver;
  }

  public async init(): Promise<{ driver: string | null; path: string | null }> {
    this.#initPromise ??= this.#openOnce();
    const { driver } = await this.#initPromise;
    return { driver: driver.name, path: this.#path };
  }

  /** A failed attempt is forgotten so `init()` can be retried. */
  async #openOnce(): Promise<Connection> {
    const generation = this.#generation;
    try {
      return await this.#open(generation);
    } catch (error) {
      if (generation === this.#generation) {
        this.#initPromise = null;
      }
      throw error;
    }
  }

  async #open(generation: number): Promise<Connection> {
    if (this.#path !== MEMORY_PATH) {
      mkdirSync(path.dirname(this.#path), { recursive: true });
    }
    const driver = await loadDriver(this.#driverOption, this.#path);
    if (generation !== this.#generation) {
      driver.close();
      throw new SentraStorageError("storage_unavailable", "sqliteStorage: closed during init()");
    }
    try {
      // Checked before pragmas: `journal_mode=WAL` would rewrite the file header.
      assertSupportedVersion(readUserVersion(driver));
      applyPragmas(driver);
      runMigrations(driver);
      this.#connection = { driver, statements: createStatements(driver) };
      return this.#connection;
    } catch (error) {
      driver.close();
      throw error;
    }
  }

  #db(): Connection {
    if (!this.#connection) {
      throw new SentraStorageError("storage_unavailable", "sqliteStorage: init() was not called");
    }
    return this.#connection;
  }

  public async write(batch: IngestBatch): Promise<{
    issues: { id: string; isNew: boolean; count: number }[];
  }> {
    const connection = this.#db();
    return withWriteTransaction(connection.driver, () => writeBatch(connection, batch));
  }

  public async listScopes(filter: ScopeFilter): Promise<ScopeSummary[]> {
    return listScopes(this.#db(), filter);
  }

  public async listIssues(filter: ResolvedIssueFilter, page: ResolvedPage): Promise<Page<Issue>> {
    return listIssues(this.#db(), filter, page);
  }

  public async findIssues(idPrefix: string, scope: ScopeFilter): Promise<Issue[]> {
    return findIssues(this.#db(), idPrefix, scope);
  }

  public async getIssue(id: string): Promise<Issue | null> {
    return getIssue(this.#db(), id);
  }

  public async listItems(
    filter: ResolvedItemFilter,
    page: ResolvedPage,
  ): Promise<Page<ItemSummary>> {
    return listItems(this.#db(), filter, page);
  }

  public async getItem(id: string): Promise<Item | null> {
    const row = this.#db().statements.selectItem.get(id);
    return row === undefined ? null : rowToItem(row);
  }

  public async getItemByEventId(eventId: string): Promise<Item | null> {
    const row = this.#db().statements.selectItemByEventId.get(eventId);
    return row === undefined ? null : rowToItem(row);
  }

  public async getBlob(_itemId: string): Promise<Uint8Array | null> {
    throw this.#notImplemented("getBlob");
  }

  public async getEnvelope(_id: string): Promise<Envelope | null> {
    throw this.#notImplemented("getEnvelope");
  }

  public async listFailedEnvelopes(
    filter: ResolvedScopeTimeFilter,
    page: ResolvedPage,
  ): Promise<Page<Omit<Envelope, "body">>> {
    return listFailedEnvelopes(this.#db(), filter, page);
  }

  public async deleteItems(_filter: ResolvedItemFilter): Promise<number> {
    throw this.#notImplemented("deleteItems");
  }

  public async pruneIdleSessions(
    _cutoff: Date,
  ): Promise<{ sessionsDeleted: number; itemsDeleted: number }> {
    throw this.#notImplemented("pruneIdleSessions");
  }

  public async pruneOldItems(_kinds: ItemKind[], _cutoff: Date): Promise<{ itemsDeleted: number }> {
    throw this.#notImplemented("pruneOldItems");
  }

  public async vacuum(): Promise<void> {
    throw this.#notImplemented("vacuum");
  }

  #notImplemented(method: string): Error {
    this.#db();
    return new Error(`${this.type}Storage: not implemented: ${method}`);
  }

  public async close(): Promise<void> {
    this.#generation += 1;
    const pending = this.#initPromise;
    this.#initPromise = null;
    if (pending) {
      try {
        await pending;
      } catch {
        // Reported by init().
      }
    }
    const connection = this.#connection;
    this.#connection = null;
    connection?.driver.close();
  }
}

export interface SqliteStorageOptions {
  /** SQLite file path or `:memory:`. Missing parent directories are created. */
  path: string;
  /** Default `"auto"`: `better-sqlite3`, then `node:sqlite`. */
  driver?: SqliteDriverOption;
}

export function sqliteStorage(options: SqliteStorageOptions): StorageAdapter {
  const parsed = optionsSchema.safeParse(options);
  if (!parsed.success) {
    throw new SentraConfigError(
      "invalid_option",
      `sqliteStorage: invalid options: ${parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`,
      { details: parsed.error.issues },
    );
  }
  return new SqliteStorage(parsed.data.path, parsed.data.driver);
}
