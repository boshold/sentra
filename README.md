# Sentra

Sentra is a local receiver for Sentry events. Your apps keep the official Sentry SDKs (`@sentry/node`, `@sentry/browser`, `@sentry/vue`, `@sentry/nuxt`, ...) and only get a different DSN. Sentra stores errors, messages, logs, transactions and spans on your machine, groups errors into issues, maps stack frames back to your source, and lets you read everything in the terminal, over HTTP or through MCP.

There is no web UI, no `/store/` endpoint and no forwarding to Sentry.

## Which package?

| You want to                                                     | Use                    | Docs                                     |
| --------------------------------------------------------------- | ---------------------- | ---------------------------------------- |
| Run a local server with terminal output, an HTTP API and MCP    | `@bosdev/sentra-cli`  | [packages/cli](packages/cli/README.md)   |
| Embed the receiver in your own process (dev tool, service host) | `@bosdev/sentra-core` | [packages/core](packages/core/README.md) |

## Quick start

The packages are published to GitHub Packages, not npmjs. Point the `@boshold` scope at it once, with a GitHub token that has `read:packages`, in `~/.npmrc` or the project's `.npmrc`:

```ini
@boshold:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
```

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

- A session with no new event for 30 days is deleted with all its records and issues. Sessions in use keep their errors.
- `span`, `transaction`, `log` and `other` records older than 7 days are deleted, also in active sessions.
- Both limits can be changed or set to `never`. Retention runs at startup and then every hour.

## Security

- The CLI binds `127.0.0.1` by default.
- Ingest has no authentication and open CORS, because browser SDKs post from any origin. Envelopes are limited to 20 MiB and stored attachments to 10 MiB.
- The query API and MCP only answer requests whose `Host` and `Origin` are local or explicitly allowed. This blocks DNS rebinding and cross-site reads.
- Source maps are only fetched from loopback or allowed hosts and only read from source roots.
- Events can contain personal data (user, request headers, cookies with `sendDefaultPii`). Sentra keeps them on your machine and does not scrub them.

## Compatibility

- Node `>=22.15` or Bun `>=1.4`.
- Sentry JavaScript SDK v11 is tested in CI (`@sentry/node`, `@sentry/browser`). v8 to v10 and SDKs for other languages use the same protocol and should work, but are not tested.
- Linux and macOS. Windows is not tested.

## Development

```bash
pnpm install
pnpm check              # typecheck, lint, build, unit tests with coverage
pnpm test               # unit tests
pnpm test:integration   # real Sentry SDKs, Vite and Nitro against Sentra (run pnpm build first)
```

## Releasing

Run the Release workflow (Actions, Release) with a `bump` (`patch`, `minor`, `major`). It runs the full CI, writes the next version into both packages, tags `vX.Y.Z`, publishes both packages to GitHub Packages and creates the GitHub release, using the shared flow from [boshold/gh-actions](https://github.com/boshold/gh-actions#releasing). Do not push tags or edit versions by hand. `dry-run` tests the release without publishing.

## License

MIT, see [LICENSE](LICENSE) and [NOTICE](NOTICE).
