import type { NormalizeContext } from "#src/normalize/types.js";
import type { ItemSummary } from "#src/types.js";

/** Max length of `ItemSummary.title`. */
const ITEM_TITLE_MAX = 500;

type SummaryFields = Pick<ItemSummary, "itemType" | "timestamp" | "title"> &
  Partial<Omit<ItemSummary, "id" | "envelopeId" | "scope" | "receivedAt" | "kind">>;

/** Common record fields; everything not passed is `null`. */
function baseSummary(ctx: NormalizeContext, fields: SummaryFields): Omit<ItemSummary, "kind"> {
  return {
    id: ctx.newId(),
    envelopeId: ctx.envelopeId,
    scope: ctx.scope,
    receivedAt: ctx.receivedAt,
    eventId: null,
    issueId: null,
    traceId: null,
    level: null,
    environment: null,
    release: null,
    platform: null,
    ...fields,
  };
}

function stringAttribute(
  attributes: Record<string, string | number | boolean>,
  key: string,
): string | null {
  const value = attributes[key];
  return typeof value === "string" ? value : null;
}

export { baseSummary, ITEM_TITLE_MAX, stringAttribute };
