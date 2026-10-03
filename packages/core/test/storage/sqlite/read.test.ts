import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { object, string } from "zod";

import { decodeCursor } from "#src/query/cursor.js";
import type { SqliteDriver, SqliteParam } from "#src/storage/sqlite/driver/types.js";
import { sqliteStorage } from "#src/storage/sqlite/index.js";
import { buildIssueWhere, buildItemWhere, where } from "#src/storage/sqlite/queries.js";
import type { ResolvedPage, StorageAdapter } from "#src/storage/types.js";
import type { ScopeFilter } from "#src/types.js";

import { makeBatch } from "../../../../../test/storage-contract.js";
import type { WriteSpec } from "../../../../../test/storage-contract.js";
import { SQLITE_OPENERS, loadableSqliteDrivers } from "../../helpers/sqlite.js";

const drivers = await loadableSqliteDrivers();

const T0 = Date.parse("2026-10-01T00:00:00.000Z");
const HOUR = 3_600_000;
const ALL: ResolvedPage = { limit: 500, cursor: null };
const I1 = "00000000000000a1";
const I2 = "00000000000000a2";
const I3 = "00000000000000a3";
const I4 = "00000000000000b4";

const planRow = object({ detail: string() });

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

describe.each(drivers)("sqlite reads with %s", (driverName) => {
  let storage: StorageAdapter;
  let file: string;

  beforeEach(async () => {
    file = path.join(tempDir, "sentra.db");
    storage = sqliteStorage({ path: file, driver: driverName });
    await storage.init();
  });

  afterEach(async () => {
    await storage.close();
  });

  async function write(spec: WriteSpec): Promise<string[]> {
    const batch = makeBatch(spec);
    await storage.write(batch);
    return batch.items.map(({ item }) => item.id);
  }

  /** 12 records, 2 projects, 2 sessions, 3 services, all kinds and levels, 4 issues. */
  async function seed(): Promise<void> {
    await write({
      scope: { project: "p1", session: "s1", service: "web" },
      receivedAt: iso(T0),
      items: [
        { kind: "attachment", itemType: "attachment", eventId: "ev1", title: "file.txt" },
        { kind: "error", issueId: I1, level: "error", eventId: "ev1", title: "TypeError: x" },
        { kind: "log", level: "trace", title: "trace log" },
      ],
    });
    await write({
      scope: { project: "p1", session: "s1", service: "api" },
      receivedAt: iso(T0 + HOUR),
      items: [
        { kind: "error", issueId: I1, level: "fatal", title: "TypeError: y" },
        { kind: "message", issueId: I2, level: "warning", title: "100% done" },
        { kind: "log", level: null, title: "no level" },
      ],
    });
    await write({
      scope: { project: "p1", session: "s2", service: "web" },
      receivedAt: iso(T0 + 2 * HOUR),
      items: [
        { kind: "transaction", level: "info", title: "GET /" },
        { kind: "span", level: "debug", title: "db query" },
        { kind: "message", issueId: I3, level: "info", title: "hello" },
      ],
    });
    await write({
      scope: { project: "p2", session: "s1", service: "worker" },
      receivedAt: iso(T0 + 3 * HOUR),
      items: [
        { kind: "other", level: null, title: "other" },
        { kind: "error", issueId: I4, level: "error", title: "RangeError" },
        { kind: "log", level: "info", title: "info log" },
      ],
    });
  }

  describe("listItems", () => {
    it("returns summaries newest first and pages without duplicates", async () => {
      const ids = await write({ items: [{}, {}, {}, {}, {}] });
      const seen: string[] = [];
      const sizes: number[] = [];
      let cursor: string | null = null;
      do {
        const page = await storage.listItems({}, { limit: 2, cursor });
        sizes.push(page.items.length);
        seen.push(...page.items.map((item) => item.id));
        for (const item of page.items) {
          expect(item).not.toHaveProperty("data");
        }
        cursor = page.nextCursor === null ? null : decodeCursor(page.nextCursor);
      } while (cursor !== null);
      expect(sizes).toEqual([2, 2, 1]);
      expect(seen).toEqual(ids.toReversed());
    });

    it("filters by scope, kind, level, time and text", async () => {
      await seed();
      async function titles(filter: Parameters<StorageAdapter["listItems"]>[0]): Promise<string[]> {
        const page = await storage.listItems(filter, ALL);
        return page.items.map((item) => item.title).toSorted();
      }
      expect(await titles({ minLevel: "warning" })).toEqual([
        "100% done",
        "RangeError",
        "TypeError: x",
        "TypeError: y",
      ]);
      expect(await titles({ q: "typeerror" })).toEqual(["TypeError: x", "TypeError: y"]);
      expect(await titles({ q: "0% d" })).toEqual(["100% done"]);
      expect(await titles({ q: "0_ d" })).toEqual([]);
      expect(await titles({ from: T0 + HOUR, to: T0 + 2 * HOUR, kind: ["message"] })).toEqual([
        "100% done",
        "hello",
      ]);
      expect(await titles({ project: ["p1"], session: ["s1"], service: ["api"] })).toHaveLength(3);
      expect(await titles({ level: ["trace", "debug"] })).toEqual(["db query", "trace log"]);
      expect(await titles({ eventId: "ev1", kind: ["attachment"] })).toEqual(["file.txt"]);
      expect(await titles({ issueId: I1 })).toEqual(["TypeError: x", "TypeError: y"]);
    });
  });

  describe("issues", () => {
    it("orders by lastSeenAt and id, with services and shortId", async () => {
      await seed();
      const page = await storage.listIssues({}, ALL);
      expect(page.items.map((issue) => issue.id)).toEqual([I4, I3, I2, I1]);
      expect(page.nextCursor).toBeNull();
      const i1 = page.items.find((issue) => issue.id === I1);
      expect(i1).toMatchObject({ shortId: "00000000", services: ["api", "web"], count: 2 });
      expect(await storage.getIssue(I1)).toEqual(i1);
    });

    it("pages issues that share lastSeenAt", async () => {
      const ids = ["00000000000000c1", "00000000000000c2", "00000000000000c3"];
      await write({ items: ids.map((issueId) => ({ issueId })) });
      const first = await storage.listIssues({}, { limit: 2, cursor: null });
      expect(first.items.map((issue) => issue.id)).toEqual([
        "00000000000000c3",
        "00000000000000c2",
      ]);
      if (first.nextCursor === null) {
        throw new Error("expected a cursor");
      }
      const second = await storage.listIssues(
        {},
        { limit: 2, cursor: decodeCursor(first.nextCursor) },
      );
      expect(second.items.map((issue) => issue.id)).toEqual(["00000000000000c1"]);
      expect(second.nextCursor).toBeNull();
    });

    it("filters by service, minLevel, time and text", async () => {
      await seed();
      async function ids(filter: Parameters<StorageAdapter["listIssues"]>[0]): Promise<string[]> {
        const page = await storage.listIssues(filter, ALL);
        return page.items.map((issue) => issue.id);
      }
      expect(await ids({ service: ["api"] })).toEqual([I2, I1]);
      expect(await ids({ minLevel: "warning" })).toEqual([I4, I2, I1]);
      expect(await ids({ from: T0 + HOUR, to: T0 + 2 * HOUR })).toEqual([I3, I2, I1]);
      expect(await ids({ q: "TYPEERROR" })).toEqual([I1]);
      expect(await ids({ kind: ["message"], project: ["p1"] })).toEqual([I3, I2]);
    });

    it("finds issues by literal, case-sensitive prefix", async () => {
      await seed();
      async function found(prefix: string, scope: ScopeFilter): Promise<string[]> {
        const issues = await storage.findIssues(prefix, scope);
        return issues.map((issue) => issue.id);
      }
      expect(await found("00000000000000a", {})).toEqual([I1, I2]);
      expect(await storage.findIssues("00000000000000A", {})).toEqual([]);
      expect(await storage.findIssues("0%", {})).toEqual([]);
      expect(await storage.findIssues("000000000000000_", {})).toEqual([]);
      expect(await found("0000", { project: "p2", service: ["worker"] })).toEqual([I4]);
      expect(await storage.findIssues("0000", { service: "nope" })).toEqual([]);
    });
  });

  describe("single lookups", () => {
    it("returns null for unknown ids and full items otherwise", async () => {
      const [id] = await write({ items: [{ kind: "span", title: "s" }] });
      expect(await storage.getIssue("ffffffffffffffff")).toBeNull();
      expect(await storage.getItem("missing")).toBeNull();
      expect(await storage.getItemByEventId("missing")).toBeNull();
      expect(await storage.getItem(id ?? "")).toMatchObject({
        id,
        kind: "span",
        data: { op: "http" },
      });
    });

    it("prefers event records over attachments for an event id", async () => {
      await seed();
      expect(await storage.getItemByEventId("ev1")).toMatchObject({ kind: "error" });
    });
  });

  describe("listScopes", () => {
    it("returns ordered summaries with counts and filters", async () => {
      await seed();
      const scopes = await storage.listScopes({});
      expect(scopes.map((scope) => [scope.project, scope.session, scope.service])).toEqual([
        ["p1", "s1", "api"],
        ["p1", "s1", "web"],
        ["p1", "s2", "web"],
        ["p2", "s1", "worker"],
      ]);
      expect(scopes[0]).toEqual({
        project: "p1",
        session: "s1",
        service: "api",
        firstSeenAt: iso(T0 + HOUR),
        lastSeenAt: iso(T0 + HOUR),
        itemCount: 3,
        issueCount: 2,
      });
      expect(await storage.listScopes({ project: "p2" })).toHaveLength(1);
      expect(await storage.listScopes({ session: ["s2"], service: ["web", "api"] })).toHaveLength(
        1,
      );
    });
  });

  describe("listFailedEnvelopes", () => {
    it("returns failed envelopes newest first without body and filtered", async () => {
      await seed();
      await write({ parseError: "a", body: new Uint8Array([1]), receivedAt: iso(T0) });
      await write({
        parseError: "b",
        scope: { project: "p2" },
        receivedAt: iso(T0 + 4 * HOUR),
      });
      const page = await storage.listFailedEnvelopes({}, ALL);
      expect(page.items.map((envelope) => envelope.parseError)).toEqual(["b", "a"]);
      for (const envelope of page.items) {
        expect(envelope).not.toHaveProperty("body");
      }
      const bounded = await storage.listFailedEnvelopes({ from: T0, to: T0 }, ALL);
      expect(bounded.items.map((envelope) => envelope.parseError)).toEqual(["a"]);
      const scoped = await storage.listFailedEnvelopes({ project: ["p2"] }, ALL);
      expect(scoped.items.map((envelope) => envelope.parseError)).toEqual(["b"]);
      const paged = await storage.listFailedEnvelopes({}, { limit: 1, cursor: null });
      expect(paged.items).toHaveLength(1);
      expect(paged.nextCursor).not.toBeNull();
    });
  });

  describe("query plans", () => {
    async function plan(sql: string, params: SqliteParam[]): Promise<string> {
      const raw: SqliteDriver = await SQLITE_OPENERS[driverName](file);
      try {
        return raw
          .prepare(`EXPLAIN QUERY PLAN ${sql}`)
          .all(...params)
          .map((row) => planRow.parse(row).detail)
          .join("\n");
      } finally {
        raw.close();
      }
    }

    it("uses the scope, issue and issues_scope indexes", async () => {
      const scoped = buildItemWhere({ project: ["p"], session: ["s"], service: ["web"] });
      expect(
        await plan(
          `SELECT id FROM items ${where(scoped)} ORDER BY id DESC LIMIT 10`,
          scoped.params,
        ),
      ).toContain("items_scope_time");
      const byIssue = buildItemWhere({ issueId: I1 });
      expect(
        await plan(
          `SELECT id FROM items ${where(byIssue)} ORDER BY id DESC LIMIT 10`,
          byIssue.params,
        ),
      ).toMatch(/\bitems_issue\b/);
      const issues = buildIssueWhere({ project: ["p"], session: ["s"] });
      expect(
        await plan(
          `SELECT id FROM issues ${where(issues)} ORDER BY last_seen_at DESC, id DESC LIMIT 10`,
          issues.params,
        ),
      ).toContain("issues_scope");
    });
  });
});
