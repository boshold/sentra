# @bosdev/sentra-core

Embeddable receiver for Sentry SDK envelopes. It exports a fetch-style ingest handler, parses envelopes into typed records, groups errors into issues, maps stack frames through source maps, stores everything in memory or SQLite, and offers a query API, live subscriptions and MCP tool definitions. The host process owns the HTTP server; the core never listens on a port.

Apps keep the official Sentry SDKs and only get a Sentra DSN:

```text
http://sentra@<host>:<port>/[project/][session/][service/]1
```

A missing segment becomes `default`, `_` skips a middle segment, segments match `[A-Za-z0-9._-]{1,64}`. The public key and project id are ignored.

For a ready-made server with terminal output, HTTP API and MCP endpoint, use [`@bosdev/sentra-cli`](https://github.com/boshold/sentra/tree/main/packages/cli).

## Install

```bash
pnpm add @bosdev/sentra-core
# or
npm install @bosdev/sentra-core
```

Optional, for the preferred SQLite driver:

```bash
pnpm add better-sqlite3
```

Requires Node `>=22.15` or Bun `>=1.4`.

## Usage

```ts
import { createServer } from "node:http";
import { createSentra, sqliteStorage, toNodeListener } from "@bosdev/sentra-core";

const sentra = await createSentra({
  storage: sqliteStorage({ path: "/var/lib/my-host/sentra.db" }),
  publicUrl: "http://localhost:8969",
  retention: { maxIdle: "30d", noiseMaxAge: "7d" },
});

createServer(toNodeListener(sentra.handle)).listen(8969, "127.0.0.1");

sentra.addSourceRoot("/path/to/my-app");
const dsn = sentra.getDsn({ project: "my-app", session: "3f9a1c", service: "web" });
// http://sentra@localhost:8969/my-app/3f9a1c/web/1 -> pass as SENTRY_DSN to the service

const unsubscribe = sentra.subscribe({ project: "my-app", session: "3f9a1c" }, (event) => {
  if (event.type === "item.created") console.log(event.item.kind, event.item.title);
});

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

const issues = await sentra.query.listIssues({
  project: "my-app",
  session: "3f9a1c",
  since: "60m",
});
```

`mcpServer` is the host's own `McpServer` (SDK v1 `@modelcontextprotocol/sdk` or v2 `@modelcontextprotocol/server`). On shutdown call `unsubscribe()` and `await sentra.close()`. A host with its own router can use `isIngestPath(pathname)` to decide which requests go to `sentra.handle`.

`sentra.handle(request: Request): Promise<Response>` is bound and never rejects. It answers `POST` with `200 { id }` and `OPTIONS` with `204` plus CORS headers. Errors use the body `{ error: { code, message, details? } }` and repeat the message in `X-Sentry-Error`. It never answers `429`, because SDK v11 stops sending for 60 s after one.

`toNodeListener(handle, options?)` adapts the handler to `node:http` and streams both bodies. `options.onError(res, error)` replaces the default `500` JSON response for unexpected errors.

## Options

`createSentra(options?: SentraOptions): Promise<Sentra>` opens the storage and runs a first retention pass.

| Option                      | Default                                 | Description                                                                                 |
| --------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------- |
| `storage`                   | `memoryStorage()`                       | Storage adapter                                                                             |
| `publicUrl`                 | none                                    | Base URL for `getDsn()`, e.g. `http://localhost:8969`                                       |
| `retention.maxIdle`         | `"30d"` (`DEFAULT_MAX_IDLE`)            | Delete a session after this time without events; duration or `"never"`                      |
| `retention.noiseMaxAge`     | `"7d"` (`DEFAULT_NOISE_MAX_AGE`)        | Delete `span`, `transaction`, `log`, `other` records older than this; duration or `"never"` |
| `limits.maxEnvelopeBytes`   | 20 MiB (`DEFAULT_MAX_ENVELOPE_BYTES`)   | Max envelope size, before and after decompression                                           |
| `limits.maxAttachmentBytes` | 10 MiB (`DEFAULT_MAX_ATTACHMENT_BYTES`) | Larger attachments are recorded without their bytes                                         |
| `rawEnvelopes`              | `true`                                  | Keep raw envelope bodies                                                                    |
| `sourceMaps.enabled`        | `true`                                  | Map stack frames at ingest                                                                  |
| `sourceMaps.allowedHosts`   | `[]`                                    | Hosts (`host`, `host:port`, IPv6) allowed for HTTP fetches, added to loopback               |
| `sourceMaps.sourceRoots`    | `[]`                                    | Absolute directories the FS loader may read                                                 |
| `sourceMaps.fetchTimeoutMs` | `1500`                                  | Timeout per HTTP fetch                                                                      |
| `sourceMaps.budgetMs`       | `3000`                                  | Time budget for mapping one envelope                                                        |
| `logger`                    | silent                                  | `{ debug, info, warn, error }(message, meta?)`                                              |

Durations are `<number><ms|s|m|h|d|w>`, for example `"60m"` or `"30d"`. The defaults are exported as `DEFAULT_MAX_IDLE`, `DEFAULT_NOISE_MAX_AGE`, `DEFAULT_MAX_ENVELOPE_BYTES`, `DEFAULT_MAX_ATTACHMENT_BYTES` and `DEFAULT_MAX_ITEMS`. Invalid options throw `SentraConfigError` (`invalid_option`).

## Storage

- `memoryStorage({ maxItems })`: in-process storage. `maxItems` defaults to `10_000`; the oldest records are evicted first.
- `sqliteStorage({ path, driver })`: SQLite file; missing directories are created. `driver` is `"auto"` (default), `"better-sqlite3"` or `"node"`. `auto` tries `better-sqlite3` first and falls back to `node:sqlite` (Node `>=22.13`, Bun `>=1.4`). On Node 22, `node:sqlite` prints an `ExperimentalWarning`; Sentra filters it. If no driver loads, `createSentra` throws `SentraStorageError` (`storage_unavailable`) listing each driver's error.
- Use one writer per database file: do not open the same file from two Sentra instances at the same time.
- `sentra.info().storage` reports `{ type, driver, path }`, with `driver` set to `"better-sqlite3"` or `"node"` for SQLite.

The `StorageAdapter` interface and its types are exported for custom adapters.

## Bun-compiled hosts

Hosts compiled with `bun build --compile` must pass `--external better-sqlite3`. Bun bundles the package's JavaScript but not its `.node` file, and the binary then fails at runtime with an absolute path from the build machine. With the package external the import fails cleanly and Sentra uses `node:sqlite` (built into Bun `>=1.4`).

## DSN helpers

```ts
import { buildDsn, isIngestPath, parseDsnScope } from "@bosdev/sentra-core";

buildDsn({ baseUrl: "http://localhost:8969", project: "my-app", service: "web" });
// "http://sentra@localhost:8969/my-app/_/web/1"

sentra.getDsn({ project: "my-app", session: "3f9a1c", service: "web" });
// uses the publicUrl option; throws SentraConfigError (missing_public_url) without it

parseDsnScope("http://sentra@localhost:8969/my-app/3f9a1c/web/1");
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

Pagination: `page = { limit, cursor }`, `limit` defaults to 50 (max 500). Pass `nextCursor` from the previous page as `cursor`; it is `null` on the last page. Invalid filters throw `SentraValidationError` (`invalid_filter`, `invalid_cursor`). The zod schemas are exported (`itemFilterSchema`, `issueFilterSchema`, `scopeFilterSchema`, `liveFilterSchema`, `pageInputSchema`, ...).

```ts
const page = await sentra.query.listItems(
  { project: "my-app", kind: ["error", "message"], since: "24h" },
  { limit: 20 },
);
const next =
  page.nextCursor === null
    ? null
    : await sentra.query.listItems({ project: "my-app" }, { cursor: page.nextCursor });
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

The same loop works with SDK v1 (`@modelcontextprotocol/sdk`) and v2 (`@modelcontextprotocol/server`):

```ts
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

## License

MIT
