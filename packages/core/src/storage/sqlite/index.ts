import { mkdirSync } from "node:fs";
import path from "node:path";

import { literal, strictObject, string } from "zod";

import { SentraConfigError, SentraStorageError } from "#src/errors.js";
import { loadDriver } from "#src/storage/sqlite/driver/load.js";
import type { SqliteDriver, SqliteDriverOption } from "#src/storage/sqlite/driver/types.js";
import {
  assertSupportedVersion,
  readUserVersion,
  runMigrations,
} from "#src/storage/sqlite/migrations.js";
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

class SqliteStorage implements StorageAdapter {
  public readonly type = "sqlite";

  readonly #path: string;
  readonly #driverOption: SqliteDriverOption;
  #driver: SqliteDriver | null = null;

  public constructor(file: string, driver: SqliteDriverOption) {
    this.#path = file === MEMORY_PATH ? file : path.resolve(file);
    this.#driverOption = driver;
  }

  public async init(): Promise<{ driver: string | null; path: string | null }> {
    if (this.#driver) {
      return { driver: this.#driver.name, path: this.#path };
    }
    if (this.#path !== MEMORY_PATH) {
      mkdirSync(path.dirname(this.#path), { recursive: true });
    }
    const driver = await loadDriver(this.#driverOption, this.#path);
    try {
      // Checked before pragmas: `journal_mode=WAL` would rewrite the file header.
      assertSupportedVersion(readUserVersion(driver));
      applyPragmas(driver);
      runMigrations(driver);
    } catch (error) {
      driver.close();
      throw error;
    }
    this.#driver = driver;
    return { driver: driver.name, path: this.#path };
  }

  #db(): SqliteDriver {
    if (!this.#driver) {
      throw new SentraStorageError("storage_unavailable", "sqliteStorage: init() was not called");
    }
    return this.#driver;
  }

  public async write(_batch: IngestBatch): Promise<{
    issues: { id: string; isNew: boolean; count: number }[];
  }> {
    throw this.#notImplemented("write");
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
    const driver = this.#driver;
    this.#driver = null;
    driver?.close();
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
