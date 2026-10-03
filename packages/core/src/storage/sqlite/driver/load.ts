import { SentraStorageError } from "#src/errors.js";
import { openBetterSqlite3 } from "#src/storage/sqlite/driver/better-sqlite3.js";
import { openNodeSqlite } from "#src/storage/sqlite/driver/node.js";
import type {
  SqliteDriver,
  SqliteDriverName,
  SqliteDriverOption,
} from "#src/storage/sqlite/driver/types.js";

interface Candidate {
  label: string;
  open: (path: string) => Promise<SqliteDriver>;
}

const CANDIDATES: Record<SqliteDriverName, Candidate> = {
  "better-sqlite3": { label: "better-sqlite3", open: openBetterSqlite3 },
  node: { label: "node:sqlite", open: openNodeSqlite },
};

/** Bun 1.4.0 aborts with an uncatchable NAPI panic when loading better-sqlite3. */
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

export async function loadDriver(option: SqliteDriverOption, path: string): Promise<SqliteDriver> {
  const names = option === "auto" ? autoOrder() : [option];
  const failures: DriverLoadFailure[] = [];
  for (const name of names) {
    const candidate = CANDIDATES[name];
    try {
      return await candidate.open(path);
    } catch (error) {
      failures.push({ driver: candidate.label, message: firstLine(error) });
    }
  }
  const lines = failures.map((failure) => `${failure.driver}: ${failure.message}`);
  throw new SentraStorageError(
    "storage_unavailable",
    `No SQLite driver could be loaded:\n${lines.join("\n")}`,
    { details: failures },
  );
}
