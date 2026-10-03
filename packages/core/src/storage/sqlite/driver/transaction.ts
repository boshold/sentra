import type { SqliteDriver } from "#src/storage/sqlite/driver/types.js";

/** Not re-entrant: callers must never nest write transactions. */
export function withWriteTransaction<T>(driver: SqliteDriver, fn: () => T): T {
  driver.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    driver.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      driver.exec("ROLLBACK");
    } catch {
      // Keep the original error.
    }
    throw error;
  }
}
