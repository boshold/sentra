import { SentraStorageError } from "#src/errors.js";
import { loadBetterSqlite3 } from "#src/storage/sqlite/driver/better-sqlite3.js";
import { loadNodeSqlite } from "#src/storage/sqlite/driver/node.js";
import type {
  SqliteDriver,
  SqliteDriverName,
  SqliteDriverOption,
} from "#src/storage/sqlite/driver/types.js";

interface Candidate {
  label: string;
  load: () => Promise<(path: string) => SqliteDriver>;
}

const CANDIDATES: Record<SqliteDriverName, Candidate> = {
  "better-sqlite3": { label: "better-sqlite3", load: loadBetterSqlite3 },
  node: { label: "node:sqlite", load: loadNodeSqlite },
};

/** Bun (seen on 1.4.x) aborts with an uncatchable NAPI panic when loading better-sqlite3. */
function autoOrder(): SqliteDriverName[] {
  return process.versions.bun === undefined ? ["better-sqlite3", "node"] : ["node"];
}

interface DriverLoadFailure {
  driver: string;
  message: string;
}

function firstLine(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split("\n")[0] ?? message;
}

/** Falls back only when a driver cannot load; a file that cannot be opened fails at once. */
export async function loadDriver(option: SqliteDriverOption, path: string): Promise<SqliteDriver> {
  const names = option === "auto" ? autoOrder() : [option];
  const failures: DriverLoadFailure[] = [];
  for (const name of names) {
    const candidate = CANDIDATES[name];
    const open = await candidate.load().catch((error: unknown) => {
      failures.push({ driver: candidate.label, message: firstLine(error) });
      return null;
    });
    if (open === null) {
      continue;
    }
    try {
      return open(path);
    } catch (error) {
      throw new SentraStorageError(
        "storage_unavailable",
        `sqliteStorage: cannot open database file ${path}: ${firstLine(error)}`,
        { cause: error },
      );
    }
  }
  const lines = failures.map((failure) => `${failure.driver}: ${failure.message}`);
  throw new SentraStorageError(
    "storage_unavailable",
    `No SQLite driver could be loaded:\n${lines.join("\n")}`,
    { details: failures },
  );
}
