import { DEFAULT_MAX_ITEMS } from "#src/defaults.js";
import { SentraConfigError } from "#src/errors.js";
import { encodeCursor, encodeIssueCursor, parseIssueCursor } from "#src/query/cursor.js";
import {
  matchesEnvelopeFilter,
  matchesIssueFilter,
  matchesItemFilter,
  matchesScope,
} from "#src/storage/match.js";
import type {
  IngestBatch,
  ResolvedIssueFilter,
  ResolvedItemFilter,
  ResolvedPage,
  ResolvedScopeTimeFilter,
  StorageAdapter,
} from "#src/storage/types.js";
import type {
  Envelope,
  Issue,
  Item,
  ItemKind,
  ItemSummary,
  OneOrMany,
  Page,
  Scope,
  ScopeFilter,
  ScopeRow,
  ScopeSummary,
} from "#src/types.js";

interface MemoryStorageOptions {
  /** Max stored records; oldest are evicted. Default `10_000`. */
  maxItems?: number;
}

type StoredIssue = Omit<Issue, "shortId" | "services">;

interface RemovalResult {
  envelopes: Set<string>;
  issues: Set<string>;
}

const PREFERRED_EVENT_KINDS: ReadonlySet<ItemKind> = new Set(["error", "message", "transaction"]);
const SHORT_ID_LENGTH = 8;
const FIND_ISSUES_LIMIT = 2;

function scopeKey(scope: Scope): string {
  return JSON.stringify([scope.project, scope.session, scope.service]);
}

function sessionKey(project: string, session: string): string {
  return JSON.stringify([project, session]);
}

function toList(value: OneOrMany<string> | undefined): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  return Array.isArray(value) ? value : [value];
}

function toSummary(item: Item): ItemSummary {
  return {
    id: item.id,
    envelopeId: item.envelopeId,
    scope: { ...item.scope },
    kind: item.kind,
    itemType: item.itemType,
    receivedAt: item.receivedAt,
    timestamp: item.timestamp,
    eventId: item.eventId,
    issueId: item.issueId,
    traceId: item.traceId,
    level: item.level,
    environment: item.environment,
    release: item.release,
    platform: item.platform,
    title: item.title,
  };
}

function withoutBody(envelope: Envelope): Omit<Envelope, "body"> {
  const copy = structuredClone(envelope);
  delete copy.body;
  return copy;
}

function byIdDesc(a: { id: string }, b: { id: string }): number {
  if (a.id === b.id) {
    return 0;
  }
  return a.id < b.id ? 1 : -1;
}

function compareText(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
}

function byScope(a: Scope, b: Scope): number {
  return (
    compareText(a.project, b.project) ||
    compareText(a.session, b.session) ||
    compareText(a.service, b.service)
  );
}

function byIdAsc(a: { id: string }, b: { id: string }): number {
  return -byIdDesc(a, b);
}

function pageById<T extends { id: string }>(sorted: T[], page: ResolvedPage): Page<T> {
  const { cursor } = page;
  const start = cursor === null ? sorted : sorted.filter((entry) => entry.id < cursor);
  const items = start.slice(0, page.limit);
  const last = items.at(-1);
  return {
    items,
    nextCursor: start.length > page.limit && last !== undefined ? encodeCursor(last.id) : null,
  };
}

function addToIndex(index: Map<string, Set<string>>, key: string, id: string): void {
  const set = index.get(key) ?? new Set<string>();
  set.add(id);
  index.set(key, set);
}

function deleteWhere<T>(map: Map<string, T>, predicate: (value: T) => boolean): void {
  for (const [key, value] of map) {
    if (predicate(value)) {
      map.delete(key);
    }
  }
}

function validateMaxItems(value: number | undefined): number {
  const maxItems = value ?? DEFAULT_MAX_ITEMS;
  if (!Number.isInteger(maxItems) || maxItems < 1) {
    throw new SentraConfigError(
      "invalid_option",
      `maxItems must be a positive integer, got ${maxItems}`,
    );
  }
  return maxItems;
}

class MemoryStorage implements StorageAdapter {
  public readonly type = "memory";

  readonly #maxItems: number;
  readonly #items = new Map<string, Item>();
  readonly #scopeItems = new Map<string, string[]>();
  readonly #issues = new Map<string, StoredIssue>();
  readonly #envelopes = new Map<string, Envelope>();
  readonly #blobs = new Map<string, Uint8Array>();
  readonly #scopes = new Map<string, ScopeRow>();
  readonly #envelopeItems = new Map<string, Set<string>>();
  readonly #issueItems = new Map<string, Set<string>>();

  public constructor(options: MemoryStorageOptions = {}) {
    this.#maxItems = validateMaxItems(options.maxItems);
  }

  public async init(): Promise<{ driver: string | null; path: string | null }> {
    await this.vacuum();
    return { driver: null, path: null };
  }

  public async write(
    batch: IngestBatch,
  ): Promise<{ issues: { id: string; isNew: boolean; count: number }[] }> {
    this.#validate(batch);
    this.#storeEnvelope(batch);
    const issues = batch.issues.map((entry) => this.#upsertIssue(entry));
    this.#evict();
    return { issues };
  }

  public async listScopes(filter: ScopeFilter): Promise<ScopeSummary[]> {
    const rows = [...this.#scopes.values()]
      .filter((row) => matchesScope(row, filter))
      .toSorted(byScope)
      .map((row) => this.#toScopeSummary(row));
    return rows;
  }

  public async listIssues(filter: ResolvedIssueFilter, page: ResolvedPage): Promise<Page<Issue>> {
    const after = page.cursor === null ? null : parseIssueCursor(page.cursor);
    const sorted = this.#allIssues()
      .filter((issue) => matchesIssueFilter(issue, filter))
      .map((issue) => ({ issue, seen: Date.parse(issue.lastSeenAt) }))
      .toSorted((a, b) => b.seen - a.seen || byIdDesc(a.issue, b.issue));
    const remaining =
      after === null
        ? sorted
        : sorted.filter(
            ({ issue, seen }) =>
              seen < after.lastSeenAt || (seen === after.lastSeenAt && issue.id < after.id),
          );
    const items = remaining.slice(0, page.limit).map(({ issue }) => issue);
    const last = items.at(-1);
    return {
      items,
      nextCursor:
        remaining.length > page.limit && last !== undefined ? encodeIssueCursor(last) : null,
    };
  }

  public async findIssues(idPrefix: string, scope: ScopeFilter): Promise<Issue[]> {
    const filter: ResolvedIssueFilter = {
      project: toList(scope.project),
      session: toList(scope.session),
      service: toList(scope.service),
    };
    const issues = this.#allIssues()
      .filter((issue) => issue.id.startsWith(idPrefix) && matchesIssueFilter(issue, filter))
      .toSorted(byIdAsc)
      .slice(0, FIND_ISSUES_LIMIT);
    return issues;
  }

  public async getIssue(id: string): Promise<Issue | null> {
    const stored = this.#issues.get(id);
    return stored === undefined ? null : this.#toIssue(stored);
  }

  public async listItems(
    filter: ResolvedItemFilter,
    page: ResolvedPage,
  ): Promise<Page<ItemSummary>> {
    const sorted = [...this.#items.values()]
      .filter((item) => matchesItemFilter(item, filter))
      .toSorted(byIdDesc);
    const result = pageById(sorted, page);
    return {
      items: result.items.map((item) => toSummary(item)),
      nextCursor: result.nextCursor,
    };
  }

  public async getItem(id: string): Promise<Item | null> {
    const item = this.#items.get(id);
    return item === undefined ? null : structuredClone(item);
  }

  public async getItemByEventId(eventId: string): Promise<Item | null> {
    const candidates = [...this.#items.values()]
      .filter((item) => item.eventId === eventId)
      .toSorted(byIdAsc);
    const item =
      candidates.find((candidate) => PREFERRED_EVENT_KINDS.has(candidate.kind)) ?? candidates[0];
    return item === undefined ? null : structuredClone(item);
  }

  public async getBlob(itemId: string): Promise<Uint8Array | null> {
    const blob = this.#blobs.get(itemId);
    return blob === undefined ? null : new Uint8Array(blob);
  }

  public async getEnvelope(id: string): Promise<Envelope | null> {
    const envelope = this.#envelopes.get(id);
    if (envelope === undefined) {
      return null;
    }
    const copy = withoutBody(envelope);
    return envelope.body === undefined ? copy : { ...copy, body: new Uint8Array(envelope.body) };
  }

  public async listFailedEnvelopes(
    filter: ResolvedScopeTimeFilter,
    page: ResolvedPage,
  ): Promise<Page<Omit<Envelope, "body">>> {
    const sorted = [...this.#envelopes.values()]
      .filter((envelope) => envelope.parseError !== null && matchesEnvelopeFilter(envelope, filter))
      .toSorted(byIdDesc);
    const result = pageById(sorted, page);
    return {
      items: result.items.map((envelope) => withoutBody(envelope)),
      nextCursor: result.nextCursor,
    };
  }

  public async deleteItems(filter: ResolvedItemFilter): Promise<number> {
    const ids = [...this.#items.values()]
      .filter((item) => matchesItemFilter(item, filter))
      .map((item) => item.id);
    const removed = this.#removeItems(new Set(ids));
    this.#dropEmptyEnvelopes([...this.#envelopes.keys()]);
    for (const issueId of removed.issues) {
      this.#recomputeIssue(issueId);
    }
    return ids.length;
  }

  public async pruneIdleSessions(
    cutoff: Date,
  ): Promise<{ sessionsDeleted: number; itemsDeleted: number }> {
    const lastSeen = new Map<string, number>();
    for (const row of this.#scopes.values()) {
      const key = sessionKey(row.project, row.session);
      lastSeen.set(
        key,
        Math.max(lastSeen.get(key) ?? Number.NEGATIVE_INFINITY, Date.parse(row.lastSeenAt)),
      );
    }
    const idle = new Set(
      [...lastSeen].filter(([, seen]) => seen < cutoff.getTime()).map(([key]) => key),
    );
    const inIdle = (project: string, session: string): boolean =>
      idle.has(sessionKey(project, session));

    const itemIds = [...this.#items.values()]
      .filter((item) => inIdle(item.scope.project, item.scope.session))
      .map((item) => item.id);
    this.#removeItems(new Set(itemIds));
    deleteWhere(this.#envelopes, (envelope) =>
      inIdle(envelope.scope.project, envelope.scope.session),
    );
    deleteWhere(this.#issues, (issue) => inIdle(issue.project, issue.session));
    for (const [key, row] of this.#scopes) {
      if (inIdle(row.project, row.session)) {
        this.#scopes.delete(key);
        this.#scopeItems.delete(key);
      }
    }
    for (const id of this.#envelopeItems.keys()) {
      if (!this.#envelopes.has(id)) {
        this.#envelopeItems.delete(id);
      }
    }
    for (const id of this.#issueItems.keys()) {
      if (!this.#issues.has(id)) {
        this.#issueItems.delete(id);
      }
    }
    return { sessionsDeleted: idle.size, itemsDeleted: itemIds.length };
  }

  public async pruneOldItems(kinds: ItemKind[], cutoff: Date): Promise<{ itemsDeleted: number }> {
    if (kinds.length === 0) {
      return { itemsDeleted: 0 };
    }
    const kindSet = new Set(kinds);
    const limit = cutoff.getTime();
    const ids = [...this.#items.values()]
      .filter((item) => kindSet.has(item.kind) && Date.parse(item.receivedAt) < limit)
      .map((item) => item.id);
    this.#removeItems(new Set(ids));
    this.#dropEmptyEnvelopes([...this.#envelopes.keys()]);
    deleteWhere(
      this.#envelopes,
      (envelope) => envelope.parseError !== null && Date.parse(envelope.receivedAt) < limit,
    );
    return { itemsDeleted: ids.length };
  }

  /** Drops empty index entries. */
  public async vacuum(): Promise<void> {
    for (const index of [this.#envelopeItems, this.#issueItems]) {
      deleteWhere(index, (ids) => ids.size === 0);
    }
  }

  public async close(): Promise<void> {
    this.#items.clear();
    this.#scopeItems.clear();
    this.#issues.clear();
    this.#envelopes.clear();
    this.#blobs.clear();
    this.#scopes.clear();
    this.#envelopeItems.clear();
    this.#issueItems.clear();
  }

  #validate(batch: IngestBatch): void {
    if (this.#envelopes.has(batch.envelope.id)) {
      throw new Error(`duplicate envelope id ${batch.envelope.id}`);
    }
    const seen = new Set<string>();
    for (const { item } of batch.items) {
      if (this.#items.has(item.id) || seen.has(item.id)) {
        throw new Error(`duplicate item id ${item.id}`);
      }
      seen.add(item.id);
    }
  }

  #storeEnvelope(batch: IngestBatch): void {
    const { envelope } = batch;
    const copy = withoutBody(envelope);
    this.#envelopes.set(
      envelope.id,
      envelope.body === undefined ? copy : { ...copy, body: new Uint8Array(envelope.body) },
    );
    this.#touchScope(envelope.scope, envelope.receivedAt, 0);
    for (const { item, blob } of batch.items) {
      const stored = structuredClone(item);
      this.#items.set(stored.id, stored);
      if (blob !== null) {
        this.#blobs.set(stored.id, new Uint8Array(blob));
      }
      this.#touchScope(stored.scope, envelope.receivedAt, 1);
      const key = scopeKey(stored.scope);
      const scopeIds = this.#scopeItems.get(key) ?? [];
      scopeIds.push(stored.id);
      this.#scopeItems.set(key, scopeIds);
      addToIndex(this.#envelopeItems, stored.envelopeId, stored.id);
      if (stored.issueId !== null) {
        addToIndex(this.#issueItems, stored.issueId, stored.id);
      }
    }
    this.#boundFailedEnvelopes();
  }

  #touchScope(scope: Scope, receivedAt: string, added: number): void {
    const key = scopeKey(scope);
    const row = this.#scopes.get(key);
    if (row === undefined) {
      this.#scopes.set(key, {
        ...scope,
        firstSeenAt: receivedAt,
        lastSeenAt: receivedAt,
        itemCount: added,
      });
      return;
    }
    if (Date.parse(receivedAt) > Date.parse(row.lastSeenAt)) {
      row.lastSeenAt = receivedAt;
    }
    row.itemCount += added;
  }

  #upsertIssue(entry: IngestBatch["issues"][number]): {
    id: string;
    isNew: boolean;
    count: number;
  } {
    const existing = this.#issues.get(entry.id);
    if (existing === undefined) {
      this.#issues.set(entry.id, {
        id: entry.id,
        project: entry.project,
        session: entry.session,
        fingerprint: [...entry.fingerprint],
        fingerprintHash: entry.fingerprintHash,
        kind: entry.kind,
        title: entry.title,
        culprit: entry.culprit,
        level: entry.level,
        platform: entry.platform,
        count: 1,
        firstSeenAt: entry.seenAt,
        lastSeenAt: entry.seenAt,
        lastItemId: entry.itemId,
      });
      return { id: entry.id, isNew: true, count: 1 };
    }
    existing.count += 1;
    existing.lastSeenAt = entry.seenAt;
    existing.lastItemId = entry.itemId;
    existing.title = entry.title;
    existing.culprit = entry.culprit;
    existing.level = entry.level;
    existing.platform = entry.platform;
    return { id: entry.id, isNew: false, count: existing.count };
  }

  #toIssue(stored: StoredIssue): Issue {
    const services = new Set<string>();
    for (const itemId of this.#issueItems.get(stored.id) ?? []) {
      const item = this.#items.get(itemId);
      if (item !== undefined) {
        services.add(item.scope.service);
      }
    }
    return {
      ...structuredClone(stored),
      shortId: stored.id.slice(0, SHORT_ID_LENGTH),
      services: [...services].toSorted(),
    };
  }

  #allIssues(): Issue[] {
    return [...this.#issues.values()].map((stored) => this.#toIssue(stored));
  }

  #toScopeSummary(row: ScopeRow): ScopeSummary {
    return {
      project: row.project,
      session: row.session,
      service: row.service,
      firstSeenAt: row.firstSeenAt,
      lastSeenAt: row.lastSeenAt,
      itemCount: row.itemCount,
      issueCount: this.#issueCount(row),
    };
  }

  #issueCount(scope: Scope): number {
    const issueIds = new Set<string>();
    for (const id of this.#scopeItems.get(scopeKey(scope)) ?? []) {
      const issueId = this.#items.get(id)?.issueId;
      if (issueId !== undefined && issueId !== null) {
        issueIds.add(issueId);
      }
    }
    return issueIds.size;
  }

  #removeItems(ids: ReadonlySet<string>): RemovalResult {
    const result: RemovalResult = { envelopes: new Set(), issues: new Set() };
    const scopes = new Set<string>();
    for (const id of ids) {
      const item = this.#items.get(id);
      if (item === undefined) {
        continue;
      }
      this.#items.delete(id);
      this.#blobs.delete(id);
      scopes.add(scopeKey(item.scope));
      this.#envelopeItems.get(item.envelopeId)?.delete(id);
      result.envelopes.add(item.envelopeId);
      if (item.issueId !== null) {
        this.#issueItems.get(item.issueId)?.delete(id);
        result.issues.add(item.issueId);
      }
    }
    for (const key of scopes) {
      const remaining = (this.#scopeItems.get(key) ?? []).filter((id) => !ids.has(id));
      this.#scopeItems.set(key, remaining);
      const row = this.#scopes.get(key);
      if (row !== undefined) {
        row.itemCount = remaining.length;
      }
    }
    return result;
  }

  #dropEmptyEnvelopes(envelopeIds: Iterable<string>): void {
    for (const id of envelopeIds) {
      const envelope = this.#envelopes.get(id);
      if (
        envelope !== undefined &&
        envelope.parseError === null &&
        (this.#envelopeItems.get(id)?.size ?? 0) === 0
      ) {
        this.#envelopes.delete(id);
        this.#envelopeItems.delete(id);
      }
    }
  }

  #dropEmptyIssues(issueIds: Iterable<string>): void {
    for (const id of issueIds) {
      if ((this.#issueItems.get(id)?.size ?? 0) === 0) {
        this.#issues.delete(id);
        this.#issueItems.delete(id);
      }
    }
  }

  #recomputeIssue(issueId: string): void {
    const issue = this.#issues.get(issueId);
    const items = [...(this.#issueItems.get(issueId) ?? [])]
      .map((id) => this.#items.get(id))
      .filter((item): item is Item => item !== undefined)
      .toSorted(byIdAsc);
    const last = items.at(-1);
    if (issue === undefined || last === undefined) {
      this.#dropEmptyIssues([issueId]);
      return;
    }
    const seen = items.map((item) => Date.parse(item.receivedAt));
    issue.count = items.length;
    issue.firstSeenAt = new Date(Math.min(...seen)).toISOString();
    issue.lastSeenAt = new Date(Math.max(...seen)).toISOString();
    issue.lastItemId = last.id;
  }

  #boundFailedEnvelopes(): void {
    const failed = [...this.#envelopes.values()]
      .filter((envelope) => envelope.parseError !== null)
      .toSorted(byIdAsc);
    for (const envelope of failed.slice(0, Math.max(0, failed.length - this.#maxItems))) {
      this.#envelopes.delete(envelope.id);
    }
  }

  #evict(): void {
    const excess = this.#items.size - this.#maxItems;
    if (excess <= 0) {
      return;
    }
    const oldest = [...this.#items.keys()].toSorted().slice(0, excess);
    const removed = this.#removeItems(new Set(oldest));
    this.#dropEmptyEnvelopes(removed.envelopes);
    this.#dropEmptyIssues(removed.issues);
  }
}

function memoryStorage(options?: MemoryStorageOptions): StorageAdapter {
  return new MemoryStorage(options);
}

export { memoryStorage };
export type { MemoryStorageOptions };
