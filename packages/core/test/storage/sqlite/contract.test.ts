import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { array, literal, string } from "zod";

import type { SqliteDriverName } from "#src/storage/sqlite/driver/types.js";
import { sqliteStorage } from "#src/storage/sqlite/index.js";

import { runStorageContract } from "../../../../../test/storage-contract.js";
import { loadableSqliteDrivers } from "../../helpers/sqlite.js";

const DRIVERS: readonly SqliteDriverName[] = ["better-sqlite3", "node"];

const requiredSchema = string()
  .optional()
  .transform((value) =>
    (value ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean),
  )
  .pipe(array(literal(DRIVERS)));

const available = await loadableSqliteDrivers();
const required = requiredSchema.parse(process.env.SENTRA_REQUIRE_SQLITE_DRIVERS);

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDb(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "sentra-contract-"));
  tempDirs.push(dir);
  return path.join(dir, "sentra.db");
}

describe("sqlite driver availability", () => {
  it.each(required)("required driver %s loads", (name) => {
    expect(available).toContain(name);
  });

  it("auto picks better-sqlite3 when it loads (never on Bun), else node", async () => {
    const storage = sqliteStorage({ path: ":memory:", driver: "auto" });
    const info = await storage.init();
    await storage.close();
    expect(info.driver).toBe(available.includes("better-sqlite3") ? "better-sqlite3" : "node");
  });
});

for (const name of DRIVERS) {
  describe.skipIf(!available.includes(name))(`driver ${name}`, () => {
    runStorageContract(`sqlite ${name} (file)`, () =>
      sqliteStorage({ path: tempDb(), driver: name }),
    );
  });
}

describe.skipIf(available.length === 0)("driver auto", () => {
  runStorageContract("sqlite auto (:memory:)", () =>
    sqliteStorage({ path: ":memory:", driver: "auto" }),
  );
});
