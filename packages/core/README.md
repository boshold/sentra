# @bosdev/sentra-core

Embeddable receiver for Sentry SDK envelopes. It exports a fetch-style ingest handler, parses envelopes into typed records, groups errors into issues, maps stack frames through source maps, stores everything in memory or SQLite, and offers a query API, live subscriptions and MCP tool definitions. The host process owns the HTTP server; the core never listens on a port.

Apps keep the official Sentry SDKs and only get a Sentra DSN:

```text
http://sentra@<host>:<port>/[project/][session/][service/]1
```

A missing segment becomes `default`, and `_` also means `default` (to skip a middle segment). Segments match `[A-Za-z0-9._-]{1,64}` and must not be `.` or `..`. The public key (`sentra`) and the project id (`1`) are ignored, but the SDK still checks them: the key must match `\w+` and the id must be digits.

For a ready-made server with terminal output, HTTP API and MCP endpoint, use [`@bosdev/sentra-cli`](https://github.com/boshold/sentra/tree/main/packages/cli).

## Install

```bash
pnpm add @bosdev/sentra-core
# or
npm install @bosdev/sentra-core
```

`better-sqlite3`, the preferred SQLite driver, is an optional dependency and is installed with the package. If it cannot be installed or loaded on a platform, Sentra uses `node:sqlite`.

Requires Node `>=22.15` or Bun `>=1.4`.

## Usage

Minimal host: one HTTP server, one DSN.

```ts
import { createServer } from "node:http";
import { createSentra, sqliteStorage, toNodeListener } from "@bosdev/sentra-core";

const sentra = await createSentra({
  storage: sqliteStorage({ path: "/var/lib/my-host/sentra.db" }),
  publicUrl: "http://127.0.0.1:8969",
});

createServer(toNodeListener(sentra.handle)).listen(8969, "127.0.0.1");

const dsn = sentra.getDsn({ project: "my-app", session: "3f9a1c", service: "web" });
// http://sentra@127.0.0.1:8969/my-app/3f9a1c/web/1 -> pass as SENTRY_DSN to the service
```

Then read what arrives:

```ts
sentra.addSourceRoot("/path/to/my-app");

const unsubscribe = sentra.subscribe({ project: "my-app", session: "3f9a1c" }, (event) => {
  if (event.type === "item.created") console.log(event.item.kind, event.item.title);
});

const issues = await sentra.query.listIssues({
  project: "my-app",
  session: "3f9a1c",
  since: "60m",
});
```

On shutdown call `unsubscribe()` and `await sentra.close()`. To expose the data to AI agents, register `sentra.mcpTools()` on your MCP server (see [MCP tools](#mcp-tools)).

### HTTP handler

A host with its own router can use `isIngestPath(pathname)` to decide which requests go to `sentra.handle`. `toNodeListener` answers `400 invalid_scope` when the raw request path has a `.` or `..` segment (also `%2e`), because URL parsing would move the event to another scope; a host that builds the `Request` itself should do the same.

`sentra.handle(request: Request): Promise<Response>` is bound and never rejects. Errors use the body `{ error: { code, message } }` and repeat the message in `X-Sentry-Error`. It never answers `429`, because SDK v11 stops sending for 60 s after one.

| Status | Code                    | When                                                          |
| ------ | ----------------------- | ------------------------------------------------------------- |
| `200`  |                         | `POST` stored; body `{ id }`                                  |
| `204`  |                         | `OPTIONS` preflight, with CORS headers                        |
| `400`  | `empty_body`            | Empty body, also after decompression                          |
| `400`  | `invalid_envelope`      | Envelope header cannot be parsed (the raw body is still kept) |
| `400`  | `invalid_scope`         | Bad scope segment                                             |
| `404`  | `not_found`             | Path is not an ingest route                                   |
| `405`  | `method_not_allowed`    | Method other than `POST` or `OPTIONS`                         |
| `413`  | `payload_too_large`     | Body over `maxEnvelopeBytes`                                  |
| `415`  | `unsupported_encoding`  | Unknown or corrupt `Content-Encoding`                         |
| `499`  | `client_closed_request` | Client aborted the request                                    |
| `500`  | `storage_error`         | Storing the envelope failed                                   |
| `500`  | `internal_error`        | Unexpected error                                              |

`toNodeListener(handle, options?)` adapts the handler to `node:http` and streams both bodies. `options.onError(res, error)` replaces the default `500` JSON response for unexpected errors.

## Options

`createSentra(options?: SentraOptions): Promise<Sentra>` opens the storage and runs a first retention pass.

| Option                      | Default                                        | Description                                                                                                                                                    |
| --------------------------- | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `storage`                   | `memoryStorage()`                              | Storage adapter                                                                                                                                                |
| `publicUrl`                 | none                                           | Base URL for `getDsn()` without path, e.g. `http://127.0.0.1:8969`                                                                                             |
| `retention.maxIdle`         | `"30d"` (`DEFAULT_MAX_IDLE`)                   | Delete a session after this time without events; duration or `"never"`                                                                                         |
| `retention.noiseMaxAge`     | `"7d"` (`DEFAULT_NOISE_MAX_AGE`)               | Delete `span`, `transaction`, `log`, `other` records older than this; duration or `"never"`                                                                    |
| `limits.maxEnvelopeBytes`   | 20 MiB (`DEFAULT_MAX_ENVELOPE_BYTES`)          | Max envelope size, before and after decompression                                                                                                              |
| `limits.maxAttachmentBytes` | 10 MiB (`DEFAULT_MAX_ATTACHMENT_BYTES`)        | Larger attachments are recorded without their bytes                                                                                                            |
| `rawEnvelopes`              | `true`                                         | Keep raw envelope bodies. Envelopes that fail to parse always keep theirs                                                                                      |
| `sourceMaps.enabled`        | `true`                                         | Map stack frames at ingest                                                                                                                                     |
| `sourceMaps.allowedHosts`   | `[]`                                           | Hosts (`host`, `host:port`, IPv6) allowed for HTTP fetches and in-app frames, added to loopback. The port is ignored: `host:port` allows that host on any port |
| `sourceMaps.sourceRoots`    | `[]`                                           | Absolute directories the FS loader may read                                                                                                                    |
| `sourceMaps.fetchTimeoutMs` | `1500` (`DEFAULT_SOURCE_MAP_FETCH_TIMEOUT_MS`) | Timeout per HTTP fetch                                                                                                                                         |
| `sourceMaps.budgetMs`       | `3000` (`DEFAULT_SOURCE_MAP_BUDGET_MS`)        | Time budget for mapping one envelope                                                                                                                           |
| `logger`                    | silent                                         | `{ debug, info, warn, error }(message, meta?)`                                                                                                                 |

Durations are `<number><ms|s|m|h|d|w>`, for example `"60m"` or `"30d"`. The defaults are exported as `DEFAULT_MAX_IDLE`, `DEFAULT_NOISE_MAX_AGE`, `DEFAULT_MAX_ENVELOPE_BYTES`, `DEFAULT_MAX_ATTACHMENT_BYTES`, `DEFAULT_MAX_ITEMS`, `DEFAULT_SOURCE_MAP_FETCH_TIMEOUT_MS` and `DEFAULT_SOURCE_MAP_BUDGET_MS`. Invalid options throw `SentraConfigError` (`invalid_option`).

## Storage

- `memoryStorage({ maxItems })`: in-process storage. `maxItems` defaults to `10_000`; the oldest records are evicted first.
- `sqliteStorage({ path, driver })`: SQLite file; missing directories are created. `driver` is `"auto"` (default), `"better-sqlite3"` or `"node"`. On Node, `auto` tries `better-sqlite3` first and falls back to `node:sqlite`; on Bun it uses `node:sqlite` only (see below). On Node 22, `node:sqlite` prints an `ExperimentalWarning`; Sentra filters it. If no driver loads, `createSentra` throws `SentraStorageError` (`storage_unavailable`) listing each driver's error. A driver that loads but cannot open the file (directory, no write permission) fails with `storage_unavailable` and `cannot open database file <path>: <reason>`, without trying the next driver.
- Use one writer per database file: do not open the same file from two Sentra instances at the same time.
- `sentra.info().storage` reports `{ type, driver, path }`, with `driver` set to `"better-sqlite3"` or `"node"` for SQLite.

The `StorageAdapter` interface and its types are exported for custom adapters.

## Bun-compiled hosts

On Bun, `auto` uses only `node:sqlite` (built into Bun `>=1.4`) and never loads `better-sqlite3`: Bun aborts the whole process when it loads that native addon (seen on 1.4.x), and the abort cannot be caught. `driver: "better-sqlite3"` still forces it. Hosts compiled with `bun build --compile` can pass `--external better-sqlite3` to keep the unused package out of the binary.

## DSN helpers

```ts
import { buildDsn, isIngestPath, parseDsnScope } from "@bosdev/sentra-core";

buildDsn({ baseUrl: "http://127.0.0.1:8969", project: "my-app", service: "web" });
// "http://sentra@127.0.0.1:8969/my-app/_/web/1"

sentra.getDsn({ project: "my-app", session: "3f9a1c", service: "web" });
// uses the publicUrl option; throws SentraConfigError (missing_public_url) without it

parseDsnScope("http://sentra@127.0.0.1:8969/my-app/3f9a1c/web/1");
// { project: "my-app", session: "3f9a1c", service: "web" }

isIngestPath("/my-app/3f9a1c/web/api/1/envelope/"); // true
```

`buildDsn` always uses the key `sentra` and project id `1`, omits trailing missing segments and writes `_` for missing middle segments.

## Query

All functions live on `sentra.query`:

| Function                              | Returns                                                               |
| ------------------------------------- | --------------------------------------------------------------------- |
| `listScopes(filter?)`                 | `ScopeSummary[]` with first/last seen, item and issue counts          |
| `listIssues(filter?, page?)`          | `Page<Issue>`, sorted by `lastSeenAt` desc                            |
| `getIssue(id)`                        | `IssueDetail` (issue plus `latest` record) or `null`                  |
| `listItems(filter?, page?)`           | `Page<ItemSummary>`, newest first                                     |
| `getItem(id)`                         | `Item` with kind-specific `data`, or `null`                           |
| `getItemByEventId(eventId)`           | First record with that event id (prefers error, message, transaction) |
| `getBlob(itemId)`                     | `{ data, contentType, filename }` of an attachment, or `null`         |
| `getRawEnvelope(envelopeId)`          | Raw envelope bytes, or `null` when not kept                           |
| `listFailedEnvelopes(filter?, page?)` | Envelopes that failed to parse                                        |

Filter fields:

- Scope: `project`, `session`, `service` (a value or an array).
- Time: `since` (duration, e.g. `"60m"`) or `from` / `to` (ISO 8601 or epoch ms). `since` and `from` cannot be combined. For issues the time applies to `lastSeenAt`.
- Items: `kind`, `itemType`, `level`, `minLevel`, `environment`, `release`, `eventId`, `issueId`, `traceId`, `q` (case-insensitive substring of the title).
- Issues: `kind` (`"error"` or `"message"`), `level`, `minLevel`, `q`.

Pagination: `page = { limit, cursor }`, `limit` defaults to 50; values outside 1 to 500 are clamped. Pass `nextCursor` from the previous page as `cursor`; it is `null` on the last page. Invalid filters throw `SentraValidationError` (`invalid_filter`, `invalid_cursor`). The zod schemas are exported (`itemFilterSchema`, `issueFilterSchema`, `scopeFilterSchema`, `liveFilterSchema`, `pageInputSchema`, ...).

```ts
const filter: ItemFilter = { project: "my-app", kind: ["error", "message"], since: "24h" };
const page = await sentra.query.listItems(filter, { limit: 20 });
// Reuse the same filter with the cursor.
const next =
  page.nextCursor === null
    ? null
    : await sentra.query.listItems(filter, { limit: 20, cursor: page.nextCursor });
```

## Live updates

```ts
const unsubscribe = sentra.subscribe({ project: "my-app", kind: "error" }, (event) => {
  if (event.type === "item.created") {
    console.log(event.item.title, event.issue?.isNew);
  } else {
    console.log("failed envelope", event.error);
  }
});

unsubscribe();
```

The filter is an item filter without time fields. Events:

```ts
type LiveEvent =
  | {
      type: "item.created";
      item: Item;
      issue: { id: string; isNew: boolean; count: number } | null;
    }
  | { type: "envelope.failed"; envelope: Omit<Envelope, "body">; error: string };
```

## MCP tools

`sentra.mcpTools()` returns five read-only tool definitions: `sentra_list_scopes`, `sentra_list_issues`, `sentra_get_issue`, `sentra_list_items`, `sentra_get_item`. Each has `name`, `title`, `description`, `inputSchema` (a zod v4 object), `annotations` and `handler(input)`. The output is compact Markdown.

Register them on the host's own `McpServer`, from SDK v2 `@modelcontextprotocol/server` or SDK v1 `@modelcontextprotocol/sdk/server/mcp.js`. Connecting it to a transport is up to the host:

```ts
import { McpServer } from "@modelcontextprotocol/server";

const mcpServer = new McpServer({ name: "my-host", version: "1.0.0" });
for (const tool of sentra.mcpTools()) {
  mcpServer.registerTool(
    tool.name,
    {
      title: tool.title,
      description: tool.description,
      inputSchema: tool.inputSchema,
      annotations: tool.annotations,
    },
    (args) => tool.handler(args),
  );
}
```

The host needs `zod` `^4`. Handlers validate their input themselves and return `isError: true` with the reason for invalid input or unknown ids.

## Source roots

The FS source-map loader only reads inside source roots (realpath checked, symlinks resolved). Set them with `sourceMaps.sourceRoots` or at runtime:

```ts
sentra.addSourceRoot("/path/to/my-app"); // absolute path; adding twice is a no-op
sentra.removeSourceRoot("/path/to/my-app");
```

Nuxt setup and troubleshooting: [docs/nuxt.md](https://github.com/boshold/sentra/blob/main/docs/nuxt.md).

## Maintenance

| Method           | Description                                                                        |
| ---------------- | ---------------------------------------------------------------------------------- |
| `clear(filter?)` | Deletes matching records; no filter deletes everything. Returns `{ itemsDeleted }` |
| `prune()`        | Runs both retention rules now. Returns `{ sessionsDeleted, itemsDeleted }`         |
| `vacuum()`       | SQLite `VACUUM`; no-op for memory storage                                          |
| `close()`        | Stops the hourly retention timer and closes the storage                            |

## Errors

All errors extend `SentraError` with `code` and optional `details`.

| Class                   | Code                   | When                                                           |
| ----------------------- | ---------------------- | -------------------------------------------------------------- |
| `SentraValidationError` | `invalid_filter`       | Filter or page input fails validation (`details` = zod issues) |
| `SentraValidationError` | `invalid_cursor`       | Cursor cannot be decoded                                       |
| `SentraConfigError`     | `missing_public_url`   | `getDsn()` without `publicUrl`                                 |
| `SentraConfigError`     | `invalid_option`       | Invalid `createSentra` options                                 |
| `SentraStorageError`    | `storage_unavailable`  | No SQLite driver could load, or the file cannot be opened      |
| `SentraStorageError`    | `schema_too_new`       | Database was written by a newer Sentra version                 |
| `SentraScopeError`      | `invalid_scope`        | Ingest: bad scope segment (`400`)                              |
| `SentraTooLargeError`   | `payload_too_large`    | Ingest: envelope over `maxEnvelopeBytes` (`413`)               |
| `SentraEncodingError`   | `unsupported_encoding` | Ingest: unknown or corrupt `Content-Encoding` (`415`)          |

## Other exports

- Renderers used by the CLI and the MCP tools: `renderIssueLine`, `renderIssueDetail`, `renderItemLine`, `renderItemDetail`, `renderScopeTable`, `renderFrameLines`, `renderStackMarkdown`, `formatFrameLocation`, `formatAttributes`, `formatDuration`, `formatRelativeTime`, `formatScope`.
- Parsers and checks: `parseDuration`, `parseDurationOrNever`, `isDuration`, `parseSize`, `parseAllowedHost`, `isScopeSegment`, `sanitizeText`, `firstLine`.
- Constants: `VERSION`, `ITEM_KINDS`, `LEVELS`.
- Zod schemas: `itemFilterSchema`, `issueFilterSchema`, `scopeFilterSchema`, `liveFilterSchema`, `pageInputSchema`, `timeFilterSchema`, `scopeTimeFilterSchema`, `itemKindSchema`, `levelSchema`.

## License

MIT

Sentra is not affiliated with or endorsed by Sentry. Sentry is a trademark of Functional Software, Inc.
