import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { sqliteStorage } from "#src/storage/sqlite/index.js";
import type { ResolvedPage } from "#src/storage/types.js";

import { makeBatch } from "../../../../../test/storage-contract.js";
import { loadableSqliteDrivers } from "../../helpers/sqlite.js";

const drivers = await loadableSqliteDrivers();

const WRITER = path.join(import.meta.dirname, "fixtures", "writer.mjs");
const BATCHES = 50;
const ROUNDS = 200;

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(path.join(tmpdir(), "sentra-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

interface ChildResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Starts the writer and resolves `ready` once it has opened the DB. */
function startWriter(dbPath: string): { ready: Promise<void>; done: Promise<ChildResult> } {
  const child = spawn(process.execPath, [WRITER, dbPath, String(ROUNDS)], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  let markReady = (): void => undefined;
  const ready = new Promise<void>((resolve) => {
    markReady = resolve;
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
    if (stdout.includes("ready\n")) {
      markReady();
    }
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const done = new Promise<ChildResult>((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code) => {
      markReady();
      resolve({ code, stdout, stderr });
    });
  });
  return { ready, done };
}

describe.each(drivers)("two processes writing with %s", (driverName) => {
  it("serializes write transactions without errors", async () => {
    const dbPath = path.join(tempDir, "shared.db");
    const storage = sqliteStorage({ path: dbPath, driver: driverName });
    await storage.init();
    try {
      const writer = startWriter(dbPath);
      await writer.ready;

      const page: ResolvedPage = { limit: 10, cursor: null };
      for (let index = 0; index < BATCHES; index += 1) {
        await storage.write(makeBatch({ items: [{ kind: "log", itemType: "log" }] }));
        await storage.listItems({}, page);
      }

      const result = await writer.done;
      // Stderr may hold Node 22's ExperimentalWarning; failures are counted in stdout.
      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout.trim().split("\n").at(-1)).toBe(JSON.stringify({ errors: 0 }));

      const all = await storage.listItems({}, { limit: 500, cursor: null });
      expect(all.items).toHaveLength(BATCHES);
      const writerScope = await storage.listScopes({ project: "writer" });
      expect(writerScope.map((scope) => scope.itemCount)).toEqual([ROUNDS]);
    } finally {
      await storage.close();
    }
  });
});
