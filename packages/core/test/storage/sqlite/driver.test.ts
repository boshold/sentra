import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { number, object } from "zod";

import { SentraStorageError } from "#src/errors.js";
import { openBetterSqlite3 } from "#src/storage/sqlite/driver/better-sqlite3.js";
import { loadDriver } from "#src/storage/sqlite/driver/load.js";
import {
  openNodeSqlite,
  suppressSqliteExperimentalWarning,
} from "#src/storage/sqlite/driver/node.js";
import { withWriteTransaction } from "#src/storage/sqlite/driver/transaction.js";
import { BUSY_TIMEOUT_MS } from "#src/storage/sqlite/driver/types.js";
import type { SqliteDriver, SqliteDriverName } from "#src/storage/sqlite/driver/types.js";

import { RUNTIME_SQLITE_DRIVERS } from "../../helpers/sqlite.js";

vi.mock("#src/storage/sqlite/driver/better-sqlite3.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("#src/storage/sqlite/driver/better-sqlite3.js")>();
  return { openBetterSqlite3: vi.fn(actual.openBetterSqlite3) };
});
vi.mock("#src/storage/sqlite/driver/node.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("#src/storage/sqlite/driver/node.js")>();
  return { ...actual, openNodeSqlite: vi.fn(actual.openNodeSqlite) };
});

const OPENERS: Record<SqliteDriverName, (file: string) => Promise<SqliteDriver>> = {
  "better-sqlite3": openBetterSqlite3,
  node: openNodeSqlite,
};

async function canOpen(name: SqliteDriverName): Promise<boolean> {
  try {
    const driver = await OPENERS[name](":memory:");
    driver.close();
    return true;
  } catch {
    return false;
  }
}

const loadable: SqliteDriverName[] = [];
for (const name of RUNTIME_SQLITE_DRIVERS) {
  if (await canOpen(name)) {
    loadable.push(name);
  }
}
const betterSqlite3Loads = loadable.includes("better-sqlite3");

const countSchema = object({ c: number() });

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(path.join(tmpdir(), "sentra-driver-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe.each(loadable)("driver %s", (name) => {
  async function open(file: string): Promise<SqliteDriver> {
    return OPENERS[name](file);
  }

  it.each([[":memory:"], ["file"]])("round-trips text, int, blob and null (%s)", async (target) => {
    const driver = await open(target === "file" ? path.join(tempDir, "t.db") : target);
    try {
      expect(driver.name).toBe(name);
      driver.exec("CREATE TABLE t(id INTEGER PRIMARY KEY, s TEXT, n INTEGER, b BLOB, z TEXT)");
      const result = driver
        .prepare("INSERT INTO t(s, n, b, z) VALUES (?, ?, ?, ?)")
        .run("hello", 1_700_000_000_000, new Uint8Array([1, 2, 3]), null);
      expect(result).toEqual({ changes: 1 });
      expect(typeof result.changes).toBe("number");

      const row: unknown = driver.prepare("SELECT s, n, b, z FROM t WHERE id = ?").get(1);
      expect({ ...Object(row) }).toEqual({
        s: "hello",
        n: 1_700_000_000_000,
        b: new Uint8Array([1, 2, 3]),
        z: null,
      });
      expect(driver.prepare("SELECT s FROM t WHERE id = ?").get(99)).toBeUndefined();
      expect(driver.prepare("SELECT s FROM t").all()).toHaveLength(1);
    } finally {
      driver.close();
    }
  });

  it("returns BLOBs as plain Uint8Array", async () => {
    const driver = await open(":memory:");
    try {
      driver.exec("CREATE TABLE t(b BLOB)");
      driver.prepare("INSERT INTO t(b) VALUES (?)").run(new Uint8Array([9, 8, 7]));
      const rows = [
        driver.prepare("SELECT b FROM t").get(),
        ...driver.prepare("SELECT b FROM t").all(),
      ];
      for (const row of rows) {
        const value: unknown = Object(row).b;
        expect(value).toBeInstanceOf(Uint8Array);
        expect(Buffer.isBuffer(value)).toBe(false);
        expect([...(value instanceof Uint8Array ? value : [])]).toEqual([9, 8, 7]);
      }
    } finally {
      driver.close();
    }
  });

  it("opens with the busy timeout", async () => {
    const driver = await open(path.join(tempDir, "busy.db"));
    try {
      expect({ ...Object(driver.prepare("PRAGMA busy_timeout").get()) }).toEqual({
        timeout: BUSY_TIMEOUT_MS,
      });
    } finally {
      driver.close();
    }
  });

  it("commits write transactions", async () => {
    const driver = await open(":memory:");
    try {
      driver.exec("CREATE TABLE t(v INTEGER)");
      const value = withWriteTransaction(driver, () => {
        driver.prepare("INSERT INTO t(v) VALUES (?)").run(1);
        return "done";
      });
      expect(value).toBe("done");
      expect(countSchema.parse(driver.prepare("SELECT count(*) AS c FROM t").get()).c).toBe(1);
    } finally {
      driver.close();
    }
  });

  it("rolls back and rethrows the original error", async () => {
    const driver = await open(":memory:");
    try {
      driver.exec("CREATE TABLE t(v INTEGER)");
      const failure = new Error("boom");
      expect(() =>
        withWriteTransaction(driver, () => {
          driver.prepare("INSERT INTO t(v) VALUES (?)").run(1);
          throw failure;
        }),
      ).toThrow(failure);
      expect(countSchema.parse(driver.prepare("SELECT count(*) AS c FROM t").get()).c).toBe(0);
      withWriteTransaction(driver, () => driver.prepare("INSERT INTO t(v) VALUES (?)").run(2));
    } finally {
      driver.close();
    }
  });
});

describe("withWriteTransaction", () => {
  function fakeDriver(failOn?: string): { driver: SqliteDriver; calls: string[] } {
    const calls: string[] = [];
    const driver: SqliteDriver = {
      name: "node",
      exec(sql: string): void {
        calls.push(sql);
        if (sql === failOn) {
          throw new Error(`${sql} failed`);
        }
      },
      prepare(): never {
        throw new Error("unused");
      },
      close(): void {
        calls.push("close");
      },
    };
    return { driver, calls };
  }

  it("runs BEGIN IMMEDIATE, fn and COMMIT", () => {
    const { driver, calls } = fakeDriver();
    expect(withWriteTransaction(driver, () => 42)).toBe(42);
    expect(calls).toEqual(["BEGIN IMMEDIATE", "COMMIT"]);
  });

  it("keeps the original error when ROLLBACK fails", () => {
    const { driver, calls } = fakeDriver("ROLLBACK");
    const failure = new Error("original");
    expect(() =>
      withWriteTransaction(driver, () => {
        throw failure;
      }),
    ).toThrow(failure);
    expect(calls).toEqual(["BEGIN IMMEDIATE", "ROLLBACK"]);
  });
});

describe("loadDriver", () => {
  beforeEach(() => {
    vi.mocked(openBetterSqlite3).mockClear();
    vi.mocked(openNodeSqlite).mockClear();
  });

  it.skipIf(!betterSqlite3Loads)("auto picks better-sqlite3 when it loads", async () => {
    const driver = await loadDriver("auto", ":memory:");
    expect(driver.name).toBe("better-sqlite3");
    driver.close();
  });

  it("auto falls back to node when better-sqlite3 fails", async () => {
    vi.mocked(openBetterSqlite3).mockRejectedValueOnce(new Error("no binding"));
    const driver = await loadDriver("auto", ":memory:");
    expect(driver.name).toBe("node");
    driver.close();
  });

  it.each(["better-sqlite3", "node"] as const)("forced %s tries only that driver", async (name) => {
    const own = name === "node" ? openNodeSqlite : openBetterSqlite3;
    const other = name === "node" ? openBetterSqlite3 : openNodeSqlite;
    vi.mocked(own).mockRejectedValueOnce(new Error("nope"));
    await expect(loadDriver(name, ":memory:")).rejects.toBeInstanceOf(SentraStorageError);
    expect(vi.mocked(own)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(other)).not.toHaveBeenCalled();
  });

  describe("on Bun", () => {
    const realBun = process.versions.bun;

    beforeEach(() => {
      Object.defineProperty(process.versions, "bun", { value: "1.4.0", configurable: true });
    });

    afterEach(() => {
      if (realBun === undefined) {
        Reflect.deleteProperty(process.versions, "bun");
      } else {
        Object.defineProperty(process.versions, "bun", { value: realBun, configurable: true });
      }
    });

    it("auto never tries better-sqlite3", async () => {
      vi.mocked(openNodeSqlite).mockRejectedValueOnce(new Error("no node:sqlite"));
      await expect(loadDriver("auto", ":memory:")).rejects.toMatchObject({
        details: [{ driver: "node:sqlite", message: "no node:sqlite" }],
      });
      expect(vi.mocked(openBetterSqlite3)).not.toHaveBeenCalled();
    });

    it("forced better-sqlite3 is still tried", async () => {
      vi.mocked(openBetterSqlite3).mockRejectedValueOnce(new Error("nope"));
      await expect(loadDriver("better-sqlite3", ":memory:")).rejects.toBeInstanceOf(
        SentraStorageError,
      );
      expect(vi.mocked(openBetterSqlite3)).toHaveBeenCalledTimes(1);
    });
  });

  it.skipIf(process.versions.bun !== undefined)(
    "rejects with storage_unavailable listing every failure",
    async () => {
      vi.mocked(openBetterSqlite3).mockRejectedValueOnce(
        new Error("Cannot find module 'better-sqlite3'\nRequire stack: ..."),
      );
      vi.mocked(openNodeSqlite).mockRejectedValueOnce(
        new Error("No such built-in module: node:sqlite"),
      );
      const result = loadDriver("auto", ":memory:");
      await expect(result).rejects.toBeInstanceOf(SentraStorageError);
      await expect(result).rejects.toMatchObject({
        code: "storage_unavailable",
        details: [
          { driver: "better-sqlite3", message: "Cannot find module 'better-sqlite3'" },
          { driver: "node:sqlite", message: "No such built-in module: node:sqlite" },
        ],
      });
      await expect(result).rejects.toThrow(
        /\nbetter-sqlite3: Cannot find module 'better-sqlite3'\nnode:sqlite: No such built-in module: node:sqlite$/,
      );
    },
  );
});

describe("suppressSqliteExperimentalWarning", () => {
  let emitWarning: ReturnType<typeof stubEmitWarning>;

  function stubEmitWarning() {
    return vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
  }

  function forwarded(): unknown[][] {
    return emitWarning.mock.calls.map((call) => [...call]);
  }

  beforeEach(() => {
    emitWarning = stubEmitWarning();
  });

  afterEach(() => {
    emitWarning.mockRestore();
  });

  it("drops only SQLite experimental warnings and restores emitWarning", async () => {
    const result = await suppressSqliteExperimentalWarning(async () => {
      process.emitWarning("SQLite is an experimental feature", "ExperimentalWarning");
      process.emitWarning("SQLite options", { type: "ExperimentalWarning" });
      process.emitWarning("other", "DeprecationWarning");
      process.emitWarning("Fetch is experimental", "ExperimentalWarning");
      return "ok";
    });
    expect(result).toBe("ok");
    expect(process.emitWarning).toBe(emitWarning);
    expect(forwarded()).toEqual([
      ["other", "DeprecationWarning"],
      ["Fetch is experimental", "ExperimentalWarning"],
    ]);
  });

  it("restores emitWarning when fn rejects", async () => {
    const failure = new Error("fail");
    await expect(
      suppressSqliteExperimentalWarning(async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(process.emitWarning).toBe(emitWarning);
  });

  it("keeps filtering until the last overlapping call ends", async () => {
    let releaseOuter = (): void => undefined;
    let releaseInner = (): void => undefined;
    const outerRun = suppressSqliteExperimentalWarning(
      async () =>
        new Promise<void>((resolve) => {
          releaseOuter = resolve;
        }),
    );
    const innerRun = suppressSqliteExperimentalWarning(
      async () =>
        new Promise<void>((resolve) => {
          releaseInner = resolve;
        }),
    );

    releaseOuter();
    await outerRun;
    expect(process.emitWarning).not.toBe(emitWarning);
    process.emitWarning("SQLite is experimental", "ExperimentalWarning");

    releaseInner();
    await innerRun;
    expect(process.emitWarning).toBe(emitWarning);
    expect(forwarded()).toEqual([]);

    await suppressSqliteExperimentalWarning(async () => undefined);
    expect(process.emitWarning).toBe(emitWarning);
  });
});
