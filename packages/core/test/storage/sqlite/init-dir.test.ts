import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
});
