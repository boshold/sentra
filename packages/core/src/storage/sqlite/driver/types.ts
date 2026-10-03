export type SqliteDriverName = "better-sqlite3" | "node";

export type SqliteDriverOption = "auto" | SqliteDriverName;

/** No `undefined`/`boolean`: the drivers bind them differently. */
export type SqliteParam = string | number | Uint8Array | null;

export interface SqliteStatement {
  run(...params: SqliteParam[]): { changes: number };
  /** `undefined` when no row matches. */
  get(...params: SqliteParam[]): unknown;
  all(...params: SqliteParam[]): unknown[];
}

export interface SqliteDriver {
  readonly name: SqliteDriverName;
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

export const BUSY_TIMEOUT_MS = 5000;
