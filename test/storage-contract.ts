import { decodeCursor, encodeCursor } from "../packages/core/src/query/cursor.js";
import type {
  IngestBatch,
  ResolvedItemFilter,
  ResolvedPage,
  StorageAdapter,
} from "../packages/core/src/storage/types.js";
import type {
  Envelope,
  EventData,
  Issue,
  Item,
  ItemKind,
  ItemSummary,
  Scope,
  ScopeFilter,
} from "../packages/core/src/types.js";

type IssueEntry = IngestBatch["issues"][number];

interface ItemSpec extends Partial<Omit<ItemSummary, "envelopeId" | "scope" | "receivedAt">> {
  kind?: ItemKind;
  blob?: Uint8Array | null;
  data?: Partial<EventData>;
  /** Issue upsert overrides; `false` = no issue entry even if `issueId` is set. */
  issue?: Partial<IssueEntry> | false;
}

interface WriteSpec {
  scope?: Partial<Scope>;
  receivedAt?: string;
  parseError?: string | null;
  body?: Uint8Array;
  items?: ItemSpec[];
}

interface Written {
  envelope: Envelope;
  items: Item[];
  result: { issues: { id: string; isNew: boolean; count: number }[] };
}

const T0 = Date.parse("2026-10-01T00:00:00.000Z");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const ALL: ResolvedPage = { limit: 500, cursor: null };
const DEFAULT_SCOPE: Scope = { project: "p1", session: "s1", service: "web" };

let sequence = 0;

/** Lexically increasing UUIDv7-shaped ID. */
function nextId(): string {
  sequence += 1;
  return `0199a0b0-0000-7000-8000-${sequence.toString(16).padStart(12, "0")}`;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function issueId(n: number): string {
  return n.toString(16).padStart(16, "0");
}

function eventData(overrides: Partial<EventData> = {}): EventData {
  return {
    message: null,
    exceptions: [],
    stacktrace: [],
    culprit: null,
    transaction: null,
    logger: null,
    dist: null,
    serverName: null,
    user: null,
    request: null,
    tags: {},
    contexts: {},
    extra: {},
    breadcrumbs: [],
    sdk: null,
    fingerprint: [],
    sourceMaps: { status: "not_applicable", mappedFrames: 0, candidateFrames: 0, errors: [] },
    ...overrides,
  };
}

function makeEnvelope(spec: WriteSpec): Envelope {
  const envelope: Envelope = {
    id: nextId(),
    scope: { ...DEFAULT_SCOPE, ...spec.scope },
    receivedAt: spec.receivedAt ?? iso(T0),
    header: { sdk: { name: "test" } },
    size: 10,
    contentEncoding: null,
    itemCount: spec.items?.length ?? 0,
    parseError: spec.parseError ?? null,
    parseWarnings: [],
  };
  return spec.body === undefined ? envelope : { ...envelope, body: spec.body };
}

function makeSummary(envelope: Envelope, spec: ItemSpec): Omit<ItemSummary, "kind"> {
  return {
    id: spec.id ?? nextId(),
    envelopeId: envelope.id,
    scope: { ...envelope.scope },
    itemType: spec.itemType ?? "event",
    receivedAt: envelope.receivedAt,
    timestamp: spec.timestamp ?? envelope.receivedAt,
    eventId: spec.eventId ?? null,
    issueId: spec.issueId ?? null,
    traceId: spec.traceId ?? null,
    level: spec.level === undefined ? null : spec.level,
    environment: spec.environment ?? null,
    release: spec.release ?? null,
    platform: spec.platform ?? null,
    title: spec.title ?? `${spec.kind ?? "error"} item`,
  };
}

function makeItem(envelope: Envelope, spec: ItemSpec): Item {
  const kind = spec.kind ?? "error";
  const summary = makeSummary(envelope, spec);
  switch (kind) {
    case "error":
    case "message": {
      return { ...summary, kind, data: eventData(spec.data) };
    }
    case "transaction": {
      return {
        ...summary,
        kind,
        data: {
          name: summary.title,
          op: null,
          status: null,
          startTimestamp: summary.timestamp,
          durationMs: 1,
          spanId: null,
          parentSpanId: null,
          spans: [],
          measurements: {},
          tags: {},
          contexts: {},
          request: null,
          sdk: null,
        },
      };
    }
    case "span": {
      return {
        ...summary,
        kind,
        data: {
          name: summary.title,
          spanId: "span-1",
          parentSpanId: null,
          isSegment: true,
          status: "ok",
          startTimestamp: summary.timestamp,
          durationMs: 1.5,
          op: "http",
          attributes: { a: 1, b: true, c: "x" },
        },
      };
    }
    case "log": {
      return {
        ...summary,
        kind,
        data: { body: summary.title, severityNumber: 9, spanId: null, attributes: { n: 1.5 } },
      };
    }
    case "attachment": {
      return {
        ...summary,
        kind,
        data: {
          filename: summary.title,
          contentType: "application/octet-stream",
          attachmentType: null,
          size: spec.blob?.byteLength ?? 0,
          stored: true,
        },
      };
    }
    default: {
      return {
        ...summary,
        kind: "other",
        data: { payloadEncoding: "json", payload: { a: [1, 2] }, size: 11, normalizeError: null },
      };
    }
  }
}

function makeIssueEntry(envelope: Envelope, item: Item, spec: ItemSpec): IssueEntry | null {
  if (
    spec.issue === false ||
    item.issueId === null ||
    (item.kind !== "error" && item.kind !== "message")
  ) {
    return null;
  }
  return {
    id: item.issueId,
    project: envelope.scope.project,
    session: envelope.scope.session,
    kind: item.kind,
    fingerprint: [item.issueId],
    fingerprintHash: `hash-${item.issueId}`,
    title: item.title,
    culprit: null,
    level: item.level ?? "error",
    platform: item.platform,
    itemId: item.id,
    seenAt: envelope.receivedAt,
    ...spec.issue,
  };
}

function makeBatch(spec: WriteSpec): IngestBatch {
  const envelope = makeEnvelope(spec);
  const specs = spec.items ?? [];
  const items = specs.map((itemSpec) => makeItem(envelope, itemSpec));
  const issues = items.flatMap((item, index) => {
    const entry = makeIssueEntry(envelope, item, specs[index] ?? {});
    return entry === null ? [] : [entry];
  });
  return {
    envelope,
    items: items.map((item, index) => ({ item, blob: specs[index]?.blob ?? null })),
    issues,
  };
}

async function write(adapter: StorageAdapter, spec: WriteSpec): Promise<Written> {
  const batch = makeBatch(spec);
  const result = await adapter.write(batch);
  return { envelope: batch.envelope, items: batch.items.map(({ item }) => item), result };
}

function only<T>(list: T[]): T {
  const [first] = list;
  if (first === undefined || list.length !== 1) {
    throw new Error(`expected exactly one entry, got ${list.length}`);
  }
  return first;
}

async function itemIds(
  adapter: StorageAdapter,
  filter: ResolvedItemFilter = {},
): Promise<string[]> {
  const page = await adapter.listItems(filter, ALL);
  return page.items.map((item) => item.id);
}

async function idsOf(promise: Promise<{ id: string }[]>): Promise<string[]> {
  const list = await promise;
  return list.map((entry) => entry.id);
}

function desc(ids: string[]): string[] {
  return ids.toSorted().toReversed();
}

function bytes(value: Uint8Array | null): number[] | null {
  return value === null ? null : [...value];
}

function runStorageContract(
  name: string,
  createAdapter: () => StorageAdapter | Promise<StorageAdapter>,
): void {
  describe(`storage contract: ${name}`, () => {
    let adapter: StorageAdapter;

    beforeEach(async () => {
      adapter = await createAdapter();
      await adapter.init();
    });

    afterEach(async () => {
      await adapter.close();
    });

    describe("lifecycle", () => {
      it("init is idempotent and vacuum resolves", async () => {
        const info = await adapter.init();
        expect(Object.keys(info).toSorted()).toEqual(["driver", "path"]);
        await expect(adapter.vacuum()).resolves.toBeUndefined();
      });
    });

    describe("write / read", () => {
      it("round trips an item including data", async () => {
        const { items } = await write(adapter, {
          items: [
            {
              issueId: issueId(1),
              level: "error",
              eventId: "e".repeat(32),
              traceId: "t1",
              environment: "dev",
              release: "1.0",
              platform: "node",
              title: "TypeError: boom",
              data: { message: "boom", tags: { a: "1" }, extra: { nested: { x: [1, null] } } },
            },
          ],
        });
        const item = only(items);
        expect(await adapter.getItem(item.id)).toEqual(item);
      });

      it.each(["transaction", "span", "log", "attachment", "other"] as const)(
        "round trips a %s item",
        async (kind) => {
          const { items } = await write(adapter, { items: [{ kind, itemType: kind }] });
          const item = only(items);
          expect(await adapter.getItem(item.id)).toEqual(item);
        },
      );

      it("round trips envelopes with and without body", async () => {
        const body = new Uint8Array([123, 10, 0, 255]);
        const withBody = await write(adapter, { body, items: [{}] });
        const without = await write(adapter, { items: [{}] });
        const storedWithBody = await adapter.getEnvelope(withBody.envelope.id);
        expect(bytes(storedWithBody?.body ?? null)).toEqual([123, 10, 0, 255]);
        expect({ ...storedWithBody, body: undefined }).toEqual({
          ...withBody.envelope,
          body: undefined,
        });
        const storedWithout = await adapter.getEnvelope(without.envelope.id);
        expect(storedWithout?.body).toBeUndefined();
        expect({ ...storedWithout, body: undefined }).toEqual({
          ...without.envelope,
          body: undefined,
        });
      });

      it("round trips binary and empty blobs", async () => {
        const binary = new Uint8Array([0, 10, 255, 13, 10]);
        const { items } = await write(adapter, {
          items: [
            { kind: "attachment", itemType: "attachment", blob: binary },
            { kind: "attachment", itemType: "attachment", blob: new Uint8Array() },
            { kind: "attachment", itemType: "attachment", blob: null },
          ],
        });
        const [first, second, third] = items;
        expect(bytes(await adapter.getBlob(first?.id ?? ""))).toEqual([0, 10, 255, 13, 10]);
        expect(bytes(await adapter.getBlob(second?.id ?? ""))).toEqual([]);
        expect(await adapter.getBlob(third?.id ?? "")).toBeNull();
      });

      it("stores exactly the bytes of a blob view and copies them", async () => {
        const buffer = new Uint8Array([9, 9, 1, 2, 3, 9, 9]);
        const view = buffer.subarray(2, 5);
        const { items } = await write(adapter, {
          items: [{ kind: "attachment", itemType: "attachment", blob: view }],
        });
        buffer.fill(0);
        const blob = await adapter.getBlob(only(items).id);
        expect(blob?.byteLength).toBe(3);
        expect(bytes(blob)).toEqual([1, 2, 3]);
      });

      it("returns null for unknown IDs", async () => {
        await write(adapter, { items: [{ issueId: issueId(1), eventId: "a".repeat(32) }] });
        expect(await adapter.getItem(nextId())).toBeNull();
        expect(await adapter.getIssue(issueId(99))).toBeNull();
        expect(await adapter.getBlob(nextId())).toBeNull();
        expect(await adapter.getEnvelope(nextId())).toBeNull();
        expect(await adapter.getItemByEventId("b".repeat(32))).toBeNull();
      });

      it("does not expose stored data to caller mutation", async () => {
        const { envelope, items } = await write(adapter, {
          body: new Uint8Array([1, 2]),
          items: [
            { issueId: issueId(1), data: { tags: { a: "1" } } },
            { kind: "attachment", itemType: "attachment", blob: new Uint8Array([5]) },
          ],
        });
        const [item, attachment] = items;
        const before = structuredClone({
          item: await adapter.getItem(item?.id ?? ""),
          issue: await adapter.getIssue(issueId(1)),
          scopes: await adapter.listScopes({}),
          issues: await adapter.listIssues({}, ALL),
          items: await adapter.listItems({}, ALL),
          envelope: await adapter.getEnvelope(envelope.id),
          failed: await adapter.listFailedEnvelopes({}, ALL),
        });

        const read = await adapter.getItem(item?.id ?? "");
        if (read?.kind === "error") {
          read.data.tags.a = "changed";
          read.title = "changed";
        }
        for (const row of await adapter.listScopes({})) {
          row.service = "changed";
          row.itemCount = 99;
          row.issueCount = 99;
        }
        const issuePage = await adapter.listIssues({}, ALL);
        const found = await adapter.findIssues(issueId(1).slice(0, 4), {});
        for (const issue of [await adapter.getIssue(issueId(1)), ...issuePage.items, ...found]) {
          if (issue !== null) {
            issue.count = 99;
            issue.fingerprint.push("changed");
            issue.services.push("changed");
          }
        }
        const itemPage = await adapter.listItems({}, ALL);
        for (const summary of itemPage.items) {
          summary.title = "changed";
          summary.scope.service = "changed";
        }
        const storedEnvelope = await adapter.getEnvelope(envelope.id);
        if (storedEnvelope !== null) {
          storedEnvelope.header.changed = true;
          storedEnvelope.parseWarnings.push("changed");
          storedEnvelope.body?.fill(0);
        }
        const blob = await adapter.getBlob(attachment?.id ?? "");
        blob?.fill(0);

        expect({
          item: await adapter.getItem(item?.id ?? ""),
          issue: await adapter.getIssue(issueId(1)),
          scopes: await adapter.listScopes({}),
          issues: await adapter.listIssues({}, ALL),
          items: await adapter.listItems({}, ALL),
          envelope: await adapter.getEnvelope(envelope.id),
          failed: await adapter.listFailedEnvelopes({}, ALL),
        }).toEqual(before);
        expect(bytes(await adapter.getBlob(attachment?.id ?? ""))).toEqual([5]);
      });

      it("does not keep references to the written batch", async () => {
        const batch = makeBatch({ body: new Uint8Array([1]), items: [{ issueId: issueId(1) }] });
        await adapter.write(batch);
        const [entry] = batch.items;
        const expected = structuredClone(entry?.item);
        if (entry !== undefined) {
          entry.item.title = "changed";
          entry.item.scope.service = "changed";
        }
        batch.envelope.header.changed = true;
        batch.envelope.body?.fill(9);
        batch.issues[0]?.fingerprint.push("changed");
        await expect(adapter.getItem(entry?.item.id ?? "")).resolves.toEqual(expected);
        const stored = await adapter.getEnvelope(batch.envelope.id);
        expect(stored?.header).not.toHaveProperty("changed");
        expect(bytes(stored?.body ?? null)).toEqual([1]);
        await expect(adapter.getIssue(issueId(1))).resolves.toHaveProperty("fingerprint", [
          issueId(1),
        ]);
      });

      it("rejects a duplicate item ID and changes nothing", async () => {
        const first = await write(adapter, { items: [{ issueId: issueId(1) }] });
        const duplicate = makeBatch({ items: [{ issueId: issueId(1) }, { issueId: issueId(2) }] });
        const [, second] = duplicate.items;
        const conflicting: IngestBatch = {
          ...duplicate,
          items: [
            { item: { ...only(first.items), envelopeId: duplicate.envelope.id }, blob: null },
            ...(second ? [second] : []),
          ],
        };
        await expect(adapter.write(conflicting)).rejects.toThrow();
        expect(await adapter.getEnvelope(duplicate.envelope.id)).toBeNull();
        expect(await adapter.getItem(second?.item.id ?? "")).toBeNull();
        expect(await adapter.getIssue(issueId(2))).toBeNull();
        await expect(adapter.getIssue(issueId(1))).resolves.toHaveProperty("count", 1);
        expect(only(await adapter.listScopes({})).itemCount).toBe(1);
        expect(await itemIds(adapter)).toEqual([only(first.items).id]);
      });

      it("rejects a duplicate envelope ID", async () => {
        const first = await write(adapter, { items: [{}] });
        const batch = makeBatch({ items: [{}] });
        await expect(adapter.write({ ...batch, envelope: first.envelope })).rejects.toThrow();
        expect(await itemIds(adapter)).toEqual(first.items.map((item) => item.id));
      });
    });

    describe("item filters", () => {
      let ids: Record<"a" | "b" | "c" | "d" | "e", string>;

      beforeEach(async () => {
        const receivedAt = iso(T0 + 10 * DAY);
        const a = await write(adapter, {
          receivedAt,
          items: [
            {
              kind: "error",
              itemType: "event",
              level: "error",
              environment: "dev",
              release: "1.0",
              eventId: "a".repeat(32),
              issueId: issueId(1),
              traceId: "trace-1",
              title: "TypeError: boom",
              timestamp: iso(T0),
            },
          ],
        });
        const b = await write(adapter, {
          receivedAt,
          scope: { service: "api" },
          items: [
            {
              kind: "message",
              itemType: "event",
              level: "info",
              environment: "prod",
              release: "2.0",
              eventId: "b".repeat(32),
              issueId: issueId(2),
              traceId: "trace-2",
              title: "hello 100%_done",
              timestamp: iso(T0 + HOUR),
            },
          ],
        });
        const c = await write(adapter, {
          receivedAt,
          scope: { session: "s2" },
          items: [
            {
              kind: "log",
              itemType: "log",
              level: "warning",
              environment: "dev",
              traceId: "trace-1",
              title: "log line",
              timestamp: iso(T0 + 2 * HOUR),
            },
          ],
        });
        const d = await write(adapter, {
          receivedAt,
          scope: { project: "p2" },
          items: [
            { kind: "span", itemType: "span", title: "GET /users", timestamp: iso(T0 + 3 * HOUR) },
          ],
        });
        const e = await write(adapter, {
          receivedAt,
          scope: { project: "p2" },
          items: [
            {
              kind: "attachment",
              itemType: "attachment",
              title: "a_b.txt",
              timestamp: iso(T0 + 4 * HOUR),
            },
          ],
        });
        ids = {
          a: only(a.items).id,
          b: only(b.items).id,
          c: only(c.items).id,
          d: only(d.items).id,
          e: only(e.items).id,
        };
      });

      it.each<[string, ResolvedItemFilter, ("a" | "b" | "c" | "d" | "e")[]]>([
        ["empty", {}, ["a", "b", "c", "d", "e"]],
        ["project", { project: ["p1"] }, ["a", "b", "c"]],
        ["session", { session: ["s2"] }, ["c"]],
        ["service", { service: ["api"] }, ["b"]],
        ["kind", { kind: ["error", "log"] }, ["a", "c"]],
        ["itemType", { itemType: ["span", "attachment"] }, ["d", "e"]],
        ["level", { level: ["info", "warning"] }, ["b", "c"]],
        ["minLevel", { minLevel: "warning" }, ["a", "c"]],
        ["minLevel trace excludes null", { minLevel: "trace" }, ["a", "b", "c"]],
        ["environment", { environment: ["dev"] }, ["a", "c"]],
        ["release", { release: ["2.0"] }, ["b"]],
        ["eventId", { eventId: "a".repeat(32) }, ["a"]],
        ["issueId", { issueId: issueId(2) }, ["b"]],
        ["traceId", { traceId: "trace-1" }, ["a", "c"]],
        ["q case-insensitive", { q: "TYPEERROR" }, ["a"]],
        ["q percent literal", { q: "%" }, ["b"]],
        ["q underscore literal", { q: "_" }, ["b", "e"]],
        ["q percent+underscore", { q: "0%_d" }, ["b"]],
        ["from (timestamp)", { from: T0 + 2 * HOUR }, ["c", "d", "e"]],
        ["to (timestamp)", { to: T0 + HOUR }, ["a", "b"]],
        ["inclusive bounds", { from: T0 + HOUR, to: T0 + 2 * HOUR }, ["b", "c"]],
        [
          "combined",
          { project: ["p1"], kind: ["error", "log"], q: "o", minLevel: "warning" },
          ["a", "c"],
        ],
      ])("%s", async (_label, filter, expected) => {
        expect(await itemIds(adapter, filter)).toEqual(desc(expected.map((key) => ids[key])));
      });

      it("ignores receivedAt for time bounds", async () => {
        expect(await itemIds(adapter, { to: T0 + 5 * DAY })).toHaveLength(5);
        expect(await itemIds(adapter, { from: T0 + 5 * DAY })).toEqual([]);
      });

      it("returns summaries without data", async () => {
        const { items } = await adapter.listItems({ issueId: issueId(1) }, ALL);
        expect(only(items)).not.toHaveProperty("data");
        expect(only(items)).toMatchObject({ id: ids.a, kind: "error", title: "TypeError: boom" });
      });
    });

    describe("pagination", () => {
      it("pages items newest first", async () => {
        const written: string[] = [];
        for (let index = 0; index < 7; index += 1) {
          const { items } = await write(adapter, { items: [{}] });
          written.push(only(items).id);
        }
        const pages: string[][] = [];
        let cursor: string | null = null;
        do {
          const page = await adapter.listItems({}, { limit: 3, cursor });
          pages.push(page.items.map((item) => item.id));
          cursor = page.nextCursor === null ? null : decodeCursor(page.nextCursor);
          if (page.nextCursor !== null) {
            expect(page.nextCursor).toBe(encodeCursor(page.items.at(-1)?.id ?? ""));
          }
        } while (cursor !== null);
        expect(pages.map((page) => page.length)).toEqual([3, 3, 1]);
        expect(pages.flat()).toEqual(desc(written));
        expect(new Set(pages.flat()).size).toBe(7);
      });

      it("returns nextCursor null when everything fits", async () => {
        await write(adapter, { items: [{}, {}] });
        await expect(adapter.listItems({}, { limit: 2, cursor: null })).resolves.toHaveProperty(
          "nextCursor",
          null,
        );
      });

      it("pages issues by lastSeenAt then id", async () => {
        const seenAt = iso(T0);
        for (const n of [1, 3, 2]) {
          await write(adapter, { receivedAt: seenAt, items: [{ issueId: issueId(n) }] });
        }
        await write(adapter, { receivedAt: iso(T0 - HOUR), items: [{ issueId: issueId(9) }] });
        const first = await adapter.listIssues({}, { limit: 2, cursor: null });
        expect(first.items.map((issue) => issue.id)).toEqual([issueId(3), issueId(2)]);
        expect(first.nextCursor).not.toBeNull();
        const second = await adapter.listIssues(
          {},
          { limit: 2, cursor: decodeCursor(first.nextCursor ?? "") },
        );
        expect(second.items.map((issue) => issue.id)).toEqual([issueId(1), issueId(9)]);
        expect(second.nextCursor).toBeNull();
      });
    });

    describe("issues", () => {
      it("upserts with isNew and count", async () => {
        const first = await write(adapter, { items: [{ issueId: issueId(1) }] });
        const second = await write(adapter, {
          items: [{ issueId: issueId(1) }, { issueId: issueId(1) }],
        });
        expect(first.result.issues).toEqual([{ id: issueId(1), isNew: true, count: 1 }]);
        expect(second.result.issues).toEqual([
          { id: issueId(1), isNew: false, count: 2 },
          { id: issueId(1), isNew: false, count: 3 },
        ]);
        const batch = await write(adapter, {
          items: [{ issueId: issueId(2) }, { issueId: issueId(2) }],
        });
        expect(batch.result.issues).toEqual([
          { id: issueId(2), isNew: true, count: 1 },
          { id: issueId(2), isNew: false, count: 2 },
        ]);
      });

      it("replaces latest-event fields and keeps the first fingerprint", async () => {
        const first = await write(adapter, {
          receivedAt: iso(T0),
          items: [
            {
              issueId: issueId(1),
              kind: "error",
              title: "old",
              level: "error",
              platform: "node",
              issue: { fingerprint: ["first"], culprit: "c1" },
            },
          ],
        });
        const second = await write(adapter, {
          receivedAt: iso(T0 + HOUR),
          items: [
            {
              issueId: issueId(1),
              kind: "error",
              title: "new",
              level: "fatal",
              platform: "python",
              issue: { fingerprint: ["second"], culprit: "c2" },
            },
          ],
        });
        expect(await adapter.getIssue(issueId(1))).toEqual({
          id: issueId(1),
          shortId: issueId(1).slice(0, 8),
          project: "p1",
          session: "s1",
          fingerprint: ["first"],
          fingerprintHash: `hash-${issueId(1)}`,
          kind: "error",
          title: "new",
          culprit: "c2",
          level: "fatal",
          platform: "python",
          count: 2,
          firstSeenAt: first.envelope.receivedAt,
          lastSeenAt: second.envelope.receivedAt,
          lastItemId: only(second.items).id,
          services: ["web"],
        } satisfies Issue);
      });

      it("derives services from items", async () => {
        await write(adapter, { scope: { service: "web" }, items: [{ issueId: issueId(1) }] });
        await write(adapter, { scope: { service: "api" }, items: [{ issueId: issueId(1) }] });
        await expect(adapter.getIssue(issueId(1))).resolves.toHaveProperty("services", [
          "api",
          "web",
        ]);
      });

      describe("listIssues filters", () => {
        beforeEach(async () => {
          await write(adapter, {
            receivedAt: iso(T0),
            items: [{ issueId: issueId(1), kind: "error", level: "error", title: "TypeError: a" }],
          });
          await write(adapter, {
            receivedAt: iso(T0 + HOUR),
            scope: { service: "api" },
            items: [{ issueId: issueId(2), kind: "message", level: "info", title: "Hello world" }],
          });
          await write(adapter, {
            receivedAt: iso(T0 + 2 * HOUR),
            scope: { session: "s2" },
            items: [
              { issueId: issueId(3), kind: "error", level: "warning", title: "RangeError: b" },
            ],
          });
        });

        it.each<[string, Parameters<StorageAdapter["listIssues"]>[0], number[]]>([
          ["empty", {}, [3, 2, 1]],
          ["kind", { kind: ["message"] }, [2]],
          ["level", { level: ["error", "warning"] }, [3, 1]],
          ["minLevel", { minLevel: "warning" }, [3, 1]],
          ["q", { q: "ERROR" }, [3, 1]],
          ["service", { service: ["api"] }, [2]],
          ["session", { session: ["s2"] }, [3]],
          ["from on lastSeenAt", { from: T0 + HOUR }, [3, 2]],
          ["to on lastSeenAt", { to: T0 + HOUR }, [2, 1]],
        ])("%s", async (_label, filter, expected) => {
          const page = await adapter.listIssues(filter, ALL);
          expect(page.items.map((issue) => issue.id)).toEqual(expected.map((n) => issueId(n)));
        });

        it("applies time bounds to lastSeenAt, not firstSeenAt", async () => {
          await write(adapter, {
            receivedAt: iso(T0 + 3 * HOUR),
            items: [{ issueId: issueId(1) }],
          });
          const page = await adapter.listIssues({ from: T0 + 3 * HOUR }, ALL);
          expect(page.items.map((issue) => issue.id)).toEqual([issueId(1)]);
        });
      });

      it("finds issues by prefix", async () => {
        const prefixed = [
          "aaaa000000000001",
          "aaaa000000000002",
          "aaaa000000000003",
          "bbbb000000000001",
        ];
        for (const id of prefixed) {
          await write(adapter, {
            scope: { session: id.endsWith("3") ? "s2" : "s1" },
            items: [{ issueId: id }],
          });
        }
        expect(await idsOf(adapter.findIssues("bbbb", {}))).toEqual(["bbbb000000000001"]);
        expect(await idsOf(adapter.findIssues("aaaa", {}))).toEqual([
          "aaaa000000000001",
          "aaaa000000000002",
        ]);
        expect(await idsOf(adapter.findIssues("aaaa", { session: "s2" }))).toEqual([
          "aaaa000000000003",
        ]);
        await expect(adapter.findIssues("cccc", {})).resolves.toEqual([]);
      });
    });

    describe("scopes", () => {
      it("tracks first/last seen, item and issue counts", async () => {
        await write(adapter, { receivedAt: iso(T0 + HOUR), items: [{ issueId: issueId(1) }, {}] });
        await write(adapter, { receivedAt: iso(T0), items: [{ issueId: issueId(2) }] });
        await write(adapter, { receivedAt: iso(T0 + 2 * HOUR), items: [{ issueId: issueId(1) }] });
        await write(adapter, { receivedAt: iso(T0), scope: { service: "api" }, items: [{}] });
        expect(await adapter.listScopes({})).toEqual([
          {
            project: "p1",
            session: "s1",
            service: "api",
            firstSeenAt: iso(T0),
            lastSeenAt: iso(T0),
            itemCount: 1,
            issueCount: 0,
          },
          {
            project: "p1",
            session: "s1",
            service: "web",
            firstSeenAt: iso(T0 + HOUR),
            lastSeenAt: iso(T0 + 2 * HOUR),
            itemCount: 4,
            issueCount: 2,
          },
        ]);
      });

      it("filters and sorts by project, session, service", async () => {
        const scopes: Scope[] = [
          { project: "p2", session: "s1", service: "web" },
          { project: "p1", session: "s2", service: "web" },
          { project: "p1", session: "s1", service: "web" },
          { project: "p1", session: "s1", service: "api" },
        ];
        for (const scope of scopes) {
          await write(adapter, { scope, items: [{}] });
        }
        const keys = async (filter: ScopeFilter): Promise<string[]> => {
          const rows = await adapter.listScopes(filter);
          return rows.map((row) => `${row.project}/${row.session}/${row.service}`);
        };
        expect(await keys({})).toEqual(["p1/s1/api", "p1/s1/web", "p1/s2/web", "p2/s1/web"]);
        expect(await keys({ project: "p1" })).toEqual(["p1/s1/api", "p1/s1/web", "p1/s2/web"]);
        expect(await keys({ project: ["p1"], session: "s1" })).toEqual(["p1/s1/api", "p1/s1/web"]);
        expect(await keys({ service: ["web"], session: ["s1"] })).toEqual([
          "p1/s1/web",
          "p2/s1/web",
        ]);
      });

      it("is touched by a failed envelope", async () => {
        await write(adapter, {
          scope: { service: "broken" },
          parseError: "bad header",
          receivedAt: iso(T0),
        });
        expect(await adapter.listScopes({ service: "broken" })).toEqual([
          {
            project: "p1",
            session: "s1",
            service: "broken",
            firstSeenAt: iso(T0),
            lastSeenAt: iso(T0),
            itemCount: 0,
            issueCount: 0,
          },
        ]);
      });
    });

    describe("getItemByEventId", () => {
      it("prefers error/message/transaction records", async () => {
        const eventId = "c".repeat(32);
        await write(adapter, { items: [{ kind: "attachment", itemType: "attachment", eventId }] });
        const { items } = await write(adapter, { items: [{ kind: "error", eventId }] });
        await write(adapter, { items: [{ kind: "message", eventId }] });
        await expect(adapter.getItemByEventId(eventId)).resolves.toHaveProperty(
          "id",
          only(items).id,
        );
      });

      it("falls back to the oldest record of any kind", async () => {
        const eventId = "d".repeat(32);
        const { items } = await write(adapter, {
          items: [
            { kind: "attachment", itemType: "attachment", eventId },
            { kind: "other", itemType: "session", eventId },
          ],
        });
        await expect(adapter.getItemByEventId(eventId)).resolves.toHaveProperty("id", items[0]?.id);
      });
    });

    describe("failed envelopes", () => {
      it("lists failed envelopes without body", async () => {
        const body = new Uint8Array([1, 2, 3]);
        const failed = await write(adapter, { parseError: "bad", body, receivedAt: iso(T0) });
        await write(adapter, { items: [{}] });
        const page = await adapter.listFailedEnvelopes({}, ALL);
        const listed = only(page.items);
        expect(listed).not.toHaveProperty("body");
        expect(listed).toEqual({ ...failed.envelope, body: undefined });
        const stored = await adapter.getEnvelope(failed.envelope.id);
        expect(bytes(stored?.body ?? null)).toEqual([1, 2, 3]);
      });

      it("filters by scope and receivedAt and paginates", async () => {
        const a = await write(adapter, { parseError: "x", receivedAt: iso(T0) });
        const b = await write(adapter, {
          parseError: "x",
          receivedAt: iso(T0 + HOUR),
          scope: { service: "api" },
        });
        const c = await write(adapter, { parseError: "x", receivedAt: iso(T0 + 2 * HOUR) });
        const list = async (
          filter: Parameters<StorageAdapter["listFailedEnvelopes"]>[0],
        ): Promise<string[]> => {
          const page = await adapter.listFailedEnvelopes(filter, ALL);
          return page.items.map((envelope) => envelope.id);
        };
        expect(await list({})).toEqual([c.envelope.id, b.envelope.id, a.envelope.id]);
        expect(await list({ service: ["api"] })).toEqual([b.envelope.id]);
        expect(await list({ from: T0 + HOUR, to: T0 + HOUR })).toEqual([b.envelope.id]);
        const first = await adapter.listFailedEnvelopes({}, { limit: 2, cursor: null });
        expect(first.items.map((envelope) => envelope.id)).toEqual([c.envelope.id, b.envelope.id]);
        expect(first.nextCursor).toBe(encodeCursor(b.envelope.id));
        const second = await adapter.listFailedEnvelopes({}, { limit: 2, cursor: b.envelope.id });
        expect(second.items.map((envelope) => envelope.id)).toEqual([a.envelope.id]);
        expect(second.nextCursor).toBeNull();
      });
    });

    describe("deleteItems", () => {
      it("deletes by scope and returns the count", async () => {
        const web = await write(adapter, { items: [{}, {}] });
        const api = await write(adapter, { scope: { service: "api" }, items: [{}] });
        expect(await adapter.deleteItems({ service: ["web"] })).toBe(2);
        expect(await itemIds(adapter)).toEqual(api.items.map((item) => item.id));
        expect(await adapter.getEnvelope(web.envelope.id)).toBeNull();
        expect(await adapter.getEnvelope(api.envelope.id)).not.toBeNull();
        const scopes = await adapter.listScopes({});
        expect(scopes.map((row) => [row.service, row.itemCount])).toEqual([
          ["api", 1],
          ["web", 0],
        ]);
      });

      it("deletes by kind and keeps envelopes with remaining items", async () => {
        const { envelope, items } = await write(adapter, {
          items: [{ kind: "log", itemType: "log" }, { kind: "error" }],
        });
        expect(await adapter.deleteItems({ kind: ["log"] })).toBe(1);
        expect(await itemIds(adapter)).toEqual([items[1]?.id]);
        expect(await adapter.getEnvelope(envelope.id)).not.toBeNull();
      });

      it("removes an issue whose items are all deleted, together with blobs", async () => {
        const { items } = await write(adapter, {
          items: [
            { issueId: issueId(1) },
            { kind: "attachment", itemType: "attachment", blob: new Uint8Array([1]) },
          ],
        });
        await write(adapter, { items: [{ issueId: issueId(2) }] });
        expect(await adapter.deleteItems({ issueId: issueId(1) })).toBe(1);
        expect(await adapter.getIssue(issueId(1))).toBeNull();
        await expect(adapter.getIssue(issueId(2))).resolves.toHaveProperty("count", 1);
        expect(await adapter.deleteItems({ kind: ["attachment"] })).toBe(1);
        expect(await adapter.getBlob(items[1]?.id ?? "")).toBeNull();
      });

      it("recomputes remaining issues", async () => {
        const first = await write(adapter, {
          receivedAt: iso(T0),
          items: [{ issueId: issueId(1) }],
        });
        const second = await write(adapter, {
          receivedAt: iso(T0 + HOUR),
          scope: { service: "api" },
          items: [{ issueId: issueId(1) }],
        });
        await write(adapter, {
          receivedAt: iso(T0 + 2 * HOUR),
          scope: { service: "job" },
          items: [{ issueId: issueId(1) }],
        });
        await expect(adapter.getIssue(issueId(1))).resolves.toHaveProperty("count", 3);
        await adapter.deleteItems({ service: ["job"] });
        expect(await adapter.getIssue(issueId(1))).toMatchObject({
          count: 2,
          firstSeenAt: first.envelope.receivedAt,
          lastSeenAt: second.envelope.receivedAt,
          lastItemId: only(second.items).id,
          services: ["api", "web"],
        });
      });

      it("deletes all items with an empty filter but keeps failed envelopes and scopes", async () => {
        await write(adapter, { items: [{ issueId: issueId(1) }, {}] });
        const failed = await write(adapter, { parseError: "bad" });
        expect(await adapter.deleteItems({})).toBe(2);
        expect(await itemIds(adapter)).toEqual([]);
        await expect(adapter.listIssues({}, ALL)).resolves.toHaveProperty("items", []);
        expect(await adapter.getEnvelope(failed.envelope.id)).not.toBeNull();
        expect(only(await adapter.listScopes({}))).toMatchObject({ itemCount: 0, issueCount: 0 });
      });
    });

    describe("pruneIdleSessions", () => {
      it("removes fully idle sessions only", async () => {
        const cutoff = new Date(T0 + 5 * DAY);
        await write(adapter, {
          receivedAt: iso(T0),
          scope: { session: "mixed", service: "web" },
          items: [{}],
        });
        await write(adapter, {
          receivedAt: iso(T0 + 10 * DAY),
          scope: { session: "mixed", service: "api" },
          items: [{}],
        });
        const idle = await write(adapter, {
          receivedAt: iso(T0),
          scope: { session: "idle" },
          body: new Uint8Array([1]),
          items: [
            { issueId: issueId(1) },
            { kind: "attachment", itemType: "attachment", blob: new Uint8Array([2]) },
          ],
        });
        const idleFailed = await write(adapter, {
          receivedAt: iso(T0 + DAY),
          scope: { session: "idle", service: "api" },
          parseError: "bad",
        });
        await write(adapter, {
          receivedAt: iso(T0 + 6 * DAY),
          scope: { session: "fresh" },
          items: [{ issueId: issueId(2) }],
        });

        expect(await adapter.pruneIdleSessions(cutoff)).toEqual({
          sessionsDeleted: 1,
          itemsDeleted: 2,
        });
        for (const item of idle.items) {
          expect(await adapter.getItem(item.id)).toBeNull();
          expect(await adapter.getBlob(item.id)).toBeNull();
        }
        expect(await adapter.getIssue(issueId(1))).toBeNull();
        expect(await adapter.getEnvelope(idle.envelope.id)).toBeNull();
        expect(await adapter.getEnvelope(idleFailed.envelope.id)).toBeNull();
        expect(await adapter.getIssue(issueId(2))).not.toBeNull();
        const rows = await adapter.listScopes({});
        expect(rows.map((row) => `${row.session}/${row.service}`)).toEqual([
          "fresh/web",
          "mixed/api",
          "mixed/web",
        ]);
        expect(await itemIds(adapter)).toHaveLength(3);
      });

      it("uses a strict cutoff", async () => {
        await write(adapter, { receivedAt: iso(T0), items: [{}] });
        expect(await adapter.pruneIdleSessions(new Date(T0))).toEqual({
          sessionsDeleted: 0,
          itemsDeleted: 0,
        });
        expect(await adapter.pruneIdleSessions(new Date(T0 + 1))).toEqual({
          sessionsDeleted: 1,
          itemsDeleted: 1,
        });
      });
    });

    describe("pruneOldItems", () => {
      it("removes old noise kinds only", async () => {
        const cutoff = new Date(T0 + DAY);
        const noise = await write(adapter, {
          receivedAt: iso(T0),
          items: [
            { kind: "span", itemType: "span" },
            { kind: "log", itemType: "log" },
            { kind: "transaction", itemType: "transaction" },
            { kind: "other", itemType: "session" },
          ],
        });
        const mixed = await write(adapter, {
          receivedAt: iso(T0),
          items: [
            { kind: "span", itemType: "span" },
            { kind: "error", issueId: issueId(1) },
            { kind: "message", issueId: issueId(2) },
            { kind: "attachment", itemType: "attachment", blob: new Uint8Array([7]) },
          ],
        });
        const recent = await write(adapter, {
          receivedAt: iso(T0 + 2 * DAY),
          items: [{ kind: "span", itemType: "span" }],
        });
        const oldFailed = await write(adapter, { receivedAt: iso(T0), parseError: "bad" });
        const newFailed = await write(adapter, {
          receivedAt: iso(T0 + 2 * DAY),
          parseError: "bad",
        });
        const issueBefore = await adapter.getIssue(issueId(1));

        expect(
          await adapter.pruneOldItems(["span", "transaction", "log", "other"], cutoff),
        ).toEqual({
          itemsDeleted: 5,
        });
        expect(await itemIds(adapter)).toEqual(
          desc([...mixed.items.slice(1).map((item) => item.id), only(recent.items).id]),
        );
        expect(await adapter.getEnvelope(noise.envelope.id)).toBeNull();
        expect(await adapter.getEnvelope(mixed.envelope.id)).not.toBeNull();
        expect(await adapter.getEnvelope(recent.envelope.id)).not.toBeNull();
        expect(await adapter.getEnvelope(oldFailed.envelope.id)).toBeNull();
        expect(await adapter.getEnvelope(newFailed.envelope.id)).not.toBeNull();
        expect(bytes(await adapter.getBlob(mixed.items[3]?.id ?? ""))).toEqual([7]);
        expect(await adapter.getIssue(issueId(1))).toEqual(issueBefore);
        expect(only(await adapter.listScopes({})).itemCount).toBe(4);
      });

      it("uses a strict cutoff", async () => {
        await write(adapter, { receivedAt: iso(T0), items: [{ kind: "log", itemType: "log" }] });
        expect(await adapter.pruneOldItems(["log"], new Date(T0))).toEqual({ itemsDeleted: 0 });
        expect(await adapter.pruneOldItems(["log"], new Date(T0 + 1))).toEqual({ itemsDeleted: 1 });
      });
    });
  });
}

export { makeBatch, nextId, runStorageContract };
export type { ItemSpec, WriteSpec };
