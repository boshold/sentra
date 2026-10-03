import { mkdirSync } from "node:fs";
import path from "node:path";

import { int, literal, object, strictObject, string } from "zod";

import { SentraConfigError, SentraStorageError } from "#src/errors.js";
import { loadDriver } from "#src/storage/sqlite/driver/load.js";
import { withWriteTransaction } from "#src/storage/sqlite/driver/transaction.js";
import type {
  SqliteDriver,
  SqliteDriverOption,
  SqliteStatement,
} from "#src/storage/sqlite/driver/types.js";
import {
  assertSupportedVersion,
  readUserVersion,
  runMigrations,
} from "#src/storage/sqlite/migrations.js";
import {
  ENVELOPE_COLUMNS,
  ITEM_COLUMNS,
  envelopeToRow,
  itemToRow,
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

class SqliteStorage implements StorageAdapter {
  public readonly type = "sqlite";

  readonly #path: string;
  readonly #driverOption: SqliteDriverOption;
  #connection: Connection | null = null;
  #initPromise: Promise<Connection> | null = null;

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
    try {
      return await this.#open();
    } catch (error) {
      this.#initPromise = null;
      throw error;
    }
  }

  async #open(): Promise<Connection> {
    if (this.#path !== MEMORY_PATH) {
      mkdirSync(path.dirname(this.#path), { recursive: true });
    }
    const driver = await loadDriver(this.#driverOption, this.#path);
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

  public async listScopes(_filter: ScopeFilter): Promise<ScopeSummary[]> {
    throw this.#notImplemented("listScopes");
  }

  public async listIssues(_filter: ResolvedIssueFilter, _page: ResolvedPage): Promise<Page<Issue>> {
    throw this.#notImplemented("listIssues");
  }

  public async findIssues(_idPrefix: string, _scope: ScopeFilter): Promise<Issue[]> {
    throw this.#notImplemented("findIssues");
  }

  public async getIssue(_id: string): Promise<Issue | null> {
    throw this.#notImplemented("getIssue");
  }

  public async listItems(
    _filter: ResolvedItemFilter,
    _page: ResolvedPage,
  ): Promise<Page<ItemSummary>> {
    throw this.#notImplemented("listItems");
  }

  public async getItem(_id: string): Promise<Item | null> {
    throw this.#notImplemented("getItem");
  }

  public async getItemByEventId(_eventId: string): Promise<Item | null> {
    throw this.#notImplemented("getItemByEventId");
  }

  public async getBlob(_itemId: string): Promise<Uint8Array | null> {
    throw this.#notImplemented("getBlob");
  }

  public async getEnvelope(_id: string): Promise<Envelope | null> {
    throw this.#notImplemented("getEnvelope");
  }

  public async listFailedEnvelopes(
    _filter: ResolvedScopeTimeFilter,
    _page: ResolvedPage,
  ): Promise<Page<Omit<Envelope, "body">>> {
    throw this.#notImplemented("listFailedEnvelopes");
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
