import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { number, object, string } from "zod";

import { SentraConfigError, SentraStorageError } from "#src/errors.js";
import { loadDriver } from "#src/storage/sqlite/driver/load.js";
import type { SqliteDriver } from "#src/storage/sqlite/driver/types.js";
import { sqliteStorage } from "#src/storage/sqlite/index.js";
import {
  MIGRATIONS,
  SCHEMA_VERSION,
  assertSupportedVersion,
  readUserVersion,
  runMigrations,
} from "#src/storage/sqlite/migrations.js";
import { SCHEMA_V1 } from "#src/storage/sqlite/schema.js";

import { SQLITE_OPENERS, loadableSqliteDrivers } from "../../helpers/sqlite.js";

const opened: SqliteDriver[] = [];

vi.mock("#src/storage/sqlite/driver/load.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("#src/storage/sqlite/driver/load.js")>();
  return {
    loadDriver: vi.fn(async (...args: Parameters<typeof actual.loadDriver>) => {
      const driver = await actual.loadDriver(...args);
      opened.push(driver);
      return driver;
    }),
  };
});

const EXPECTED_TABLES = ["blobs", "envelopes", "issues", "items", "scopes"];
const EXPECTED_INDEXES = [
  "envelopes_failed",
  "envelopes_scope",
  "issues_scope",
  "items_event_id",
  "items_issue",
  "items_issue_service",
  "items_kind",
  "items_kind_received",
  "items_scope_time",
  "items_timestamp",
  "items_trace",
];

const nameRow = object({ name: string() });
const journalRow = object({ journal_mode: string() });
const countRow = object({ c: number() });

const drivers = await loadableSqliteDrivers();

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(path.join(tmpdir(), "sentra-"));
  opened.length = 0;
  vi.mocked(loadDriver).mockClear();
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function names(driver: SqliteDriver, type: "table" | "index"): string[] {
  return driver
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = ? AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all(type)
    .map((row) => nameRow.parse(row).name);
}

function pragma(driver: SqliteDriver, name: string): unknown {
  return { ...Object(driver.prepare(`PRAGMA ${name}`).get()) };
}

describe.each(drivers)("sqliteStorage with %s", (driverName) => {
  async function openRaw(file: string): Promise<SqliteDriver> {
    return SQLITE_OPENERS[driverName](file);
  }

  it("creates schema v1 with pragmas on a new file", async () => {
    const file = path.join(tempDir, "nested", "deeper", "sentra.db");
    const storage = sqliteStorage({ path: file, driver: driverName });
    expect(await storage.init()).toEqual({ driver: driverName, path: path.resolve(file) });
    expect(existsSync(file)).toBe(true);

    const [driver] = opened;
    if (!driver) {
      throw new Error("no driver opened");
    }
    try {
      expect(pragma(driver, "user_version")).toEqual({ user_version: 1 });
      expect(names(driver, "table")).toEqual(EXPECTED_TABLES);
      expect(names(driver, "index")).toEqual(EXPECTED_INDEXES);
      expect(pragma(driver, "journal_mode")).toEqual({ journal_mode: "wal" });
      expect(pragma(driver, "synchronous")).toEqual({ synchronous: 1 });
      expect(pragma(driver, "foreign_keys")).toEqual({ foreign_keys: 1 });
      expect(pragma(driver, "busy_timeout")).toEqual({ timeout: 5000 });
    } finally {
      await storage.close();
    }
  });

  it("re-opens an existing v1 file without migrating and keeps rows", async () => {
    const file = path.join(tempDir, "sentra.db");
    const first = sqliteStorage({ path: file, driver: driverName });
    await first.init();
    opened[0]
      ?.prepare(
        "INSERT INTO scopes (project, session, service, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run("p", "s", "svc", 1, 2);
    await first.close();

    const second = sqliteStorage({ path: file, driver: driverName });
    await second.init();
    const [, driver] = opened;
    if (!driver) {
      throw new Error("no driver opened");
    }
    try {
      expect(runMigrations(driver)).toEqual({ from: 1, to: 1 });
      expect(countRow.parse(driver.prepare("SELECT count(*) AS c FROM scopes").get()).c).toBe(1);
    } finally {
      await second.close();
    }
  });

  it("rejects a newer schema without touching the file", async () => {
    const file = path.join(tempDir, "future.db");
    const raw = await openRaw(file);
    raw.exec("CREATE TABLE x (v INTEGER); PRAGMA user_version = 2");
    raw.close();

    const storage = sqliteStorage({ path: file, driver: driverName });
    const result = storage.init();
    await expect(result).rejects.toBeInstanceOf(SentraStorageError);
    await expect(result).rejects.toMatchObject({ code: "schema_too_new" });
    await expect(result).rejects.toThrow(/schema too new.*\b2\b.*\b1\b/);

    const [loaded] = opened;
    expect(() => loaded?.prepare("SELECT 1").get()).toThrow();

    const check = await openRaw(file);
    try {
      expect(journalRow.parse(check.prepare("PRAGMA journal_mode").get()).journal_mode).toBe(
        "delete",
      );
      expect(readUserVersion(check)).toBe(2);
    } finally {
      check.close();
    }
  });

  it("rolls back a failing migration and keeps user_version", async () => {
    const driver = await openRaw(":memory:");
    try {
      expect(runMigrations(driver, [SCHEMA_V1])).toEqual({ from: 0, to: 1 });
      expect(() => runMigrations(driver, [SCHEMA_V1, "CREATE TABLE broken ("])).toThrow();
      expect(readUserVersion(driver)).toBe(1);
      expect(names(driver, "table")).not.toContain("broken");
    } finally {
      driver.close();
    }
  });

  it("runs a pending migration in order", async () => {
    const driver = await openRaw(":memory:");
    try {
      runMigrations(driver);
      expect(runMigrations(driver, [SCHEMA_V1, "CREATE TABLE extra (v INTEGER)"])).toEqual({
        from: 1,
        to: 2,
      });
      expect(readUserVersion(driver)).toBe(2);
      expect(names(driver, "table")).toContain("extra");
    } finally {
      driver.close();
    }
  });

  it("supports :memory:", async () => {
    const storage = sqliteStorage({ path: ":memory:", driver: driverName });
    expect(await storage.init()).toEqual({ driver: driverName, path: ":memory:" });
    const [driver] = opened;
    expect(driver ? readUserVersion(driver) : 0).toBe(1);
    await storage.close();
  });
});

describe("sqliteStorage", () => {
  it("does no I/O before init()", async () => {
    const file = path.join(tempDir, "missing", "sentra.db");
    const storage = sqliteStorage({ path: file });
    expect(storage.type).toBe("sqlite");
    expect(existsSync(path.dirname(file))).toBe(false);
    expect(vi.mocked(loadDriver)).not.toHaveBeenCalled();
    await storage.close();
  });

  it("uses the auto driver by default", async () => {
    const storage = sqliteStorage({ path: ":memory:" });
    await storage.init();
    expect(vi.mocked(loadDriver)).toHaveBeenCalledWith("auto", ":memory:");
    await storage.close();
  });

  it.each([[{ path: "" }], [{ path: "x.db", driver: "bun" }], [{ path: "x.db", extra: true }]])(
    "rejects invalid options %j",
    (options) => {
      expect(() => Reflect.apply(sqliteStorage, undefined, [options])).toThrow(SentraConfigError);
      expect(() => Reflect.apply(sqliteStorage, undefined, [options])).toThrow(
        expect.objectContaining({ code: "invalid_option" }),
      );
    },
  );

  it("throws storage_unavailable before init() and after close()", async () => {
    const storage = sqliteStorage({ path: ":memory:" });
    await expect(storage.listScopes({})).rejects.toMatchObject({ code: "storage_unavailable" });
    await storage.init();
    await storage.close();
    await expect(storage.listScopes({})).rejects.toMatchObject({ code: "storage_unavailable" });
  });
});

describe("migrations", () => {
  it("has one migration per schema version", () => {
    expect(MIGRATIONS).toEqual([SCHEMA_V1]);
    expect(SCHEMA_VERSION).toBe(1);
  });

  it("assertSupportedVersion accepts known versions", () => {
    expect(() => assertSupportedVersion(0)).not.toThrow();
    expect(() => assertSupportedVersion(1)).not.toThrow();
    expect(() => assertSupportedVersion(3, ["a", "b"])).toThrow(SentraStorageError);
  });
});
