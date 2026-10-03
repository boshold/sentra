# Sentra

Sentra is a local receiver for Sentry events. Apps keep the official Sentry SDKs (`@sentry/node`, `@sentry/browser`, `@sentry/vue`, `@sentry/nuxt`, ...) and only get a different DSN. Sentra parses the envelopes into typed records, groups errors into issues, maps stack frames back to the original source, stores everything in memory or SQLite and lets you read it from the terminal, over HTTP, through MCP or from your own process.

Not included: the Sentry `/store/` endpoint, reprocessing, forwarding to Spotlight and a web UI.

## Packages

| Package               | Role                                                                                                                         | Docs                                     |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| `@bosdev/sentra-core` | Library: ingest handler, parser, issues, source maps, memory/SQLite storage, query API, live subscribe, MCP tool definitions | [packages/core](packages/core/README.md) |
| `@bosdev/sentra-cli`  | Standalone server `sentra`: HTTP server, startup banner, live terminal output, HTTP query API, SSE stream, MCP endpoint      | [packages/cli](packages/cli/README.md)   |

## Quick start (CLI)

```bash
pnpx @bosdev/sentra-cli
# or
npx @bosdev/sentra-cli
```

Startup banner:

```text
sentra 0.1.0  listening on http://127.0.0.1:8969
storage       sqlite ~/.local/share/sentra/sentra.db (driver: better-sqlite3, retention: 30d idle, noise 7d)
DSN           http://sentra@localhost:8969/1
scoped DSN    http://sentra@localhost:8969/<project>/<session>/<service>/1
query API     http://127.0.0.1:8969/api/sentra
MCP           http://127.0.0.1:8969/mcp
```

Point the SDK at it:

```ts
import * as Sentry from "@sentry/node";

Sentry.init({ dsn: "http://sentra@localhost:8969/1" });
```

Errors, messages and logs are printed as they arrive:

```text
16:40:15 ERROR my-app/3f9a1c/web  Error: boom
  at boom  /path/to/my-app/server/boom.mjs:15:9
  at ?     /path/to/my-app/server/boom.mjs:25:5
  … 3 more frames (library)
  issue 4f45fbbc NEW · 1× · env production · release r1
16:40:15 WARN  my-app/3f9a1c/web  disk almost full  {free: 512}
```

Common flags (full list in the [CLI README](packages/cli/README.md#flags)):

| Flag            | Default                           | Description                                         |
| --------------- | --------------------------------- | --------------------------------------------------- |
| `--port`, `-p`  | `8969`                            | Port; `0` picks a free port                         |
| `--host`        | `127.0.0.1`                       | Bind address                                        |
| `--storage`     | `sqlite`                          | `memory` or `sqlite`                                |
| `--db`          | `$XDG_DATA_HOME/sentra/sentra.db` | SQLite file                                         |
| `--source-root` | current directory                 | Directory Sentra may read source maps from (repeat) |
| `--show`        | `error,message,log`               | Kinds printed live, or `all`                        |
| `--format`      | `pretty`                          | `pretty` or `json` (NDJSON)                         |
| `--quiet`, `-q` | off                               | No live output                                      |

## DSN format

```text
http://sentra@<host>:<port>/[project/][session/][service/]1
```

The path segments before the trailing `1` set the scope of every record.

| DSN                                                | project   | session   | service   |
| -------------------------------------------------- | --------- | --------- | --------- |
| `http://sentra@localhost:8969/1`                   | `default` | `default` | `default` |
| `http://sentra@localhost:8969/my-app/1`            | `my-app`  | `default` | `default` |
| `http://sentra@localhost:8969/my-app/3f9a1c/web/1` | `my-app`  | `3f9a1c`  | `web`     |
| `http://sentra@localhost:8969/my-app/_/web/1`      | `my-app`  | `default` | `web`     |

- A missing segment becomes `default`. `_` skips a middle segment.
- Segments match `[A-Za-z0-9._-]{1,64}`. More than three segments or other characters are rejected with `400 invalid_scope`.
- The public key (`sentra`) and the project id (`1`) are ignored. The SDK still checks them: the key must match `\w+` and the id must be digits.
- `sentra dsn --project my-app --service web` prints `http://sentra@localhost:8969/my-app/_/web/1`.
- With the SDK `tunnel` option the request URL has no scope segments (for example `http://127.0.0.1:8969/api/1/envelope/`). Sentra then reads the scope from the `dsn` in the envelope header.

## What gets stored

Each envelope item becomes one record with a kind:

| Kind          | Source                                                                     |
| ------------- | -------------------------------------------------------------------------- |
| `error`       | Event with an exception                                                    |
| `message`     | Event from `captureMessage` (also when the SDK adds a synthetic exception) |
| `transaction` | `transaction` item                                                         |
| `span`        | Streamed `span` item                                                       |
| `log`         | One entry of a `log` item                                                  |
| `attachment`  | `attachment` item; bytes stored up to `--max-attachment`                   |
| `other`       | Everything else (`session`, `client_report`, profiles, ...)                |

Errors and messages are grouped into issues per `(project, session)`. Sentry JS SDK v11 streams spans as `span` items and has logs enabled by default, so expect many `span` and `log` records.

## Source maps

Frames are mapped once, at ingest, and the raw frame is kept next to the mapped location.

- HTTP loader: fetches modules and their maps from dev servers such as Vite and Nuxt. Only loopback hosts are allowed by default; add more with `--source-map-host`.
- FS loader: reads files and sibling `.map` files from disk, only inside source roots. The CLI uses the current directory unless you pass `--source-root` (repeatable).
- `--no-source-maps` turns mapping off.

Nuxt setup and troubleshooting: [docs/nuxt.md](docs/nuxt.md).

## Embedding in a host process

The core never listens on a port itself. The host owns the HTTP server and passes requests to `sentra.handle`.

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

Hosts compiled with `bun build --compile` must pass `--external better-sqlite3`. Bun bundles the package's JavaScript but not its `.node` file, and the binary then fails at runtime with an absolute path from the build machine. With the package external the import fails cleanly and Sentra uses `node:sqlite` (built into Bun `>=1.4`).

Full API: [packages/core/README.md](packages/core/README.md).

### ZAPS

ZAPS, the author's local dev service manager, is the reference host. The integration lives in the ZAPS repo; this is the contract it follows:

- ZAPS owns the HTTP server on port `8969` and mounts `toNodeListener(sentra.handle)`.
- `session` is the ZAPS `sessionId` (stable per checkout or worktree), `service` is the ZAPS service name. Each worktree gets its own issues.
- A per-project (optionally per-service) env mapping injects the DSN through a `{dsn}` placeholder:

  ```ts
  sentra: { env: { NUXT_PUBLIC_SENTRY_DSN: "{dsn}", SENTRY_ENABLED: "true" } }
  ```

- Project directories are added as source roots.
- The ZAPS TUI uses `subscribe()`, and the ZAPS MCP server registers `mcpTools()`.

## Query API

The CLI serves the stored data under `/api/sentra` (JSON). Details and error codes: [CLI README](packages/cli/README.md#query-api).

| Route                                 | Returns                                    |
| ------------------------------------- | ------------------------------------------ |
| `GET /api/sentra/health`              | Version and storage info                   |
| `GET /api/sentra/scopes`              | Known `project/session/service` scopes     |
| `GET /api/sentra/issues`              | Issues, newest first, paginated            |
| `GET /api/sentra/issues/:id`          | One issue with its latest record           |
| `GET /api/sentra/items`               | Records, newest first, paginated           |
| `GET /api/sentra/items/:id`           | One record by item id or event id          |
| `GET /api/sentra/items/:id/envelope`  | Raw envelope bytes of a record             |
| `GET /api/sentra/attachments/:itemId` | Attachment bytes                           |
| `GET /api/sentra/envelopes/failed`    | Envelopes that could not be parsed         |
| `GET /api/sentra/stream`              | Server-sent events for new records         |
| `DELETE /api/sentra/items`            | Deletes matching records (filter required) |

```bash
curl "http://127.0.0.1:8969/api/sentra/issues?project=my-app&since=60m"
```

## MCP

The CLI serves MCP (streamable HTTP) at `/mcp`:

```bash
claude mcp add --transport http sentra http://127.0.0.1:8969/mcp
```

Tools (all read-only): `sentra_list_scopes`, `sentra_list_issues`, `sentra_get_issue`, `sentra_list_items`, `sentra_get_item`.

## Retention

- `maxIdle` (default `30d`, CLI `--retention`): a session with no new event for this long is deleted with all its records and issues. Sessions in use keep their errors.
- `noiseMaxAge` (default `7d`, CLI `--noise-retention`): `span`, `transaction`, `log` and `other` records older than this are deleted, also in active sessions.
- Both accept `never`. Retention runs at startup and then every hour.

## Security

- The CLI binds `127.0.0.1` by default.
- Ingest has no authentication and open CORS (`Access-Control-Allow-Origin: *`), because browser SDKs post from any origin. Size limits apply: 20 MiB per envelope, 10 MiB per stored attachment.
- The query API and MCP check `Host` and `Origin` against `localhost`, `127.0.0.1`, `[::1]`, the bound host and `--allowed-host` values, and send no CORS headers. This blocks DNS rebinding and cross-site reads.
- `--host 0.0.0.0` exposes ingest to the LAN; the query API and MCP then need `--allowed-host <ip>`. Anyone who can reach the port can send events.
- Source maps are only fetched from loopback or allowed hosts and only read from source roots.
- Events may contain personal data (user, request headers, cookies with `sendDefaultPii`). Sentra keeps them on your machine and does not scrub them.

## Compatibility

- Node `>=22.15`. On Node 22, `node:sqlite` is used only when `better-sqlite3` cannot load; Sentra filters its `ExperimentalWarning`.
- Bun `>=1.4`.
- Sentry JavaScript SDK v11 is tested in CI (`@sentry/node`, `@sentry/browser`). v8 to v10 and SDKs for other languages use the same protocol and are expected to work, but are not tested.
- Linux and macOS. Windows is not tested.

## Why not Spotlight

Spotlight ignores the project in the DSN path, keeps one global buffer per process, stores events in memory only, has weak filtering and no exported parser. Sentra needs a scope per project, checkout and service, persistent storage with retention, and a library that a host process can embed. So it is a separate implementation that shares Spotlight's default port `8969`. See [NOTICE](NOTICE).

## Development

```bash
pnpm install
pnpm check              # typecheck, lint, build, unit tests with coverage
pnpm test               # unit tests
pnpm test:integration   # real Sentry SDKs, Vite and Nitro against Sentra (run pnpm build first)
```

## License

MIT, see [LICENSE](LICENSE) and [NOTICE](NOTICE).
