import { number, object, prettifyError, string } from "zod";
import type { ZodObject, output } from "zod";

import { isDuration } from "#src/query/duration.js";
import { issueShape, itemShape, scopeShape, timeShape } from "#src/query/filters.js";
import { renderIssueDetail, renderIssueLine } from "#src/render/issue.js";
import { renderItemDetail, renderItemLine, renderScopeTable } from "#src/render/item.js";
import type { SentraQuery } from "#src/sentra.js";
import type {
  Duration,
  Issue,
  Item,
  ScopeFilter,
  SentraToolDefinition,
  SpanItem,
} from "#src/types.js";

interface McpToolDeps {
  query: SentraQuery;
  /** `storage.findIssues`, max 2 rows. */
  findIssues: (idPrefix: string, scope: ScopeFilter) => Promise<Issue[]>;
  now?: () => Date;
}

type ToolResult = Awaited<ReturnType<SentraToolDefinition["handler"]>>;

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
/** Page size when scanning a trace; the storage maximum. */
const TRACE_PAGE_SIZE = 500;
const TRACE_SPANS_SHOWN = 20;
const FULL_ISSUE_ID_LENGTH = 16;
const TO_NOTE = "A date-only value (2026-10-03) means midnight at the start of that day.";

function textResult(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

function errorResult(text: string): ToolResult {
  return { isError: true, content: [{ type: "text", text }] };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Validates input with `schema`, runs `run`, and turns every failure into an error result. */
function tool<T extends ZodObject>(
  definition: Omit<SentraToolDefinition, "inputSchema" | "annotations" | "handler"> & {
    inputSchema: T;
    run: (input: output<T>) => Promise<ToolResult>;
  },
): SentraToolDefinition {
  const { run, ...rest } = definition;
  return {
    ...rest,
    annotations: { readOnlyHint: true },
    async handler(input) {
      const parsed = definition.inputSchema.safeParse(input ?? {});
      if (!parsed.success) {
        return errorResult(prettifyError(parsed.error));
      }
      try {
        return await run(parsed.data);
      } catch (error) {
        return errorResult(messageOf(error));
      }
    },
  };
}

function limitSchema() {
  return number()
    .int()
    .min(1)
    .max(MAX_LIMIT)
    .optional()
    .describe(`Max results, 1-${MAX_LIMIT}. Default ${DEFAULT_LIMIT}.`);
}

const cursorSchema = string().optional().describe("`nextCursor` from the previous page.");

function scopeFields(what: string) {
  return {
    project: scopeShape.project.describe(`Project name(s) ${what}.`),
    session: scopeShape.session.describe(`Session id(s) ${what}.`),
    service: scopeShape.service.describe(`Service name(s) ${what}.`),
  };
}

function withPage(lines: string[], nextCursor: string | null, empty: string): ToolResult {
  if (lines.length === 0) {
    return textResult(empty);
  }
  return textResult(
    [...lines, ...(nextCursor === null ? [] : ["", `nextCursor: ${nextCursor}`])].join("\n"),
  );
}

/** Applies `fallback` when neither `since` nor `from` is given. */
function withDefaultSince<T extends { since?: string; from?: string | number }>(
  input: T,
  fallback: Duration,
): Omit<T, "since"> & { since?: Duration } {
  const { since, ...rest } = input;
  const resolved = since ?? (input.from === undefined ? fallback : undefined);
  return resolved !== undefined && isDuration(resolved) ? { ...rest, since: resolved } : rest;
}

function createMcpTools(deps: McpToolDeps): SentraToolDefinition[] {
  const { query, findIssues } = deps;
  const now = deps.now ?? (() => new Date());

  async function resolveIssueId(
    id: string,
    scope: { project?: string; session?: string },
  ): Promise<string | ToolResult> {
    if (id.length === FULL_ISSUE_ID_LENGTH) {
      return id;
    }
    const rows = await findIssues(id, scope);
    const [first, second] = rows;
    if (first === undefined) {
      return errorResult(`Issue not found: ${id}`);
    }
    if (second !== undefined) {
      return errorResult(`Ambiguous issue id ${id}; pass project and session or the full id`);
    }
    return first.id;
  }

  /** Pages through the whole trace, keeping only the longest spans and the true total. */
  async function traceSpansOf(item: Item): Promise<{ spans: SpanItem[]; total: number }> {
    if (item.kind !== "span" || item.traceId === null) {
      return { spans: [], total: 0 };
    }
    let longest: SpanItem[] = [];
    let total = 0;
    let cursor: string | undefined = undefined;
    do {
      const page = await query.listItems(
        { traceId: item.traceId, kind: "span" },
        { limit: TRACE_PAGE_SIZE, cursor },
      );
      const items = await Promise.all(page.items.map(async (summary) => query.getItem(summary.id)));
      const spans = items.filter((span): span is SpanItem => span?.kind === "span");
      total += spans.length;
      longest = [...longest, ...spans]
        .toSorted((a, b) => b.data.durationMs - a.data.durationMs)
        .slice(0, TRACE_SPANS_SHOWN);
      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined);
    return { spans: longest, total };
  }

  const listScopes = object({
    project: scopeShape.project.describe("Only scopes of these project(s)."),
    session: scopeShape.session.describe("Only scopes of these session(s)."),
  });

  const listIssues = object({
    ...scopeFields("to filter by"),
    kind: issueShape.kind.describe('"error" or "message".'),
    minLevel: issueShape.minLevel.describe(
      "Minimum level: trace, debug, info, warning, error, fatal.",
    ),
    since: timeShape.since.describe(
      'Issues seen within this duration (e.g. "30s", "60m", "2h", "7d"). Default "24h".',
    ),
    q: issueShape.q.describe("Case-insensitive substring of the title."),
    limit: limitSchema(),
    cursor: cursorSchema,
  });

  const getIssue = object({
    id: string()
      .regex(/^[0-9a-f]{8,16}$/i, "expected 8-16 hex characters")
      .describe("Full 16-char issue id or a shortId prefix of at least 8 chars."),
    project: string().optional().describe("Project, to disambiguate a short id."),
    session: string().optional().describe("Session, to disambiguate a short id."),
  });

  const listItems = object({
    ...scopeFields("to filter by"),
    kind: itemShape.kind.describe("error, message, transaction, span, log, attachment, other."),
    itemType: itemShape.itemType.describe('Envelope item type(s), e.g. "event", "session".'),
    level: itemShape.level.describe("Exact level(s)."),
    minLevel: itemShape.minLevel.describe(
      "Minimum level: trace, debug, info, warning, error, fatal.",
    ),
    environment: itemShape.environment.describe("Environment(s)."),
    release: itemShape.release.describe("Release(s)."),
    eventId: itemShape.eventId.describe("Sentry event id (32 hex)."),
    issueId: itemShape.issueId.describe("Issue id."),
    traceId: itemShape.traceId.describe("Trace id."),
    q: itemShape.q.describe("Case-insensitive substring of the title."),
    since: timeShape.since.describe(
      'Records within this duration (e.g. "30s", "60m", "2h"). Default "60m" unless `from` is set. Not combinable with `from`.',
    ),
    from: timeShape.from.describe(
      "Start (ISO 8601 or epoch ms), inclusive. Not combinable with `since`.",
    ),
    to: timeShape.to.describe(`End (ISO 8601 or epoch ms), inclusive. ${TO_NOTE}`),
    limit: limitSchema(),
    cursor: cursorSchema,
  });

  const getItem = object({
    id: string().min(1).describe("Item id or Sentry event id."),
  });

  return [
    tool({
      name: "sentra_list_scopes",
      title: "List scopes",
      description:
        'List known project/session/service scopes with last activity, record and issue counts. Use the exact values in other tools.\nExample: sentra_list_scopes({ project: "my-app" })',
      inputSchema: listScopes,
      run: async (input) => textResult(renderScopeTable(await query.listScopes(input))),
    }),
    tool({
      name: "sentra_list_issues",
      title: "List issues",
      description:
        'List grouped errors/messages, most recently seen first: shortId, level, count, last seen, services, title, culprit. Defaults: since "24h", limit 20.\nExample: sentra_list_issues({ project: "my-app", since: "60m" })',
      inputSchema: listIssues,
      run: async ({ limit, cursor, ...filter }) => {
        const page = await query.listIssues(withDefaultSince(filter, "24h"), {
          limit: limit ?? DEFAULT_LIMIT,
          cursor,
        });
        const at = now();
        return withPage(
          page.items.map((issue) => renderIssueLine(issue, at)),
          page.nextCursor,
          "No issues.",
        );
      },
    }),
    tool({
      name: "sentra_get_issue",
      title: "Get issue",
      description:
        'Show one issue (title, level, count, first/last seen, services) with its latest event rendered like sentra_get_item. Accepts the full id or a shortId prefix (>= 8 chars).\nExample: sentra_get_issue({ id: "7c2f91ab" })',
      inputSchema: getIssue,
      run: async ({ id, project, session }) => {
        const scope = {
          ...(project === undefined ? {} : { project }),
          ...(session === undefined ? {} : { session }),
        };
        const resolved = await resolveIssueId(id.toLowerCase(), scope);
        if (typeof resolved !== "string") {
          return resolved;
        }
        const detail = await query.getIssue(resolved);
        return detail === null
          ? errorResult(`Issue not found: ${id}`)
          : textResult(renderIssueDetail(detail, now()));
      },
    }),
    tool({
      name: "sentra_list_items",
      title: "List records",
      description:
        'List stored records (errors, messages, transactions, spans, logs, attachments, other), newest first: time, kind, level, scope, title, id. Defaults: since "60m" (unless from is set), limit 20.\nExample: sentra_list_items({ kind: "log", service: "api", since: "10m" })',
      inputSchema: listItems,
      run: async ({ limit, cursor, ...filter }) => {
        const page = await query.listItems(withDefaultSince(filter, "60m"), {
          limit: limit ?? DEFAULT_LIMIT,
          cursor,
        });
        return withPage(page.items.map(renderItemLine), page.nextCursor, "No items.");
      },
    }),
    tool({
      name: "sentra_get_item",
      title: "Get record",
      description:
        'Show one record in full. Errors: exceptions with source-mapped frames and context, request, tags, last 20 breadcrumbs, source-map status. Transactions: top 20 spans. Spans: attributes and the 20 longest spans of the trace. Logs: body and attributes.\nExample: sentra_get_item({ id: "80696dce07b1410b8867fcbc1083a832" })',
      inputSchema: getItem,
      run: async ({ id }) => {
        const item = (await query.getItem(id)) ?? (await query.getItemByEventId(id));
        if (item === null) {
          return errorResult(`Item not found: ${id}`);
        }
        const trace = await traceSpansOf(item);
        return textResult(
          renderItemDetail(item, { traceSpans: trace.spans, traceSpanTotal: trace.total }),
        );
      },
    }),
  ];
}

export { createMcpTools };
export type { McpToolDeps };
