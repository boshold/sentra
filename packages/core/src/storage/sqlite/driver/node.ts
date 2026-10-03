import type { DatabaseSync } from "node:sqlite";

import { BUSY_TIMEOUT_MS } from "#src/storage/sqlite/driver/types.js";
import type {
  SqliteDriver,
  SqliteParam,
  SqliteStatement,
} from "#src/storage/sqlite/driver/types.js";

function warningType(warning: string | Error, rest: unknown[]): unknown {
  const [typeOrOptions] = rest;
  if (typeof typeOrOptions === "string") {
    return typeOrOptions;
  }
  if (typeof typeOrOptions === "object" && typeOrOptions !== null && "type" in typeOrOptions) {
    const { type } = typeOrOptions;
    return type;
  }
  return typeof warning === "string" ? undefined : warning.name;
}

function isSqliteExperimentalWarning(warning: string | Error, rest: unknown[]): boolean {
  const message = typeof warning === "string" ? warning : warning.message;
  return warningType(warning, rest) === "ExperimentalWarning" && /sqlite/i.test(message);
}

function needsWarningFilter(): boolean {
  return process.versions.bun === undefined && process.versions.node.split(".")[0] === "22";
}

async function importDatabaseSync(): Promise<typeof DatabaseSync> {
  const mod = await import("node:sqlite");
  return mod.DatabaseSync;
}

let activeFilters = 0;
let savedEmitWarning: typeof process.emitWarning | undefined = undefined;

/** Only the outermost of overlapping calls installs and restores the filter. */
function installWarningFilter(): void {
  activeFilters += 1;
  if (activeFilters > 1) {
    return;
  }
  // oxlint-disable-next-line typescript-eslint/unbound-method -- restored as-is, called via Reflect.apply
  const original = process.emitWarning;
  savedEmitWarning = original;
  process.emitWarning = function emitWarning(warning: string | Error, ...rest: unknown[]): void {
    if (isSqliteExperimentalWarning(warning, rest)) {
      return;
    }
    Reflect.apply(original, process, [warning, ...rest]);
  };
}

function removeWarningFilter(): void {
  activeFilters -= 1;
  if (activeFilters === 0 && savedEmitWarning) {
    process.emitWarning = savedEmitWarning;
    savedEmitWarning = undefined;
  }
}

function wrap(db: DatabaseSync): SqliteDriver {
  return {
    name: "node",
    exec(sql: string): void {
      db.exec(sql);
    },
    prepare(sql: string): SqliteStatement {
      const statement = db.prepare(sql);
      return {
        run(...params: SqliteParam[]): { changes: number } {
          return { changes: Number(statement.run(...params).changes) };
        },
        get(...params: SqliteParam[]): unknown {
          return statement.get(...params);
        },
        all(...params: SqliteParam[]): unknown[] {
          return statement.all(...params);
        },
      };
    },
    close(): void {
      db.close();
    },
  };
}

export async function suppressSqliteExperimentalWarning<T>(fn: () => Promise<T>): Promise<T> {
  installWarningFilter();
  try {
    return await fn();
  } finally {
    removeWarningFilter();
  }
}

export async function loadNodeSqlite(): Promise<(path: string) => SqliteDriver> {
  const Database = needsWarningFilter()
    ? await suppressSqliteExperimentalWarning(importDatabaseSync)
    : await importDatabaseSync();
  return (path) => {
    const db = new Database(path, { timeout: BUSY_TIMEOUT_MS });
    try {
      db.prepare("SELECT 1").get();
      return wrap(db);
    } catch (error) {
      db.close();
      throw error;
    }
  };
}

export async function openNodeSqlite(path: string): Promise<SqliteDriver> {
  const open = await loadNodeSqlite();
  return open(path);
}
