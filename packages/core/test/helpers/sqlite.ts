import { openBetterSqlite3 } from "#src/storage/sqlite/driver/better-sqlite3.js";
import { openNodeSqlite } from "#src/storage/sqlite/driver/node.js";
import type { SqliteDriver, SqliteDriverName } from "#src/storage/sqlite/driver/types.js";

export const SQLITE_OPENERS: Record<SqliteDriverName, (file: string) => Promise<SqliteDriver>> = {
  "better-sqlite3": openBetterSqlite3,
  node: openNodeSqlite,
};

/** Drivers that open in the current runtime. */
export async function loadableSqliteDrivers(): Promise<SqliteDriverName[]> {
  const names: SqliteDriverName[] = [];
  for (const name of ["better-sqlite3", "node"] as const) {
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
