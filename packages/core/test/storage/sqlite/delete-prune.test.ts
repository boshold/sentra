import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { int, object } from "zod";

import type { SqliteDriver } from "#src/storage/sqlite/driver/types.js";
import { sqliteStorage } from "#src/storage/sqlite/index.js";
import type { ResolvedPage, StorageAdapter } from "#src/storage/types.js";

import { makeBatch } from "../../../../../test/storage-contract.js";
import type { WriteSpec } from "../../../../../test/storage-contract.js";
import { SQLITE_OPENERS, loadableSqliteDrivers } from "../../helpers/sqlite.js";

const drivers = await loadableSqliteDrivers();

const T0 = Date.parse("2026-10-01T00:00:00.000Z");
const HOUR = 3_600_000;
const ALL: ResolvedPage = { limit: 500, cursor: null };
const ISSUE = "00000000000000a1";
const NOISE = ["span", "transaction", "log", "other"] as const;

const countRow = object({ c: int() });

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(path.join(tmpdir(), "sentra-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe.each(drivers)("sqlite delete and prune with %s", (driverName) => {
  let storage: StorageAdapter;
  let raw: SqliteDriver;
  let file: string;

  beforeEach(async () => {
    file = path.join(tempDir, "sentra.db");
    storage = sqliteStorage({ path: file, driver: driverName });
    await storage.init();
    raw = await SQLITE_OPENERS[driverName](file);
  });

  afterEach(async () => {
    raw.close();
    await storage.close();
  });

  function count(table: string): number {
    return countRow.parse(raw.prepare(`SELECT count(*) AS c FROM ${table}`).get()).c;
  }

  async function write(spec: WriteSpec): Promise<{ envelopeId: string; ids: string[] }> {
    const batch = makeBatch(spec);
    await storage.write(batch);
    return { envelopeId: batch.envelope.id, ids: batch.items.map(({ item }) => item.id) };
  }

  async function itemCounts(): Promise<number[]> {
    const scopes = await storage.listScopes({});
    return scopes.map((scope) => scope.itemCount);
  }

  describe("deleteItems", () => {
    it("deletes records, their blobs and empty envelopes", async () => {
      const kept = await write({
        items: [{ kind: "attachment", blob: new Uint8Array([1]) }, { kind: "log" }],
      });
      const gone = await write({ items: [{ kind: "attachment", blob: new Uint8Array([2]) }] });
      await write({ parseError: "bad" });

      expect(await storage.deleteItems({ kind: ["attachment"] })).toBe(2);
      expect(count("blobs")).toBe(0);
      expect(await storage.getEnvelope(kept.envelopeId)).not.toBeNull();
      expect(await storage.getEnvelope(gone.envelopeId)).toBeNull();
      expect(count("envelopes")).toBe(2);
      expect(await itemCounts()).toEqual([1]);
    });

    it("recounts issues and drops issues without records", async () => {
      await write({ receivedAt: iso(T0), items: [{ issueId: ISSUE, title: "first" }] });
      const second = await write({
        receivedAt: iso(T0 + HOUR),
        items: [{ issueId: ISSUE, title: "second" }],
      });
      await write({ receivedAt: iso(T0 + 2 * HOUR), items: [{ issueId: ISSUE, title: "third" }] });
      expect(await storage.getIssue(ISSUE)).toMatchObject({ count: 3 });

      expect(await storage.deleteItems({ q: "first" })).toBe(1);
      expect(await storage.deleteItems({ q: "third" })).toBe(1);
      expect(await storage.getIssue(ISSUE)).toMatchObject({
        count: 1,
        firstSeenAt: iso(T0 + HOUR),
        lastSeenAt: iso(T0 + HOUR),
        lastItemId: second.ids[0],
      });
      expect(await storage.deleteItems({})).toBe(1);
      expect(await storage.getIssue(ISSUE)).toBeNull();
      expect(count("issues")).toBe(0);
      expect(count("envelopes")).toBe(0);
      expect(await itemCounts()).toEqual([0]);
    });
  });

  describe("pruneIdleSessions", () => {
    it("deletes only sessions whose newest service is older than the cutoff", async () => {
      await write({
        scope: { session: "stale" },
        receivedAt: iso(T0),
        items: [{ issueId: ISSUE }, { kind: "attachment", blob: new Uint8Array([1]) }],
      });
      await write({ scope: { session: "stale" }, receivedAt: iso(T0), parseError: "bad" });
      await write({
        scope: { session: "mixed", service: "web" },
        receivedAt: iso(T0),
        items: [{}],
      });
      await write({
        scope: { session: "mixed", service: "api" },
        receivedAt: iso(T0 + 2 * HOUR),
        items: [{}],
      });

      expect(await storage.pruneIdleSessions(new Date(T0 + HOUR))).toEqual({
        sessionsDeleted: 1,
        itemsDeleted: 2,
      });
      for (const table of ["envelopes", "items", "issues", "scopes"]) {
        const row = raw
          .prepare(`SELECT count(*) AS c FROM ${table} WHERE session = ?`)
          .get("stale");
        expect(countRow.parse(row).c).toBe(0);
      }
      expect(count("blobs")).toBe(0);
      expect(count("items")).toBe(2);
      const scopes = await storage.listScopes({});
      expect(scopes.map((scope) => scope.service)).toEqual(["api", "web"]);
    });

    it("uses a strict cutoff", async () => {
      await write({ receivedAt: iso(T0), items: [{}] });
      expect(await storage.pruneIdleSessions(new Date(T0))).toEqual({
        sessionsDeleted: 0,
        itemsDeleted: 0,
      });
      expect(await storage.pruneIdleSessions(new Date(T0 + 1))).toEqual({
        sessionsDeleted: 1,
        itemsDeleted: 1,
      });
    });
  });

  describe("pruneOldItems", () => {
    it("deletes old noise kinds only and keeps issues", async () => {
      const mixed = await write({
        receivedAt: iso(T0),
        items: [{ kind: "error", issueId: ISSUE }, { kind: "span" }],
      });
      const noise = await write({
        receivedAt: iso(T0),
        items: [{ kind: "transaction" }, { kind: "log" }, { kind: "other" }],
      });
      await write({
        receivedAt: iso(T0),
        items: [{ kind: "message" }, { kind: "attachment", blob: new Uint8Array([1]) }],
      });
      await write({ receivedAt: iso(T0 + 2 * HOUR), items: [{ kind: "log" }] });
      await write({ receivedAt: iso(T0), parseError: "old" });
      await write({ receivedAt: iso(T0 + 2 * HOUR), parseError: "new" });

      expect(await storage.pruneOldItems([...NOISE], new Date(T0 + HOUR))).toEqual({
        itemsDeleted: 4,
      });
      const remaining = await storage.listItems({}, ALL);
      const kinds = remaining.items.map((item) => item.kind).toSorted();
      expect(kinds).toEqual(["attachment", "error", "log", "message"]);
      expect(await storage.getIssue(ISSUE)).toMatchObject({ count: 1 });
      expect(await storage.getEnvelope(mixed.envelopeId)).not.toBeNull();
      expect(await storage.getEnvelope(noise.envelopeId)).toBeNull();
      const failed = await storage.listFailedEnvelopes({}, ALL);
      expect(failed.items.map((envelope) => envelope.parseError)).toEqual(["new"]);
      expect(count("blobs")).toBe(1);
      expect(await itemCounts()).toEqual([4]);
    });

    it("does nothing without kinds", async () => {
      await write({ receivedAt: iso(T0), items: [{ kind: "log" }] });
      expect(await storage.pruneOldItems([], new Date(T0 + HOUR))).toEqual({ itemsDeleted: 0 });
      expect(count("items")).toBe(1);
    });
  });

  describe("blobs and envelopes", () => {
    it("returns exact blob bytes, envelopes with and without body, null when unknown", async () => {
      const bytes = new Uint8Array([0, 10, 255]);
      const withBlob = await write({
        body: new Uint8Array([1, 2]),
        items: [{ kind: "attachment", blob: bytes }],
      });
      const plain = await write({ items: [{}] });
      const blob = await storage.getBlob(withBlob.ids[0] ?? "");
      expect(blob).toBeInstanceOf(Uint8Array);
      expect(Buffer.isBuffer(blob)).toBe(false);
      expect([...(blob ?? [])]).toEqual([0, 10, 255]);
      expect(await storage.getBlob(plain.ids[0] ?? "")).toBeNull();
      expect(await storage.getBlob("missing")).toBeNull();
      const stored = await storage.getEnvelope(withBlob.envelopeId);
      expect(stored?.body).toEqual(new Uint8Array([1, 2]));
      expect(await storage.getEnvelope(plain.envelopeId)).not.toHaveProperty("body");
      expect(await storage.getEnvelope("missing")).toBeNull();
    });
  });

  describe("vacuum", () => {
    it("shrinks the main file and truncates the WAL", async () => {
      const big = new Uint8Array(5 * 1024 * 1024).fill(7);
      await write({ items: [{ kind: "attachment", blob: big }] });
      raw.close();
      raw = await SQLITE_OPENERS[driverName](":memory:");
      expect(await storage.deleteItems({})).toBe(1);
      await storage.vacuum();
      expect(statSync(file).size).toBeLessThan(1024 * 1024);
      const wal = `${file}-wal`;
      const walSize = statSync(wal, { throwIfNoEntry: false })?.size ?? 0;
      expect(walSize).toBe(0);
    });
  });
});
