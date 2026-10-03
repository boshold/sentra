import { int, object } from "zod";

import { SentraStorageError } from "#src/errors.js";
import { withWriteTransaction } from "#src/storage/sqlite/driver/transaction.js";
import type { SqliteDriver } from "#src/storage/sqlite/driver/types.js";
import { SCHEMA_V1 } from "#src/storage/sqlite/schema.js";

const userVersionRow = object({ user_version: int() });

export const MIGRATIONS: readonly string[] = [SCHEMA_V1];

export const SCHEMA_VERSION = MIGRATIONS.length;

export function readUserVersion(driver: SqliteDriver): number {
  return userVersionRow.parse(driver.prepare("PRAGMA user_version").get()).user_version;
}

export function assertSupportedVersion(
  version: number,
  migrations: readonly string[] = MIGRATIONS,
): void {
  if (version > migrations.length) {
    throw new SentraStorageError(
      "schema_too_new",
      `sqliteStorage: schema too new (database version ${version}, supported up to ${migrations.length})`,
      { details: { version, supported: migrations.length } },
    );
  }
}

export function runMigrations(
  driver: SqliteDriver,
  migrations: readonly string[] = MIGRATIONS,
): { from: number; to: number } {
  const from = readUserVersion(driver);
  assertSupportedVersion(from, migrations);
  for (const [index, sql] of migrations.entries()) {
    const version = index + 1;
    if (version <= from) {
      continue;
    }
    withWriteTransaction(driver, () => {
      // Another connection may have applied it since the read above.
      if (readUserVersion(driver) >= version) {
        return;
      }
      driver.exec(sql);
      driver.exec(`PRAGMA user_version = ${version}`);
    });
  }
  return { from, to: Math.max(from, migrations.length) };
}
