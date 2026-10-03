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

async function openDatabase(path: string): Promise<BetterSqlite3.Database> {
  let db: BetterSqlite3.Database | undefined = undefined;
  try {
    const { default: Database } = await import("better-sqlite3");
    // `new Database` loads the native addon; a broken binding fails here.
    db = new Database(path, { timeout: BUSY_TIMEOUT_MS });
    db.prepare("SELECT 1").get();
    return db;
  } catch (error) {
    db?.close();
    throw error;
  }
}

export async function openBetterSqlite3(path: string): Promise<SqliteDriver> {
  const db = await openDatabase(path);

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
