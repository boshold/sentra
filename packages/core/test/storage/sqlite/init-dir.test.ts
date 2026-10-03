import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { SentraStorageError } from "#src/errors.js";
import { sqliteStorage } from "#src/storage/sqlite/index.js";

describe("sqliteStorage init directory", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "sentra-init-dir-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("throws storage_unavailable when the parent directory cannot be created", async () => {
    const blocker = path.join(dir, "file");
    writeFileSync(blocker, "");
    const storage = sqliteStorage({ path: path.join(blocker, "sub", "sentra.db") });
    const failure: unknown = await storage.init().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(SentraStorageError);
    expect(failure).toMatchObject({ code: "storage_unavailable", cause: expect.any(Error) });
    expect(failure).toHaveProperty("message", expect.stringContaining(path.join(blocker, "sub")));
  });

  async function initFailure(file: string): Promise<unknown> {
    try {
      await sqliteStorage({ path: file }).init();
      return undefined;
    } catch (error) {
      return error;
    }
  }

  it("reports a path that is a directory as an open failure", async () => {
    const failure = await initFailure(dir);
    expect(failure).toBeInstanceOf(SentraStorageError);
    expect(failure).toMatchObject({ code: "storage_unavailable", cause: expect.any(Error) });
    expect(failure).toHaveProperty(
      "message",
      expect.stringMatching(/^sqliteStorage: cannot open database file .+: .+/),
    );
    expect(failure).toHaveProperty("message", expect.stringContaining(dir));
    expect(failure).toHaveProperty("message", expect.not.stringContaining("No SQLite driver"));
  });

  it.skipIf(process.getuid?.() === 0)(
    "reports an unwritable directory as an open failure",
    async () => {
      const locked = path.join(dir, "locked");
      mkdirSync(locked);
      chmodSync(locked, 0o500);
      try {
        const file = path.join(locked, "sentra.db");
        const failure = await initFailure(file);
        expect(failure).toHaveProperty(
          "message",
          expect.stringContaining(`sqliteStorage: cannot open database file ${file}: `),
        );
      } finally {
        chmodSync(locked, 0o700);
      }
    },
  );
});
