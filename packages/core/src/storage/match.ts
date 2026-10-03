import { levelRank } from "#src/normalize/level.js";
import type {
  IngestBatch,
  ResolvedIssueFilter,
  ResolvedItemFilter,
  ResolvedScopeTimeFilter,
} from "#src/storage/types.js";
import type {
  Envelope,
  Issue,
  ItemSummary,
  Level,
  OneOrMany,
  Scope,
  ScopeFilter,
} from "#src/types.js";

function matchesValue(expected: OneOrMany<string> | undefined, actual: string): boolean {
  if (expected === undefined) {
    return true;
  }
  if (typeof expected === "string") {
    return expected === actual;
  }
  return expected.length === 0 || expected.includes(actual);
}

function inList<T>(list: readonly T[] | undefined, value: T | null): boolean {
  return list === undefined || list.length === 0 || (value !== null && list.includes(value));
}

function equalsIfSet(expected: string | undefined, actual: string | null): boolean {
  return expected === undefined || expected === actual;
}

function matchesLevel(filter: { level?: Level[]; minLevel?: Level }, level: Level | null): boolean {
  if (
    filter.minLevel !== undefined &&
    (level === null || levelRank(level) < levelRank(filter.minLevel))
  ) {
    return false;
  }
  return inList(filter.level, level);
}

function matchesText(q: string | undefined, title: string): boolean {
  return q === undefined || title.toLowerCase().includes(q.toLowerCase());
}

function matchesTime(filter: { from?: number; to?: number }, iso: string): boolean {
  if (filter.from === undefined && filter.to === undefined) {
    return true;
  }
  const ms = Date.parse(iso);
  return (
    (filter.from === undefined || ms >= filter.from) && (filter.to === undefined || ms <= filter.to)
  );
}

function matchesScope(scope: Scope, filter: ScopeFilter): boolean {
  return (
    matchesValue(filter.project, scope.project) &&
    matchesValue(filter.session, scope.session) &&
    matchesValue(filter.service, scope.service)
  );
}

function matchesItemFilter(item: ItemSummary, filter: ResolvedItemFilter): boolean {
  return (
    matchesScope(item.scope, filter) &&
    inList(filter.kind, item.kind) &&
    inList(filter.itemType, item.itemType) &&
    matchesLevel(filter, item.level) &&
    inList(filter.environment, item.environment) &&
    inList(filter.release, item.release) &&
    equalsIfSet(filter.eventId, item.eventId) &&
    equalsIfSet(filter.issueId, item.issueId) &&
    equalsIfSet(filter.traceId, item.traceId) &&
    matchesText(filter.q, item.title) &&
    matchesTime(filter, item.timestamp)
  );
}

function matchesIssueFilter(issue: Issue, filter: ResolvedIssueFilter): boolean {
  return (
    matchesValue(filter.project, issue.project) &&
    matchesValue(filter.session, issue.session) &&
    (filter.service === undefined ||
      filter.service.length === 0 ||
      issue.services.some((service) => filter.service?.includes(service))) &&
    inList(filter.kind, issue.kind) &&
    matchesLevel(filter, issue.level) &&
    matchesText(filter.q, issue.title) &&
    matchesTime(filter, issue.lastSeenAt)
  );
}

function matchesEnvelopeFilter(
  envelope: Omit<Envelope, "body">,
  filter: ResolvedScopeTimeFilter,
): boolean {
  return matchesScope(envelope.scope, filter) && matchesTime(filter, envelope.receivedAt);
}

/** A successful envelope without items references nothing, so it is not stored. */
function isKeptEnvelope(batch: IngestBatch): boolean {
  return batch.envelope.parseError !== null || batch.items.length > 0;
}

export {
  isKeptEnvelope,
  matchesEnvelopeFilter,
  matchesIssueFilter,
  matchesItemFilter,
  matchesScope,
};
