import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { instanceof as instanceOf, int, nullable, number, object, string } from "zod";

import type { SqliteDriver } from "#src/storage/sqlite/driver/types.js";
import { sqliteStorage } from "#src/storage/sqlite/index.js";
import type { StorageAdapter } from "#src/storage/types.js";

import { makeBatch } from "../../../../../test/storage-contract.js";
import { SQLITE_OPENERS, loadableSqliteDrivers } from "../../helpers/sqlite.js";

const drivers = await loadableSqliteDrivers();

const T0 = Date.parse("2026-10-01T00:00:00.000Z");
const ISSUE = "00000000000000a1";

const countRow = object({ c: int() });
const scopeRow = object({ first_seen_at: int(), last_seen_at: int(), item_count: int() });
const issueRow = object({
  count: int(),
  title: string(),
  level: string(),
  culprit: nullable(string()),
  platform: nullable(string()),
  first_seen_at: int(),
  last_seen_at: int(),
  last_item_id: string(),
  fingerprint: string(),
  fingerprint_hash: string(),
  kind: string(),
});
const envelopeRow = object({
  body: nullable(instanceOf(Uint8Array)),
  parse_warnings: string(),
  parse_error: nullable(string()),
  item_count: int(),
});
const blobRow = object({ data: instanceOf(Uint8Array) });
const rankRow = object({ level_rank: nullable(number()) });

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

describe.each(drivers)("sqlite write with %s", (driverName) => {
  let storage: StorageAdapter;
  let raw: SqliteDriver;

  beforeEach(async () => {
    const file = path.join(tempDir, "sentra.db");
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

  function issue(id: string) {
    return issueRow.parse(raw.prepare("SELECT * FROM issues WHERE id = ?").get(id));
  }

  function scope() {
    return scopeRow.parse(
      raw.prepare("SELECT * FROM scopes WHERE project = 'p1' AND session = 's1'").get(),
    );
  }

  it("stores a single error batch", async () => {
    const batch = makeBatch({ items: [{ issueId: ISSUE, level: "error", title: "Boom" }] });
    const result = await storage.write(batch);
    expect(result).toEqual({ issues: [{ id: ISSUE, isNew: true, count: 1 }] });
    expect(count("envelopes")).toBe(1);
    expect(count("items")).toBe(1);
    expect(count("blobs")).toBe(0);
    expect(scope()).toEqual({ first_seen_at: T0, last_seen_at: T0, item_count: 1 });
    expect(issue(ISSUE)).toEqual({
      count: 1,
      title: "Boom",
      level: "error",
      culprit: null,
      platform: null,
      first_seen_at: T0,
      last_seen_at: T0,
      last_item_id: batch.items[0]?.item.id,
      fingerprint: JSON.stringify([ISSUE]),
      fingerprint_hash: `hash-${ISSUE}`,
      kind: "error",
    });
    const envelope = envelopeRow.parse(raw.prepare("SELECT * FROM envelopes").get());
    expect(envelope).toEqual({
      body: null,
      parse_warnings: "[]",
      parse_error: null,
      item_count: 1,
    });
  });

  it("updates an issue seen in a later batch", async () => {
    await storage.write(makeBatch({ items: [{ issueId: ISSUE, level: "error", title: "Boom" }] }));
    const later = makeBatch({
      receivedAt: iso(T0 + 60_000),
      items: [
        {
          issueId: ISSUE,
          level: "fatal",
          title: "Boom again",
          platform: "node",
          issue: {
            culprit: "fn",
            fingerprint: ["changed"],
            fingerprintHash: "other",
            kind: "message",
          },
        },
      ],
    });
    const result = await storage.write(later);
    expect(result).toEqual({ issues: [{ id: ISSUE, isNew: false, count: 2 }] });
    expect(issue(ISSUE)).toEqual({
      count: 2,
      title: "Boom again",
      level: "fatal",
      culprit: "fn",
      platform: "node",
      first_seen_at: T0,
      last_seen_at: T0 + 60_000,
      last_item_id: later.items[0]?.item.id,
      fingerprint: JSON.stringify([ISSUE]),
      fingerprint_hash: `hash-${ISSUE}`,
      kind: "error",
    });
    expect(scope()).toEqual({ first_seen_at: T0, last_seen_at: T0 + 60_000, item_count: 2 });
  });

  it("never moves scope last_seen_at backwards", async () => {
    await storage.write(makeBatch({ receivedAt: iso(T0 + 60_000), items: [{}] }));
    await storage.write(makeBatch({ receivedAt: iso(T0), items: [{}, {}] }));
    expect(scope()).toEqual({
      first_seen_at: T0 + 60_000,
      last_seen_at: T0 + 60_000,
      item_count: 3,
    });
  });

  it("counts the same issue twice in one batch", async () => {
    const result = await storage.write(
      makeBatch({ items: [{ issueId: ISSUE }, { issueId: ISSUE }] }),
    );
    expect(result.issues).toEqual([
      { id: ISSUE, isNew: true, count: 1 },
      { id: ISSUE, isNew: false, count: 2 },
    ]);
  });

  it("stores blobs and envelope bodies byte-exact", async () => {
    const bytes = new Uint8Array([0x00, 0x0a, 0xff, 0x00, 0x0d, 0x0a]);
    const backing = new Uint8Array([0x99, ...bytes, 0x99]);
    const batch = makeBatch({
      body: backing.subarray(1, -1),
      items: [{ kind: "attachment", itemType: "attachment", blob: backing.subarray(1, -1) }],
    });
    await storage.write(batch);
    const blob = blobRow.parse(raw.prepare("SELECT data FROM blobs").get());
    expect([...blob.data]).toEqual([...bytes]);
    const envelope = envelopeRow.parse(raw.prepare("SELECT * FROM envelopes").get());
    expect([...(envelope.body ?? [])]).toEqual([...bytes]);
  });

  it("stores a failed envelope and touches the scope", async () => {
    const batch = makeBatch({ parseError: "bad header", body: new Uint8Array([1, 2]) });
    expect(await storage.write(batch)).toEqual({ issues: [] });
    expect(count("items")).toBe(0);
    const envelope = envelopeRow.parse(raw.prepare("SELECT * FROM envelopes").get());
    expect(envelope).toMatchObject({ parse_error: "bad header", item_count: 0 });
    expect([...(envelope.body ?? [])]).toEqual([1, 2]);
    expect(scope()).toEqual({ first_seen_at: T0, last_seen_at: T0, item_count: 0 });
  });

  it("stores NULL body without raw envelopes", async () => {
    await storage.write(makeBatch({ items: [{}] }));
    expect(count("envelopes")).toBe(1);
    expect(
      countRow.parse(raw.prepare("SELECT count(*) AS c FROM envelopes WHERE body IS NULL").get()).c,
    ).toBe(1);
  });

  it("rolls back the whole batch on a duplicate item id", async () => {
    const first = makeBatch({ items: [{ id: "dup-1" }] });
    await storage.write(first);
    const second = makeBatch({
      scope: { project: "p2" },
      items: [{ issueId: ISSUE }, { id: "dup-1" }],
    });
    await expect(storage.write(second)).rejects.toThrow();
    expect(count("envelopes")).toBe(1);
    expect(count("items")).toBe(1);
    expect(count("issues")).toBe(0);
    expect(
      countRow.parse(raw.prepare("SELECT count(*) AS c FROM scopes WHERE project = 'p2'").get()).c,
    ).toBe(0);
    await storage.write(makeBatch({ items: [{ issueId: ISSUE }] }));
    expect(count("issues")).toBe(1);
  });

  it("stores level_rank for every level and NULL", async () => {
    const levels = ["trace", "debug", "info", "warning", "error", "fatal", null] as const;
    const batch = makeBatch({ items: levels.map((level) => ({ level, kind: "log" as const })) });
    await storage.write(batch);
    const ranks = batch.items.map(
      ({ item }) =>
        rankRow.parse(raw.prepare("SELECT level_rank FROM items WHERE id = ?").get(item.id))
          .level_rank,
    );
    expect(ranks).toEqual([0, 1, 2, 3, 4, 5, null]);
  });
});
