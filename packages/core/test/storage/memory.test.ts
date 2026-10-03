import { SentraConfigError } from "#src/errors.js";
import { memoryStorage } from "#src/storage/memory/index.js";

import { makeBatch, runStorageContract } from "../../../../test/storage-contract.js";

runStorageContract("memory", () => memoryStorage());

describe("memoryStorage", () => {
  it("reports memory type and no driver", async () => {
    const storage = memoryStorage();
    expect(storage.type).toBe("memory");
    expect(await storage.init()).toEqual({ driver: null, path: null });
  });

  it.each([[0], [1.5], [-1], [Number.NaN]])("rejects maxItems %j", (maxItems) => {
    expect(() => memoryStorage({ maxItems })).toThrow(SentraConfigError);
    try {
      memoryStorage({ maxItems });
    } catch (error) {
      expect(error).toMatchObject({ code: "invalid_option" });
    }
  });

  it("evicts the oldest items beyond maxItems", async () => {
    const storage = memoryStorage({ maxItems: 3 });
    await storage.init();
    const batches = [
      makeBatch({ items: [{ issueId: "0000000000000001" }] }),
      makeBatch({
        items: [{ kind: "attachment", itemType: "attachment", blob: new Uint8Array([1]) }],
      }),
      makeBatch({ items: [{ issueId: "0000000000000002" }] }),
      makeBatch({ items: [{ issueId: "0000000000000002" }] }),
      makeBatch({ items: [{}] }),
    ];
    for (const batch of batches) {
      await storage.write(batch);
    }
    const ids = batches.map((batch) => batch.items[0]?.item.id ?? "");
    const listed = await storage.listItems({}, { limit: 10, cursor: null });
    expect(listed.items.map((item) => item.id)).toEqual(ids.slice(2).toReversed());

    expect(await storage.getItem(ids[0] ?? "")).toBeNull();
    expect(await storage.getIssue("0000000000000001")).toBeNull();
    expect(await storage.getEnvelope(batches[0]?.envelope.id ?? "")).toBeNull();
    expect(await storage.getBlob(ids[1] ?? "")).toBeNull();
    expect(await storage.getEnvelope(batches[1]?.envelope.id ?? "")).toBeNull();
    await expect(storage.getIssue("0000000000000002")).resolves.toHaveProperty("count", 2);
    const [scope] = await storage.listScopes({});
    expect(scope?.itemCount).toBe(3);

    await storage.write(makeBatch({ items: [{}] }));
    const survivor = await storage.getIssue("0000000000000002");
    expect(survivor).toMatchObject({ count: 2, services: ["web"] });
  });

  it("bounds failed envelopes to maxItems", async () => {
    const storage = memoryStorage({ maxItems: 2 });
    const batches = [1, 2, 3].map(() => makeBatch({ parseError: "bad" }));
    for (const batch of batches) {
      await storage.write(batch);
    }
    const page = await storage.listFailedEnvelopes({}, { limit: 10, cursor: null });
    expect(page.items.map((envelope) => envelope.id)).toEqual(
      batches
        .slice(1)
        .map((batch) => batch.envelope.id)
        .toReversed(),
    );
  });

  it("never clones raw envelope bodies when copying metadata", async () => {
    const storage = memoryStorage();
    const batch = makeBatch({ parseError: "bad", body: new Uint8Array([1, 2, 3]) });
    const clone = vi.spyOn(globalThis, "structuredClone");
    try {
      await storage.write(batch);
      const page = await storage.listFailedEnvelopes({}, { limit: 10, cursor: null });
      expect(page.items[0]).not.toHaveProperty("body");
      const stored = await storage.getEnvelope(batch.envelope.id);
      expect(stored?.body).toEqual(new Uint8Array([1, 2, 3]));
      expect(clone).toHaveBeenCalled();
      for (const [value] of clone.mock.calls) {
        expect(value).not.toHaveProperty("body");
      }
    } finally {
      clone.mockRestore();
    }
  });

  it("stores a copy of blob views", async () => {
    const storage = memoryStorage();
    const buffer = new Uint8Array(1024);
    buffer.set([1, 2, 3], 100);
    const batch = makeBatch({
      items: [{ kind: "attachment", itemType: "attachment", blob: buffer.subarray(100, 103) }],
    });
    await storage.write(batch);
    const blob = await storage.getBlob(batch.items[0]?.item.id ?? "");
    expect(blob?.buffer.byteLength).toBe(3);
  });
});
