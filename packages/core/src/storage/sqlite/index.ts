import { mkdirSync } from "node:fs";
import path from "node:path";

import { literal, strictObject, string } from "zod";

import { SentraConfigError, SentraStorageError } from "#src/errors.js";
import { createStatements } from "#src/storage/sqlite/connection.js";
import type { Connection } from "#src/storage/sqlite/connection.js";
import { loadDriver } from "#src/storage/sqlite/driver/load.js";
import { withWriteTransaction } from "#src/storage/sqlite/driver/transaction.js";
import type { SqliteDriverOption } from "#src/storage/sqlite/driver/types.js";
import {
  deleteItems,
  pruneIdleSessions,
  pruneOldItems,
  vacuum,
} from "#src/storage/sqlite/maintenance.js";
import {
  assertSupportedVersion,
  readUserVersion,
  runMigrations,
} from "#src/storage/sqlite/migrations.js";
import {
  findIssues,
  getBlob,
  getEnvelope,
  getIssue,
  getItem,
  getItemByEventId,
  listFailedEnvelopes,
  listIssues,
  listItems,
  listScopes,
} from "#src/storage/sqlite/read.js";
import { applyPragmas } from "#src/storage/sqlite/schema.js";
import { writeBatch } from "#src/storage/sqlite/write.js";
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
      const dir = path.dirname(this.#path);
      try {
        mkdirSync(dir, { recursive: true });
      } catch (error) {
        throw new SentraStorageError(
          "storage_unavailable",
          `sqliteStorage: cannot create directory ${dir}: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }
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

  #transaction<T>(fn: (connection: Connection) => T): T {
    const connection = this.#db();
    return withWriteTransaction(connection.driver, () => fn(connection));
  }

  public async write(batch: IngestBatch): Promise<{
    issues: { id: string; isNew: boolean; count: number }[];
  }> {
    return this.#transaction((connection) => writeBatch(connection, batch));
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
    return getItem(this.#db(), id);
  }

  public async getItemByEventId(eventId: string): Promise<Item | null> {
    return getItemByEventId(this.#db(), eventId);
  }

  public async getBlob(itemId: string): Promise<Uint8Array | null> {
    return getBlob(this.#db(), itemId);
  }

  public async getEnvelope(id: string): Promise<Envelope | null> {
    return getEnvelope(this.#db(), id);
  }

  public async listFailedEnvelopes(
    filter: ResolvedScopeTimeFilter,
    page: ResolvedPage,
  ): Promise<Page<Omit<Envelope, "body">>> {
    return listFailedEnvelopes(this.#db(), filter, page);
  }

  public async deleteItems(filter: ResolvedItemFilter): Promise<number> {
    return this.#transaction((connection) => deleteItems(connection, filter));
  }

  public async pruneIdleSessions(
    cutoff: Date,
  ): Promise<{ sessionsDeleted: number; itemsDeleted: number }> {
    return this.#transaction((connection) => pruneIdleSessions(connection, cutoff));
  }

  public async pruneOldItems(kinds: ItemKind[], cutoff: Date): Promise<{ itemsDeleted: number }> {
    if (kinds.length === 0) {
      this.#db();
      return { itemsDeleted: 0 };
    }
    return this.#transaction((connection) => pruneOldItems(connection, kinds, cutoff));
  }

  public async vacuum(): Promise<void> {
    vacuum(this.#db());
  }

  /** Idempotent. An `init()` still in flight rejects; a later `init()` reopens. */
  public async close(): Promise<void> {
    this.#generation += 1;
    const pending = this.#initPromise;
    const connection = this.#connection;
    this.#initPromise = null;
    this.#connection = null;
    connection?.driver.close();
    if (pending) {
      try {
        await pending;
      } catch {
        // Reported by init().
      }
    }
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
