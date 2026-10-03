import type BetterSqlite3 from "better-sqlite3";

import { BUSY_TIMEOUT_MS } from "#src/storage/sqlite/driver/types.js";
import type {
  SqliteDriver,
  SqliteParam,
  SqliteStatement,
} from "#src/storage/sqlite/driver/types.js";

function normalizeRow(row: unknown): unknown {
  if (typeof row !== "object" || row === null) {
    return row;
  }
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    out[key] = Buffer.isBuffer(value) ? new Uint8Array(value) : value;
  }
  return out;
}

function wrap(db: BetterSqlite3.Database): SqliteDriver {
  return {
    name: "better-sqlite3",
    exec(sql: string): void {
      db.exec(sql);
    },
    prepare(sql: string): SqliteStatement {
      const statement = db.prepare(sql);
      return {
        run(...params: SqliteParam[]): { changes: number } {
          return { changes: statement.run(...params).changes };
        },
        get(...params: SqliteParam[]): unknown {
          return normalizeRow(statement.get(...params));
        },
        all(...params: SqliteParam[]): unknown[] {
          return statement.all(...params).map(normalizeRow);
        },
      };
    },
    close(): void {
      db.close();
    },
  };
}

type DatabaseConstructor = typeof BetterSqlite3;

function openDatabase(Database: DatabaseConstructor, path: string): BetterSqlite3.Database {
  const db = new Database(path, { timeout: BUSY_TIMEOUT_MS });
  try {
    db.prepare("SELECT 1").get();
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

/** `new Database` loads the native addon; probing `:memory:` separates a broken binding from a bad path. */
export async function loadBetterSqlite3(): Promise<(path: string) => SqliteDriver> {
  const { default: Database } = await import("better-sqlite3");
  const probe = new Database(":memory:");
  probe.close();
  return (path) => wrap(openDatabase(Database, path));
}

export async function openBetterSqlite3(path: string): Promise<SqliteDriver> {
  const open = await loadBetterSqlite3();
  return open(path);
}
