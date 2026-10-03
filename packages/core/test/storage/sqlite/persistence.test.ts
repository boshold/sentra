import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createSentra, sqliteStorage } from "#src/index.js";
import type { ResolvedPage } from "#src/storage/types.js";

import { fixtureToRequest, loadEnvelopeFixture } from "../../../../../test/fixtures/envelopes.js";
import { makeBatch } from "../../../../../test/storage-contract.js";
import { loadableSqliteDrivers } from "../../helpers/sqlite.js";

const drivers = await loadableSqliteDrivers();

const ALL: ResolvedPage = { limit: 500, cursor: null };
const ISSUE = "00000000000000a1";

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(path.join(tmpdir(), "sentra-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe.each(drivers)("sqlite persistence with %s", (driverName) => {
  it("keeps all data across close() and a new instance", async () => {
    const file = path.join(tempDir, "data", "sentra.db");
    const first = sqliteStorage({ path: file, driver: driverName });
    await first.init();
    const batch = makeBatch({
      body: new Uint8Array([0, 1, 2]),
      items: [
        { issueId: ISSUE, title: "Boom" },
        { kind: "attachment", itemType: "attachment", blob: new Uint8Array([9, 0, 9]) },
      ],
    });
    await first.write(batch);
    await first.close();

    const second = sqliteStorage({ path: file, driver: driverName });
    await second.init();
    try {
      const [error, attachment] = batch.items.map(({ item }) => item);
      expect(await second.getItem(error?.id ?? "")).toEqual(error);
      expect(await second.getIssue(ISSUE)).toMatchObject({ count: 1, title: "Boom" });
      expect(await second.listScopes({})).toEqual([
        expect.objectContaining({ itemCount: 2, issueCount: 1 }),
      ]);
      expect(await second.getBlob(attachment?.id ?? "")).toEqual(new Uint8Array([9, 0, 9]));
      expect(await second.getEnvelope(batch.envelope.id)).toEqual(batch.envelope);
      const page = await second.listItems({}, ALL);
      expect(page.items).toHaveLength(2);
    } finally {
      await second.close();
    }
  });

  it("closes idempotently and rejects later calls", async () => {
    const storage = sqliteStorage({ path: path.join(tempDir, "c.db"), driver: driverName });
    await storage.init();
    await storage.close();
    await storage.close();
    for (const call of [
      async () => storage.getBlob("x"),
      async () => storage.getEnvelope("x"),
      async () => storage.deleteItems({}),
      async () => storage.pruneIdleSessions(new Date()),
      async () => storage.pruneOldItems(["log"], new Date()),
      async () => storage.pruneOldItems([], new Date()),
      async () => storage.vacuum(),
      async () => storage.write(makeBatch({})),
    ]) {
      await expect(call()).rejects.toMatchObject({ code: "storage_unavailable" });
    }
  });

  it("works end to end with createSentra", async () => {
    const file = path.join(tempDir, "sentra.db");
    const sentra = await createSentra({
      storage: sqliteStorage({ path: file, driver: driverName }),
    });
    try {
      expect(sentra.info().storage).toEqual({ type: "sqlite", driver: driverName, path: file });
      const response = await sentra.handle(fixtureToRequest(loadEnvelopeFixture("node-error")));
      expect(response.status).toBe(200);
      const issues = await sentra.query.listIssues();
      expect(issues.items).toHaveLength(1);
      expect(await sentra.clear({})).toEqual({ itemsDeleted: 1 });
      const afterClear = await sentra.query.listIssues();
      expect(afterClear.items).toEqual([]);
      await expect(sentra.prune()).resolves.toEqual(
        expect.objectContaining({ sessionsDeleted: expect.any(Number) }),
      );
    } finally {
      await sentra.close();
    }
  });
});
