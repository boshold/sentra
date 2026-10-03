import { openBetterSqlite3 } from "#src/storage/sqlite/driver/better-sqlite3.js";
import { openNodeSqlite } from "#src/storage/sqlite/driver/node.js";
import type { SqliteDriver, SqliteDriverName } from "#src/storage/sqlite/driver/types.js";

export const SQLITE_OPENERS: Record<SqliteDriverName, (file: string) => Promise<SqliteDriver>> = {
  "better-sqlite3": openBetterSqlite3,
  node: openNodeSqlite,
};

/** Bun 1.4.0 aborts the process when loading better-sqlite3, so it is never probed there. */
export const RUNTIME_SQLITE_DRIVERS: readonly SqliteDriverName[] =
  process.versions.bun === undefined ? ["better-sqlite3", "node"] : ["node"];

/** Drivers that open in the current runtime. */
export async function loadableSqliteDrivers(): Promise<SqliteDriverName[]> {
  const names: SqliteDriverName[] = [];
  for (const name of RUNTIME_SQLITE_DRIVERS) {
    try {
      const driver = await SQLITE_OPENERS[name](":memory:");
      driver.close();
      names.push(name);
    } catch {
      // Not available here.
    }
  }
  return names;
}
