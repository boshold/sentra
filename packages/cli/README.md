# @bosdev/sentra-cli

Local server for Sentry SDK events. Point any official Sentry SDK at it with a different DSN. Sentra stores the events in SQLite (or memory), prints errors, messages and logs in the terminal, and serves them over an HTTP query API, a server-sent events stream and an MCP endpoint.

Built on [`@bosdev/sentra-core`](https://github.com/boshold/sentra/tree/main/packages/core). Use that package instead if you want to embed the receiver in your own process.

## Install

Run it without installing:

```bash
pnpx @bosdev/sentra-cli
# or
npx @bosdev/sentra-cli
```

Or install it globally (binary `sentra`):

```bash
pnpm add -g @bosdev/sentra-cli
# or
npm install -g @bosdev/sentra-cli

sentra
```

Requires Node `>=22.15`. `better-sqlite3` is installed with the package as an optional dependency. If it cannot be installed or loaded, Sentra uses `node:sqlite`.

## Quick start

Start the server. It prints where it listens and which DSN to use:

```text
sentra 0.1.0  listening on http://127.0.0.1:8969
storage       sqlite ~/.local/share/sentra/sentra.db (driver: better-sqlite3, retention: 30d idle, noise 7d)
DSN           http://sentra@127.0.0.1:8969/1
scoped DSN    http://sentra@127.0.0.1:8969/<project>/<session>/<service>/1
query API     http://127.0.0.1:8969/api/sentra
MCP           http://127.0.0.1:8969/mcp
```

Initialize the SDK with the DSN:

```ts
Sentry.init({ dsn: "http://sentra@127.0.0.1:8969/1" });
```

To keep apps and services apart, add scope segments to the DSN:

```text
http://sentra@<host>:<port>/[project/][session/][service/]1
```

A missing segment becomes `default`, `_` skips a middle segment. Segments match `[A-Za-z0-9._-]{1,64}` and must not be `.` or `..`. The public key (`sentra`) and the project id (`1`) are ignored, but the SDK still checks them: the key must match `\w+` and the id must be digits.

## Recipes

Print a DSN for one app and service:

```bash
sentra dsn --project my-app --service web
# http://sentra@127.0.0.1:8969/my-app/_/web/1
```

Read errors from Claude Code (or any MCP client):

```bash
claude mcp add --transport http sentra http://127.0.0.1:8969/mcp
```

List the issues of the last hour:

```bash
curl "http://127.0.0.1:8969/api/sentra/issues?project=my-app&since=60m"
```

Show everything, including transactions and spans:

```bash
sentra --show all
```

Pipe live events into a script as NDJSON:

```bash
sentra --format json | jq 'select(.item.kind == "error") | .item.title'
```

Keep nothing on disk:

```bash
sentra --storage memory
```

Nuxt setup and troubleshooting: [docs/nuxt.md](https://github.com/boshold/sentra/blob/main/docs/nuxt.md).

## Flags

`sentra` and `sentra start` take the same flags, except `--version`, which only `sentra` accepts.

Durations: `<number><ms|s|m|h|d|w>`, e.g. `12h`, `30d`. Sizes: `<number>[b|kb|mb|gb]` in powers of 1024, e.g. `512kb`, `20mb`.

### Server

| Flag             | Type               | Default                   | Description                                                                  |
| ---------------- | ------------------ | ------------------------- | ---------------------------------------------------------------------------- |
| `--host`         | string             | `127.0.0.1`               | Bind address                                                                 |
| `--port`, `-p`   | number             | `8969`                    | Port; `0` picks a free port (the banner shows it). Port in use: exit 1       |
| `--public-url`   | URL                | `http://127.0.0.1:<port>` | Base URL for printed DSNs: scheme, host and port, no path                    |
| `--allowed-host` | string, repeatable | none                      | Extra allowed `Host` / `Origin` for the query API and MCP; a port is ignored |
| `--no-api`       | flag               | off                       | Disable `/api/sentra` (including the stream)                                 |
| `--no-mcp`       | flag               | off                       | Disable `/mcp`                                                               |

### Storage and limits

| Flag                | Type                                 | Default                           | Description                                                        |
| ------------------- | ------------------------------------ | --------------------------------- | ------------------------------------------------------------------ |
| `--storage`         | `memory` \| `sqlite`                 | `sqlite`                          | Storage                                                            |
| `--db`              | path                                 | `$XDG_DATA_HOME/sentra/sentra.db` | SQLite file; directories are created                               |
| `--sqlite-driver`   | `auto` \| `better-sqlite3` \| `node` | `auto`                            | Force a SQLite driver                                              |
| `--max-items`       | number                               | `10000`                           | Record cap of the memory storage                                   |
| `--retention`       | duration \| `never`                  | `30d`                             | Session idle time before deletion                                  |
| `--noise-retention` | duration \| `never`                  | `7d`                              | Max age of span, transaction, log and other records                |
| `--max-body`        | size                                 | `20mb`                            | Max envelope size                                                  |
| `--max-attachment`  | size                                 | `10mb`                            | Max stored attachment size; larger ones are recorded without bytes |
| `--no-raw`          | flag                                 | off                               | Do not keep raw envelope bodies                                    |

### Source maps

| Flag                | Type               | Default           | Description                                                                                                                  |
| ------------------- | ------------------ | ----------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `--no-source-maps`  | flag               | off               | Disable source mapping                                                                                                       |
| `--source-root`     | path, repeatable   | current directory | Directory the FS source-map loader may read                                                                                  |
| `--source-map-host` | string, repeatable | none              | Extra host for HTTP source-map fetches; a port is ignored. For a non-loopback `--host`, the bound host and LAN IPs are added |

### Live output

| Flag            | Type                                   | Default             | Description                                                                                                       |
| --------------- | -------------------------------------- | ------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `--show`        | comma list \| `all`                    | `error,message,log` | Kinds printed live                                                                                                |
| `--min-level`   | level                                  | none                | Minimum level printed live (`trace`, `debug`, `info`, `warning`, `error`, `fatal`); hides records without a level |
| `--project`     | string                                 | none                | Print only this project                                                                                           |
| `--session`     | string                                 | none                | Print only this session                                                                                           |
| `--service`     | string                                 | none                | Print only this service                                                                                           |
| `--format`      | `pretty` \| `json`                     | `pretty`            | Live output format; `json` prints one `LiveEvent` per line                                                        |
| `--quiet`, `-q` | flag                                   | off                 | No live output                                                                                                    |
| `--no-color`    | flag                                   | off                 | Disable colors                                                                                                    |
| `--log-level`   | `error` \| `warn` \| `info` \| `debug` | `warn`              | Internal log level (stderr)                                                                                       |

### Other

| Flag           | Description                                      |
| -------------- | ------------------------------------------------ |
| `--help`, `-h` | Show help                                        |
| `--version`    | Show version (`sentra` only, not `sentra start`) |

## `sentra dsn`

Prints one DSN and exits.

```bash
sentra dsn --project my-app --session 3f9a1c --service web
# http://sentra@127.0.0.1:8969/my-app/3f9a1c/web/1
sentra dsn --project my-app --service web --public-url http://192.168.1.20:8969
# http://sentra@192.168.1.20:8969/my-app/_/web/1
```

| Flag                                  | Default                 | Description       |
| ------------------------------------- | ----------------------- | ----------------- |
| `--project`, `--session`, `--service` | none                    | Scope segments    |
| `--public-url`                        | `http://127.0.0.1:8969` | Base URL, no path |

## Live output

Each record that passes the filters is printed as it arrives:

```text
16:40:15 ERROR my-app/3f9a1c/web  Error: boom
  at boom  /path/to/my-app/server/boom.mjs:15:9
  at ?     /path/to/my-app/server/boom.mjs:25:5
  … 3 more frames (library)
  issue 4f45fbbc NEW · 1× · env production · release r1
16:40:15 INFO  my-app/3f9a1c/web  hello msg
  at ?  /path/to/my-app/server/boom.mjs:31:1
  issue f0f8eb9f NEW · 1× · env production · release r1
16:40:15 TXN   my-app/3f9a1c/web  GET /api/users  42ms  ok
16:40:15 WARN  my-app/3f9a1c/web  disk almost full  {free: 512}
16:40:15 BAD   my-app/3f9a1c/web  invalid envelope: envelope header is not valid JSON (envelope 01a10235-634d-7652-963f-b994557d1164)
```

- Errors and messages show in-app frames, a count of collapsed library frames and the issue with its count (`NEW` on first sight). Positions marked with `~` come from SSR frames whose position is not reliable.
- `TXN` lines are transactions and spans (`--show all` or `--show transaction,span`), `ITEM` lines are attachments and other records, `BAD` lines are envelopes that failed to parse.
- Filter with `--show`, `--min-level`, `--project`, `--session`, `--service`. Failed envelopes are always printed.
- `--show span` prints only root spans. `other` records of type `session`, `sessions` and `client_report` are printed only with `--show all`.
- `--format json` prints NDJSON (`{"type":"item.created","item":{...},"issue":{...}}`). The banner then goes to stderr so stdout stays machine-readable. The same happens with `--quiet`.
- Colors are used only on a terminal. `NO_COLOR` or `--no-color` turns them off.
- If stdout is closed (for example `| head -1`), live output stops and the server keeps running.

## Query API

JSON API under `/api/sentra`. Array parameters can be repeated or comma separated (`kind=error,message`). Unknown or repeated scalar parameters return `400 invalid_filter`. Lists are paginated with `limit` (default 50, between 1 and 500) and `cursor` (`nextCursor` of the previous page).

| Route                                 | Parameters                                                                                                                                                                         | Response                                           | Errors                                      |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- | ------------------------------------------- |
| `GET /api/sentra/health`              | none                                                                                                                                                                               | `{ ok, version, storage: { type, driver, path } }` |                                             |
| `GET /api/sentra/scopes`              | `project`, `session`, `service`                                                                                                                                                    | `{ items: ScopeSummary[] }`                        | `400 invalid_filter`                        |
| `GET /api/sentra/issues`              | `project`, `session`, `service`, `since`, `from`, `to`, `kind`, `level`, `minLevel`, `q`, `limit`, `cursor`                                                                        | `{ items: Issue[], nextCursor }`                   | `400 invalid_filter`, `400 invalid_cursor`  |
| `GET /api/sentra/issues/:id`          | none                                                                                                                                                                               | Issue with `latest` record                         | `404 not_found`                             |
| `GET /api/sentra/items`               | `project`, `session`, `service`, `since`, `from`, `to`, `kind`, `itemType`, `level`, `minLevel`, `environment`, `release`, `eventId`, `issueId`, `traceId`, `q`, `limit`, `cursor` | `{ items: ItemSummary[], nextCursor }`             | `400 invalid_filter`, `400 invalid_cursor`  |
| `GET /api/sentra/items/:id`           | `:id` = item id or 32-hex event id                                                                                                                                                 | Item with `data`                                   | `404 not_found`                             |
| `GET /api/sentra/items/:id/envelope`  | `:id` = item id or event id                                                                                                                                                        | Raw envelope, `application/x-sentry-envelope`      | `404 not_found`, `404 raw_not_stored`       |
| `GET /api/sentra/attachments/:itemId` | none (also serves binary `other` records)                                                                                                                                          | Attachment bytes with `Content-Disposition`        | `404 not_found`, `404 blob_not_stored`      |
| `GET /api/sentra/envelopes/failed`    | `project`, `session`, `service`, `since`, `from`, `to`, `limit`, `cursor`                                                                                                          | `{ items: Envelope[], nextCursor }`                | `400 invalid_filter`, `400 invalid_cursor`  |
| `GET /api/sentra/stream`              | `project`, `session`, `service`, `kind`, `itemType`, `level`, `minLevel`, `environment`, `release`, `eventId`, `issueId`, `traceId`, `q`                                           | Server-sent events (see below)                     | `400 invalid_filter`                        |
| `DELETE /api/sentra/items`            | Same filters as `GET /api/sentra/items`, at least one required                                                                                                                     | `{ itemsDeleted }`                                 | `400 filter_required`, `400 invalid_filter` |

`since` is a duration (`60m`); `from` / `to` are ISO 8601 or epoch ms; `since` and `from` cannot be combined. `DELETE` without any filter returns `400 filter_required` instead of wiping everything.

All `/api/sentra/*` requests can also fail with `403 forbidden_host`, `403 forbidden_origin`, `405 method_not_allowed` or `500 internal_error`. Error bodies look like `{ "error": { "code": "invalid_filter", "message": "...", "details": ... } }`. With `--no-api` the routes answer `404 not_found`.

```bash
curl "http://127.0.0.1:8969/api/sentra/issues?project=my-app&since=60m"
curl "http://127.0.0.1:8969/api/sentra/items?project=my-app&kind=error,message&limit=10"
curl -X DELETE "http://127.0.0.1:8969/api/sentra/items?session=3f9a1c"
```

## SSE

`GET /api/sentra/stream` sends one server-sent event per live event. The query parameters are the same item filters without time fields.

```text
event: item.created
data: {"type":"item.created","item":{...},"issue":{"id":"...","isNew":true,"count":1}}

event: envelope.failed
data: {"type":"envelope.failed","envelope":{...},"error":"..."}
```

The stream starts with a `: connected` comment, then a `: ping` comment follows every 15 s. Clients ignore both. Methods other than `GET` get `405`; during shutdown new connections get `503 shutting_down`.

```bash
curl -N "http://127.0.0.1:8969/api/sentra/stream?project=my-app&kind=error"
```

## MCP

`POST /mcp` serves MCP over streamable HTTP (stateless). `GET` and `DELETE` return `405`. A rejected `Host` or `Origin` returns `403` with a JSON-RPC error body.

```bash
claude mcp add --transport http sentra http://127.0.0.1:8969/mcp
```

All tools are read-only and return compact Markdown.

| Tool                 | Input                                                                                                                                                                                                                                                             | Output                                                                          |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `sentra_list_scopes` | `project?`, `session?`                                                                                                                                                                                                                                            | Scopes with last seen, record and issue counts                                  |
| `sentra_list_issues` | `project?`, `session?`, `service?`, `kind?`, `minLevel?`, `since?` (default `24h`), `q?`, `limit?` (default 20, max 100), `cursor?`                                                                                                                               | One line per issue with short id, level, count, services                        |
| `sentra_get_issue`   | `id` (16-char id or short id prefix of at least 8 chars), `project?`, `session?`                                                                                                                                                                                  | Issue summary and its latest record                                             |
| `sentra_list_items`  | `project?`, `session?`, `service?`, `kind?`, `itemType?`, `level?`, `minLevel?`, `environment?`, `release?`, `eventId?`, `issueId?`, `traceId?`, `q?`, `since?` (default `60m` when `from` is not set), `from?`, `to?`, `limit?` (default 20, max 100), `cursor?` | One line per record with time, kind, level, scope, title, id                    |
| `sentra_get_item`    | `id` (item id or event id)                                                                                                                                                                                                                                        | Kind-specific detail: frames, request, tags, breadcrumbs, spans, log attributes |

## Storage and retention

The SQLite file is `$XDG_DATA_HOME/sentra/sentra.db` when `XDG_DATA_HOME` is an absolute path, otherwise `~/.local/share/sentra/sentra.db`. This is outside the project directory, so all projects share one database by default. Change it with `--db`. `--storage memory` keeps everything in memory (capped by `--max-items`) and loses it on exit.

- `--retention` (default `30d`): a session with no new event for this long is deleted with all its records and issues. Sessions in use keep their errors.
- `--noise-retention` (default `7d`): `span`, `transaction`, `log` and `other` records older than this are deleted, also in active sessions.
- Both accept `never`. Retention runs at startup and then every hour.

## Security

- Sentra binds `127.0.0.1` by default.
- Ingest has no authentication and open CORS (`Access-Control-Allow-Origin: *`), because browser SDKs post from any origin. Size limits apply (`--max-body`, `--max-attachment`).
- The query API and MCP check `Host` and `Origin` against `localhost`, `127.0.0.1`, `[::1]`, the bound host and `--allowed-host` values, and send no CORS headers. This blocks DNS rebinding and cross-site reads.
- Source maps are only fetched from loopback or allowed hosts and only read from source roots.
- Events can contain personal data (user, request headers, cookies with `sendDefaultPii`). Sentra keeps them on your machine and does not scrub them.

### LAN use

To receive events from other devices:

```bash
sentra --host 0.0.0.0 --allowed-host 192.168.1.20
```

- The banner prints one extra `DSN` line per LAN address and a warning that ingest is reachable from the network.
- Anyone who can reach the port can send events. The query API and MCP still reject `Host` / `Origin` values that are not `localhost`, `127.0.0.1`, `[::1]`, the bound host or an `--allowed-host` value.
- For a non-loopback `--host`, the bound host and this machine's LAN IPs are allowed for source-map fetches automatically.

## Exit codes

| Code | Meaning                                                 |
| ---- | ------------------------------------------------------- |
| `0`  | Normal shutdown (SIGINT / SIGTERM), also during startup |
| `1`  | Runtime failure: port in use, storage unavailable, ...  |
| `2`  | Invalid flags or arguments                              |

A second signal during shutdown exits with `1` at once.

## License

MIT
