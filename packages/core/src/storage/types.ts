import type {
  Envelope,
  Issue,
  Item,
  ItemKind,
  ItemSummary,
  Level,
  Page,
  ScopeFilter,
  ScopeSummary,
} from "#src/types.js";

export interface ResolvedScopeFilter {
  project?: string[];
  session?: string[];
  service?: string[];
}

export interface ResolvedScopeTimeFilter extends ResolvedScopeFilter {
  /** Epoch ms, inclusive. */
  from?: number;
  /** Epoch ms, inclusive. */
  to?: number;
}

export interface ResolvedItemFilter extends ResolvedScopeTimeFilter {
  kind?: ItemKind[];
  itemType?: string[];
  level?: Level[];
  minLevel?: Level;
  environment?: string[];
  release?: string[];
  eventId?: string;
  issueId?: string;
  traceId?: string;
  q?: string;
}

export interface ResolvedIssueFilter extends ResolvedScopeTimeFilter {
  kind?: ("error" | "message")[];
  level?: Level[];
  minLevel?: Level;
  q?: string;
}

export type ResolvedLiveFilter = Omit<ResolvedItemFilter, "from" | "to">;

export interface ResolvedPage {
  limit: number;
  /** Decoded cursor text. */
  cursor: string | null;
}

export interface IngestBatch {
  envelope: Envelope;
  items: { item: Item; blob: Uint8Array | null }[];
  issues: {
    id: string;
    project: string;
    session: string;
    kind: "error" | "message";
    fingerprint: string[];
    fingerprintHash: string;
    title: string;
    culprit: string | null;
    level: Level;
    platform: string | null;
    itemId: string;
    seenAt: string;
  }[];
}

export interface StorageAdapter {
  readonly type: "memory" | "sqlite";
  init(): Promise<{ driver: string | null; path: string | null }>;
  /** Atomic. */
  write(batch: IngestBatch): Promise<{ issues: { id: string; isNew: boolean; count: number }[] }>;
  listScopes(filter: ScopeFilter): Promise<ScopeSummary[]>;
  listIssues(filter: ResolvedIssueFilter, page: ResolvedPage): Promise<Page<Issue>>;
  /** Max 2 results. */
  findIssues(idPrefix: string, scope: ScopeFilter): Promise<Issue[]>;
  getIssue(id: string): Promise<Issue | null>;
  listItems(filter: ResolvedItemFilter, page: ResolvedPage): Promise<Page<ItemSummary>>;
  getItem(id: string): Promise<Item | null>;
  getItemByEventId(eventId: string): Promise<Item | null>;
  getBlob(itemId: string): Promise<Uint8Array | null>;
  getEnvelope(id: string): Promise<Envelope | null>;
  listFailedEnvelopes(
    filter: ResolvedScopeTimeFilter,
    page: ResolvedPage,
  ): Promise<Page<Omit<Envelope, "body">>>;
  deleteItems(filter: ResolvedItemFilter): Promise<number>;
  pruneIdleSessions(cutoff: Date): Promise<{ sessionsDeleted: number; itemsDeleted: number }>;
  pruneOldItems(kinds: ItemKind[], cutoff: Date): Promise<{ itemsDeleted: number }>;
  vacuum(): Promise<void>;
  close(): Promise<void>;
}
