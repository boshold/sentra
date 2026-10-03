import { computeGrouping } from "#src/grouping/fingerprint.js";
import type { IngestContext } from "#src/ingest/handler.js";
import type { LiveBus } from "#src/live/bus.js";
import { normalizeItems } from "#src/normalize/index.js";
import type { GroupingInput, NewItem, NormalizeContext } from "#src/normalize/types.js";
import type { ResolvedOptions } from "#src/options.js";
import type { ParsedEnvelope } from "#src/parse/envelope.js";
import { LOOPBACK_HOSTS } from "#src/sourcemaps/hosts.js";
import type { IngestBatch, StorageAdapter } from "#src/storage/types.js";
import type { Envelope, Level, SentraLogger } from "#src/types.js";
import { uuidv7 } from "#src/util/uuidv7.js";

/** Phase 4 hook between normalization and grouping; default returns its input. */
type MapFramesStep = (items: NewItem[]) => Promise<NewItem[]>;

interface PipelineDeps {
  storage: StorageAdapter;
  bus: LiveBus;
  options: ResolvedOptions;
  logger: SentraLogger;
  mapFrames?: MapFramesStep;
}

type IssueEntry = IngestBatch["issues"][number];

const NO_GROUPING: GroupingInput = { payloadFingerprint: null, messageTemplate: null };

const identity: MapFramesStep = async (items) => items;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function withoutBody(envelope: Envelope): Omit<Envelope, "body"> {
  return {
    id: envelope.id,
    scope: envelope.scope,
    receivedAt: envelope.receivedAt,
    header: envelope.header,
    size: envelope.size,
    contentEncoding: envelope.contentEncoding,
    itemCount: envelope.itemCount,
    parseError: envelope.parseError,
    parseWarnings: envelope.parseWarnings,
  };
}

function defaultLevel(kind: "error" | "message"): Level {
  return kind === "error" ? "error" : "info";
}

/** Sets issueId / fingerprint / culprit on error and message records; returns one issue entry each. */
function groupItems(items: NewItem[], receivedAt: string): IssueEntry[] {
  const issues: IssueEntry[] = [];
  for (const { item, grouping } of items) {
    if (item.kind !== "error" && item.kind !== "message") {
      continue;
    }
    const result = computeGrouping({
      scope: item.scope,
      kind: item.kind,
      data: item.data,
      grouping: grouping ?? NO_GROUPING,
    });
    item.issueId = result.issueId;
    item.data.fingerprint = result.fingerprint;
    item.data.culprit = result.culprit;
    issues.push({
      id: result.issueId,
      project: item.scope.project,
      session: item.scope.session,
      kind: item.kind,
      fingerprint: result.fingerprint,
      fingerprintHash: result.fingerprintHash,
      title: result.title,
      culprit: result.culprit,
      level: item.level ?? defaultLevel(item.kind),
      platform: item.platform,
      itemId: item.id,
      seenAt: receivedAt,
    });
  }
  return issues;
}

function responseId(parsed: ParsedEnvelope, items: NewItem[], envelopeId: string): string {
  const headerId = parsed.header.event_id;
  if (typeof headerId === "string" && headerId !== "") {
    return headerId;
  }
  return items.find(({ item }) => item.eventId !== null)?.item.eventId ?? envelopeId;
}

function createPipeline(deps: PipelineDeps): (ctx: IngestContext) => Promise<{ id: string }> {
  const { storage, bus, options, logger } = deps;
  const mapFrames = deps.mapFrames ?? identity;
  const allowedHosts = [...LOOPBACK_HOSTS, ...options.sourceMaps.allowedHosts];

  async function store(batch: IngestBatch): Promise<Awaited<ReturnType<StorageAdapter["write"]>>> {
    try {
      return await storage.write(batch);
    } catch (error) {
      bus.publish({
        type: "envelope.failed",
        envelope: withoutBody(batch.envelope),
        error: messageOf(error),
      });
      throw error;
    }
  }

  /** Frame mapping never fails ingest. */
  async function mapFramesSafely(items: NewItem[], envelopeId: string): Promise<NewItem[]> {
    try {
      return await mapFrames(items);
    } catch (error) {
      logger.warn(`frame mapping failed: ${messageOf(error)}`, { error, envelopeId });
      return items;
    }
  }

  async function ingestFailed(ctx: IngestContext, parseError: string): Promise<{ id: string }> {
    const envelope: Envelope = {
      id: uuidv7(),
      scope: ctx.scope,
      receivedAt: ctx.receivedAt.toISOString(),
      header: {},
      size: ctx.raw.byteLength,
      contentEncoding: ctx.contentEncoding,
      itemCount: 0,
      parseError,
      parseWarnings: [],
      body: ctx.raw,
    };
    await store({ envelope, items: [], issues: [] });
    bus.publish({ type: "envelope.failed", envelope: withoutBody(envelope), error: parseError });
    return { id: envelope.id };
  }

  async function ingestParsed(ctx: IngestContext, parsed: ParsedEnvelope): Promise<{ id: string }> {
    const receivedAt = ctx.receivedAt.toISOString();
    const envelopeId = uuidv7();
    const normalizeContext: NormalizeContext = {
      scope: ctx.scope,
      envelopeId,
      envelopeHeader: parsed.header,
      receivedAt,
      maxAttachmentBytes: options.limits.maxAttachmentBytes,
      allowedHosts,
      newId: () => uuidv7(),
    };
    const normalized = normalizeItems(parsed, normalizeContext);
    for (const { item, warnings } of normalized) {
      for (const warning of warnings) {
        logger.debug(warning, { itemId: item.id, envelopeId });
      }
    }
    const items = await mapFramesSafely(normalized, envelopeId);
    const issues = groupItems(items, receivedAt);
    const envelope: Envelope = {
      id: envelopeId,
      scope: ctx.scope,
      receivedAt,
      header: parsed.header,
      size: ctx.raw.byteLength,
      contentEncoding: ctx.contentEncoding,
      itemCount: items.length,
      parseError: null,
      parseWarnings: parsed.warnings,
      ...(options.rawEnvelopes ? { body: ctx.raw } : {}),
    };
    const result = await store({
      envelope,
      items: items.map(({ item, blob }) => ({ item, blob })),
      issues,
    });
    let issueIndex = 0;
    for (const { item } of items) {
      const isEvent = item.kind === "error" || item.kind === "message";
      const issue = isEvent ? (result.issues[issueIndex] ?? null) : null;
      if (isEvent) {
        issueIndex += 1;
      }
      bus.publish({ type: "item.created", item, issue });
    }
    return { id: responseId(parsed, items, envelopeId) };
  }

  return async function onEnvelope(ctx: IngestContext): Promise<{ id: string }> {
    return ctx.parsed === null ? ingestFailed(ctx, ctx.parseError) : ingestParsed(ctx, ctx.parsed);
  };
}

export { createPipeline };
export type { MapFramesStep, PipelineDeps };
