import type { IncomingMessage, ServerResponse } from "node:http";

import { SentraValidationError } from "@bosdev/sentra-core";
import type { Item, Sentra, SentraLogger } from "@bosdev/sentra-core";

import { routePathname, routeSearchParams, sendError, sendJson } from "#src/router.js";
import type { NodeListener } from "#src/router.js";

type FilterValue = string | string[] | number;

interface ParsedParams {
  filter: Record<string, FilterValue>;
  page: { limit?: number; cursor?: string };
}

/** Error with a fixed HTTP status and error code. */
class ApiError extends Error {
  public readonly status: number;
  public readonly code: string;

  public constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

const API_PREFIX = "/api/sentra";

const ARRAY_KEYS: ReadonlySet<string> = new Set([
  "project",
  "session",
  "service",
  "kind",
  "itemType",
  "level",
  "environment",
  "release",
]);
const EPOCH_KEYS: ReadonlySet<string> = new Set(["from", "to"]);
const DIGITS = /^\d+$/;

const SCOPE_KEYS = ["project", "session", "service"] as const;
const TIME_KEYS = ["since", "from", "to"] as const;
const PAGE_KEYS = ["limit", "cursor"] as const;
const ITEM_KEYS = [
  ...SCOPE_KEYS,
  ...TIME_KEYS,
  "kind",
  "itemType",
  "level",
  "minLevel",
  "environment",
  "release",
  "eventId",
  "issueId",
  "traceId",
  "q",
] as const;
const ISSUE_KEYS = [...SCOPE_KEYS, ...TIME_KEYS, "kind", "level", "minLevel", "q"] as const;

function invalidFilter(message: string, details?: unknown): SentraValidationError {
  return new SentraValidationError(
    "invalid_filter",
    message,
    details === undefined ? undefined : { details },
  );
}

function splitList(values: string[]): string[] {
  return values
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter((value) => value !== "");
}

/** Core ignores these (`nonEmpty`, dash-stripped `eventId`); dropping them keeps `filter_required` honest. */
function isEmptyScalar(key: string, value: string): boolean {
  const trimmed = value.trim();
  return trimmed === "" || (key === "eventId" && trimmed.replaceAll("-", "") === "");
}

/** Query string → core filter + page input; unknown or repeated scalar params → `invalid_filter`. */
function parseFilterParams(params: URLSearchParams, allowed: readonly string[]): ParsedParams {
  const keys = [...new Set(params.keys())];
  const unknown = keys.filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw invalidFilter(`unknown query parameter ${unknown.join(", ")}`, { unknown });
  }
  const filter: Record<string, FilterValue> = {};
  const page: ParsedParams["page"] = {};
  for (const key of keys) {
    const values = params.getAll(key);
    if (ARRAY_KEYS.has(key)) {
      const list = splitList(values);
      if (list.length > 0) {
        filter[key] = list;
      }
      continue;
    }
    const [value] = values;
    if (values.length > 1 || value === undefined) {
      throw invalidFilter(`query parameter ${key} must be given once`, { repeated: [key] });
    }
    if (key !== "limit" && isEmptyScalar(key, value)) {
      continue;
    }
    if (key === "limit") {
      if (!DIGITS.test(value)) {
        throw invalidFilter("limit must be a non-negative integer", { limit: value });
      }
      page.limit = Number(value);
    } else if (key === "cursor") {
      page.cursor = value;
    } else {
      filter[key] = EPOCH_KEYS.has(key) && DIGITS.test(value) ? Number(value) : value;
    }
  }
  return { filter, page };
}

const SAFE_CONTENT_TYPE = /^[\w.+-]+\/[\w.+-]+(?:;[ -~]*)?$/;

function contentDispositionName(filename: string): string {
  const safe = filename.replaceAll(/[^ -~]|["\\]/g, "_");
  return safe === "" ? "download" : safe;
}

function sendBytes(
  res: ServerResponse,
  data: Uint8Array,
  headers: { contentType: string; filename: string },
): void {
  res.writeHead(200, {
    "content-type": headers.contentType,
    "content-length": String(data.byteLength),
    "x-content-type-options": "nosniff",
    "content-disposition": `attachment; filename="${contentDispositionName(headers.filename)}"`,
    // Bytes come from arbitrary SDK payloads; never let them run as a page on this origin.
    "content-security-policy": "sandbox",
  });
  res.end(data);
}

type RouteHandler = (ctx: {
  params: URLSearchParams;
  ids: string[];
  res: ServerResponse;
}) => Promise<void>;

interface Route {
  pattern: readonly string[];
  methods: Partial<Record<"GET" | "DELETE", RouteHandler>>;
}

function matchRoute(
  routes: readonly Route[],
  segments: string[],
): { route: Route; ids: string[] } | null {
  for (const route of routes) {
    if (route.pattern.length !== segments.length) {
      continue;
    }
    const ids: string[] = [];
    const matches = route.pattern.every((part, index) => {
      const segment = segments[index] ?? "";
      if (part === ":id") {
        ids.push(segment);
        return segment !== "";
      }
      return part === segment;
    });
    if (matches) {
      return { route, ids };
    }
  }
  return null;
}

/** Segments after `/api/sentra`, decoded; one trailing slash allowed; `null` if not decodable. */
function pathSegments(pathname: string): string[] | null {
  const rest = pathname.slice(API_PREFIX.length).replace(/^\//, "").replace(/\/$/, "");
  if (rest === "") {
    return [];
  }
  try {
    return rest.split("/").map((segment) => decodeURIComponent(segment));
  } catch {
    return null;
  }
}

function notFound(message: string): ApiError {
  return new ApiError(404, "not_found", message);
}

function idOf(ids: string[]): string {
  const [id] = ids;
  if (id === undefined) {
    throw notFound("missing id");
  }
  return id;
}

function createApiHandler(deps: { sentra: Sentra; logger: SentraLogger }): NodeListener {
  const { sentra, logger } = deps;
  const { query } = sentra;

  async function findItem(id: string): Promise<Item> {
    const item = (await query.getItem(id)) ?? (await query.getItemByEventId(id));
    if (item === null) {
      throw notFound(`item ${id} not found`);
    }
    return item;
  }

  const routes: Route[] = [
    {
      pattern: ["health"],
      methods: {
        GET: async ({ res }) => {
          const info = sentra.info();
          sendJson(res, 200, { ok: true, version: info.version, storage: info.storage });
        },
      },
    },
    {
      pattern: ["scopes"],
      methods: {
        GET: async ({ params, res }) => {
          const { filter } = parseFilterParams(params, SCOPE_KEYS);
          sendJson(res, 200, { items: await query.listScopes(filter) });
        },
      },
    },
    {
      pattern: ["issues"],
      methods: {
        GET: async ({ params, res }) => {
          const { filter, page } = parseFilterParams(params, [...ISSUE_KEYS, ...PAGE_KEYS]);
          sendJson(res, 200, await query.listIssues(filter, page));
        },
      },
    },
    {
      pattern: ["issues", ":id"],
      methods: {
        GET: async ({ ids, res }) => {
          const id = idOf(ids);
          const detail = await query.getIssue(id);
          if (detail === null) {
            throw notFound(`issue ${id} not found`);
          }
          sendJson(res, 200, detail);
        },
      },
    },
    {
      pattern: ["items"],
      methods: {
        GET: async ({ params, res }) => {
          const { filter, page } = parseFilterParams(params, [...ITEM_KEYS, ...PAGE_KEYS]);
          sendJson(res, 200, await query.listItems(filter, page));
        },
        DELETE: async ({ params, res }) => {
          const { filter } = parseFilterParams(params, ITEM_KEYS);
          if (Object.keys(filter).length === 0) {
            throw new ApiError(
              400,
              "filter_required",
              "DELETE /api/sentra/items needs at least one filter parameter",
            );
          }
          sendJson(res, 200, await sentra.clear(filter));
        },
      },
    },
    {
      pattern: ["items", ":id"],
      methods: {
        GET: async ({ ids, res }) => {
          sendJson(res, 200, await findItem(idOf(ids)));
        },
      },
    },
    {
      pattern: ["items", ":id", "envelope"],
      methods: {
        GET: async ({ ids, res }) => {
          const item = await findItem(idOf(ids));
          const raw = await query.getRawEnvelope(item.envelopeId);
          if (raw === null) {
            throw new ApiError(
              404,
              "raw_not_stored",
              `raw envelope ${item.envelopeId} is not stored`,
            );
          }
          sendBytes(res, raw, {
            contentType: "application/x-sentry-envelope",
            filename: `${item.envelopeId}.envelope`,
          });
        },
      },
    },
    {
      pattern: ["attachments", ":id"],
      methods: {
        GET: async ({ ids, res }) => {
          const id = idOf(ids);
          const item = await query.getItem(id);
          const isBinary =
            item !== null &&
            (item.kind === "attachment" ||
              (item.kind === "other" && item.data.payloadEncoding === "binary"));
          if (item === null || !isBinary) {
            throw notFound(`attachment ${id} not found`);
          }
          const blob = await query.getBlob(id);
          if (blob === null) {
            throw new ApiError(404, "blob_not_stored", `attachment ${id} was not stored`);
          }
          const contentType =
            item.kind === "attachment" &&
            blob.contentType !== null &&
            SAFE_CONTENT_TYPE.test(blob.contentType)
              ? blob.contentType
              : "application/octet-stream";
          const filename = item.kind === "attachment" ? blob.filename : `${item.itemType}.bin`;
          sendBytes(res, blob.data, { contentType, filename });
        },
      },
    },
    {
      pattern: ["envelopes", "failed"],
      methods: {
        GET: async ({ params, res }) => {
          const { filter, page } = parseFilterParams(params, [
            ...SCOPE_KEYS,
            ...TIME_KEYS,
            ...PAGE_KEYS,
          ]);
          sendJson(res, 200, await query.listFailedEnvelopes(filter, page));
        },
      },
    },
  ];

  function fail(res: ServerResponse, error: unknown): void {
    if (error instanceof ApiError) {
      sendError(res, error.status, error.code, error.message);
      return;
    }
    if (error instanceof SentraValidationError) {
      sendError(res, 400, error.code, error.message, error.details);
      return;
    }
    logger.error(
      `query API request failed: ${error instanceof Error ? error.message : String(error)}`,
      { error },
    );
    if (res.headersSent) {
      res.destroy();
      return;
    }
    sendError(res, 500, "internal_error", "Internal error");
  }

  return async function apiHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const segments = pathSegments(routePathname(req));
      const match = segments === null ? null : matchRoute(routes, segments);
      if (match === null) {
        throw notFound(`no route for ${routePathname(req)}`);
      }
      const method = req.method ?? "GET";
      const handler =
        method === "GET" || method === "DELETE" ? match.route.methods[method] : undefined;
      if (handler === undefined) {
        res.setHeader("allow", Object.keys(match.route.methods).join(", "));
        throw new ApiError(405, "method_not_allowed", `${method} is not allowed here`);
      }
      await handler({ params: routeSearchParams(req), ids: match.ids, res });
    } catch (error) {
      fail(res, error);
    }
  };
}

export { createApiHandler, parseFilterParams };
export type { ParsedParams };
