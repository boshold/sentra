# Sentra

Sentra is a local receiver for Sentry events. Your apps keep the official Sentry SDKs (`@sentry/node`, `@sentry/browser`, `@sentry/vue`, `@sentry/nuxt`, ...) and only get a different DSN. Sentra stores errors, messages, logs, transactions and spans on your machine, groups errors into issues, maps stack frames back to your source, and lets you read everything in the terminal, over HTTP or through MCP.

There is no web UI, no `/store/` endpoint and no forwarding to Sentry.

## Which package?

| You want to                                                     | Use                   | Docs                                     |
| --------------------------------------------------------------- | --------------------- | ---------------------------------------- |
| Run a local server with terminal output, an HTTP API and MCP    | `@bosdev/sentra-cli`  | [packages/cli](packages/cli/README.md)   |
| Embed the receiver in your own process (dev tool, service host) | `@bosdev/sentra-core` | [packages/core](packages/core/README.md) |

## Quick start

Start the server:

```bash
pnpx @bosdev/sentra-cli
```

Point the SDK at it:

```ts
import * as Sentry from "@sentry/node";

Sentry.init({ dsn: "http://sentra@127.0.0.1:8969/1" });
```

Errors, messages and logs show up in the terminal as they arrive:

```text
16:40:15 ERROR my-app/3f9a1c/web  Error: boom
  at boom  /path/to/my-app/server/boom.mjs:15:9
  at ?     /path/to/my-app/server/boom.mjs:25:5
  … 3 more frames (library)
  issue 4f45fbbc NEW · 1× · env production · release r1
16:40:15 WARN  my-app/3f9a1c/web  disk almost full  {free: 512}
```

To use it from Claude Code or another MCP client:

```bash
claude mcp add --transport http sentra http://127.0.0.1:8969/mcp
```

Flags, the HTTP query API, the live stream and the MCP tools are described in the [CLI README](packages/cli/README.md). For Nuxt apps, see [docs/nuxt.md](docs/nuxt.md).

## DSN and scopes

```text
http://sentra@<host>:<port>/[project/][session/][service/]1
```

The path segments before the trailing `1` set the scope of every record, so you can tell apps, checkouts and services apart.

| DSN                                                | project   | session   | service   |
| -------------------------------------------------- | --------- | --------- | --------- |
| `http://sentra@127.0.0.1:8969/1`                   | `default` | `default` | `default` |
| `http://sentra@127.0.0.1:8969/my-app/1`            | `my-app`  | `default` | `default` |
| `http://sentra@127.0.0.1:8969/my-app/3f9a1c/web/1` | `my-app`  | `3f9a1c`  | `web`     |
| `http://sentra@127.0.0.1:8969/my-app/_/web/1`      | `my-app`  | `default` | `web`     |

- A missing segment becomes `default`. `_` skips a middle segment.
- Segments match `[A-Za-z0-9._-]{1,64}` and must not be `.` or `..`. Anything else is rejected with `400 invalid_scope`.
- The public key (`sentra`) and the project id (`1`) are ignored, but the SDK still checks them: the key must match `\w+` and the id must be digits.
- `sentra dsn --project my-app --service web` prints `http://sentra@127.0.0.1:8969/my-app/_/web/1`.
- With the SDK `tunnel` option the request URL has no scope segments. Sentra then reads the scope from the `dsn` in the envelope header.

## What gets stored

Each envelope item becomes one record with a kind:

| Kind          | Source                                                                     |
| ------------- | -------------------------------------------------------------------------- |
| `error`       | Event with an exception                                                    |
| `message`     | Event from `captureMessage` (also when the SDK adds a synthetic exception) |
| `transaction` | `transaction` item                                                         |
| `span`        | Streamed `span` item                                                       |
| `log`         | One entry of a `log` item                                                  |
| `attachment`  | `attachment` item, bytes stored up to a size limit                         |
| `other`       | Everything else (`session`, `client_report`, profiles, ...)                |

Errors and messages are grouped into issues per `(project, session)`. Sentry JS SDK v11 streams spans as `span` items and has logs enabled by default, so expect many `span` and `log` records.

By default the CLI stores everything in one SQLite file outside your project (`~/.local/share/sentra/sentra.db`), shared by all projects. `--storage memory` keeps it in memory only.

## Source maps

Frames are mapped once, when the event arrives. The raw frame is kept next to the mapped location.

- Modules and their maps are fetched from dev servers such as Vite and Nuxt. Only loopback hosts are allowed unless you add more.
- Built files and their `.map` files are read from disk, but only inside source roots. The CLI uses the current directory unless you pass `--source-root`.

## Retention

Sessions without new events for 30 days are deleted with all their records. Spans, transactions, logs and other records are deleted after 7 days, also in active sessions. Both limits can be changed; see [Storage and retention](packages/cli/README.md#storage-and-retention).

## Security

Sentra binds `127.0.0.1` by default. Ingest has no authentication and open CORS, because browser SDKs post from any origin. The query API and MCP only answer local or explicitly allowed `Host` and `Origin` values. Events can contain personal data, which Sentra stores without scrubbing. Details: [Security](packages/cli/README.md#security). To report a vulnerability, see [SECURITY.md](SECURITY.md).

## Compatibility

- Node `>=22.15`. The core also runs on Bun `>=1.4`.
- Sentry JavaScript SDK v11 is tested in CI (`@sentry/node`, `@sentry/browser`). v8 to v10 and SDKs for other languages use the same protocol and should work, but are not tested.
- Linux and macOS. Windows is not tested.

## Contributing

Setup, tests and the release process are described in [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT, see [LICENSE](LICENSE) and [NOTICE](NOTICE).
