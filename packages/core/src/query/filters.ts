import { array, number, prettifyError, strictObject, string, union, enum as zodEnum } from "zod";
import type { infer as Infer, ZodType } from "zod";

import { SentraValidationError } from "#src/errors.js";
import { decodeCursor } from "#src/query/cursor.js";
import { parseDuration } from "#src/query/duration.js";
import type {
  ResolvedIssueFilter,
  ResolvedItemFilter,
  ResolvedLiveFilter,
  ResolvedPage,
  ResolvedScopeFilter,
  ResolvedScopeTimeFilter,
} from "#src/storage/types.js";
import { ITEM_KINDS, LEVELS } from "#src/types.js";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

function oneOrMany<T extends ZodType>(schema: T) {
  return union([schema, array(schema)]);
}

const levelSchema = zodEnum(LEVELS);
const itemKindSchema = zodEnum(ITEM_KINDS);
const issueKindSchema = zodEnum(["error", "message"]);
const stringsSchema = oneOrMany(string());

const durationSchema = string().refine((value) => parseDuration(value) !== null, {
  message: "invalid duration (expected e.g. 500ms, 30s, 60m, 2h, 7d, 1w)",
});
const dateSchema = union([
  number().finite(),
  string().refine((value) => Number.isFinite(Date.parse(value)), { message: "invalid date" }),
]);

const scopeShape = {
  project: stringsSchema.optional(),
  session: stringsSchema.optional(),
  service: stringsSchema.optional(),
};

const timeShape = {
  since: durationSchema.optional(),
  from: dateSchema.optional(),
  to: dateSchema.optional(),
};

const itemShape = {
  kind: oneOrMany(itemKindSchema).optional(),
  itemType: stringsSchema.optional(),
  level: oneOrMany(levelSchema).optional(),
  minLevel: levelSchema.optional(),
  environment: stringsSchema.optional(),
  release: stringsSchema.optional(),
  eventId: string().optional(),
  issueId: string().optional(),
  traceId: string().optional(),
  q: string().optional(),
};

const issueShape = {
  kind: oneOrMany(issueKindSchema).optional(),
  level: oneOrMany(levelSchema).optional(),
  minLevel: levelSchema.optional(),
  q: string().optional(),
};

function sinceXorFrom<T extends { since?: string; from?: string | number }>(schema: ZodType<T>) {
  return schema.refine((value) => value.since === undefined || value.from === undefined, {
    message: "`since` and `from` are mutually exclusive",
    path: ["since"],
  });
}

const scopeFilterSchema = strictObject(scopeShape);
const timeFilterSchema = sinceXorFrom(strictObject(timeShape));
const scopeTimeFilterSchema = sinceXorFrom(strictObject({ ...scopeShape, ...timeShape }));
const itemFilterSchema = sinceXorFrom(strictObject({ ...scopeShape, ...timeShape, ...itemShape }));
const issueFilterSchema = sinceXorFrom(
  strictObject({ ...scopeShape, ...timeShape, ...issueShape }),
);
const liveFilterSchema = strictObject({ ...scopeShape, ...itemShape });
const pageInputSchema = strictObject({
  limit: number().int().optional(),
  cursor: string().optional(),
});

function parseOrThrow<T>(schema: ZodType<T>, input: unknown, what: string): T {
  const result = schema.safeParse(input ?? {});
  if (!result.success) {
    throw new SentraValidationError(
      "invalid_filter",
      `invalid ${what}: ${prettifyError(result.error)}`,
      {
        details: result.error.issues,
      },
    );
  }
  return result.data;
}

function toList<T>(value: T | T[] | undefined): T[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  const list = Array.isArray(value) ? value : [value];
  return list.length === 0 ? undefined : list;
}

function toMs(value: string | number | undefined): number | undefined {
  return typeof value === "string" ? Date.parse(value) : value;
}

function nonEmpty(value: string | undefined): string | undefined {
  return value === "" ? undefined : value;
}

function resolveTime(
  input: { since?: string; from?: string | number; to?: string | number },
  now: number,
): { from?: number; to?: number } {
  const since = input.since === undefined ? null : parseDuration(input.since);
  return { from: since === null ? toMs(input.from) : now - since, to: toMs(input.to) };
}

function resolveScope(input: Infer<typeof scopeFilterSchema>): ResolvedScopeFilter {
  return {
    project: toList(input.project),
    session: toList(input.session),
    service: toList(input.service),
  };
}

function resolveItemFields(input: Infer<typeof liveFilterSchema>): ResolvedLiveFilter {
  return {
    ...resolveScope(input),
    kind: toList(input.kind),
    itemType: toList(input.itemType),
    level: toList(input.level),
    minLevel: input.minLevel,
    environment: toList(input.environment),
    release: toList(input.release),
    eventId: nonEmpty(input.eventId?.replaceAll("-", "").toLowerCase()),
    issueId: nonEmpty(input.issueId),
    traceId: nonEmpty(input.traceId),
    q: nonEmpty(input.q),
  };
}

function resolveScopeFilter(input: unknown): ResolvedScopeFilter {
  return resolveScope(parseOrThrow(scopeFilterSchema, input, "scope filter"));
}

function resolveScopeTimeFilter(input: unknown, now: number = Date.now()): ResolvedScopeTimeFilter {
  const parsed = parseOrThrow(scopeTimeFilterSchema, input, "filter");
  return { ...resolveScope(parsed), ...resolveTime(parsed, now) };
}

function resolveItemFilter(input: unknown, now: number = Date.now()): ResolvedItemFilter {
  const parsed = parseOrThrow(itemFilterSchema, input, "item filter");
  return { ...resolveItemFields(parsed), ...resolveTime(parsed, now) };
}

function resolveLiveFilter(input: unknown): ResolvedLiveFilter {
  return resolveItemFields(parseOrThrow(liveFilterSchema, input, "live filter"));
}

function resolveIssueFilter(input: unknown, now: number = Date.now()): ResolvedIssueFilter {
  const parsed = parseOrThrow(issueFilterSchema, input, "issue filter");
  return {
    ...resolveScope(parsed),
    kind: toList(parsed.kind),
    level: toList(parsed.level),
    minLevel: parsed.minLevel,
    q: nonEmpty(parsed.q),
    ...resolveTime(parsed, now),
  };
}

function resolvePage(input: unknown): ResolvedPage {
  const parsed = parseOrThrow(pageInputSchema, input, "page");
  const limit = Math.min(MAX_LIMIT, Math.max(1, parsed.limit ?? DEFAULT_LIMIT));
  return { limit, cursor: parsed.cursor === undefined ? null : decodeCursor(parsed.cursor) };
}

export {
  issueFilterSchema,
  itemFilterSchema,
  itemKindSchema,
  levelSchema,
  liveFilterSchema,
  pageInputSchema,
  resolveIssueFilter,
  resolveItemFilter,
  resolveLiveFilter,
  resolvePage,
  resolveScopeFilter,
  resolveScopeTimeFilter,
  scopeFilterSchema,
  scopeTimeFilterSchema,
  timeFilterSchema,
};
