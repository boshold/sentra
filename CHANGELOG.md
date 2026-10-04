# Changelog

All notable changes to `@bosdev/sentra-core` and `@bosdev/sentra-cli`. Both packages share one version number.

## Unreleased

- Packages are published to npm as `@bosdev/sentra-core` and `@bosdev/sentra-cli`, with provenance. Version 0.1.0 was only published to GitHub Packages under the `@boshold` scope.

## 0.1.0 - 2026-10-03

First release.

### `@bosdev/sentra-core`

- Ingest handler for the Sentry envelope protocol (`POST /[project/][session/][service/]api/:projectId/envelope/`, `OPTIONS` with open CORS), with gzip, deflate, brotli and zstd decoding, size limits and `toNodeListener` for `node:http`.
- Scope from the DSN path (`project/session/service`, `default` for missing segments, `_` to skip one) or from the envelope header DSN when the SDK uses `tunnel`.
- Built-in envelope parser that continues past bad items and stores the raw body of envelopes that fail to parse.
- Typed records: `error`, `message`, `transaction`, `span`, `log`, `attachment`, `other`, including streamed spans and logs from Sentry JS SDK v11.
- Issue grouping per `(project, session)` with in-app aware fingerprints and custom fingerprint support.
- Source mapping at ingest: HTTP loader for Vite and Nuxt dev servers on loopback or allowed hosts, FS loader limited to source roots, `inApp` recomputation, unreliable SSR positions flagged.
- Storage: `memoryStorage` and `sqliteStorage` (`better-sqlite3` with fallback to `node:sqlite` on Node, `node:sqlite` only on Bun), plus the `StorageAdapter` interface for custom adapters.
- Query API (`listScopes`, `listIssues`, `getIssue`, `listItems`, `getItem`, `getItemByEventId`, `getBlob`, `getRawEnvelope`, `listFailedEnvelopes`) with exported zod filter schemas and cursor pagination.
- Live updates with `subscribe(filter, listener)` (`item.created`, `envelope.failed`).
- Retention: idle sessions after `30d`, spans, transactions, logs and other records after `7d`; both configurable or `never`. Exported default constants.
- Five read-only MCP tool definitions (`sentra_list_scopes`, `sentra_list_issues`, `sentra_get_issue`, `sentra_list_items`, `sentra_get_item`) for MCP SDK v1 and v2 hosts.
- Plain-text renderers for issues, records and stack frames.

### `@bosdev/sentra-cli`

- `sentra` / `sentra start`: HTTP server on `127.0.0.1:8969` with a startup banner, SQLite storage under `$XDG_DATA_HOME/sentra/sentra.db` (fallback `~/.local/share/sentra/sentra.db`) or memory storage. Printed DSNs use `http://127.0.0.1:<port>` unless `--public-url` is set.
- Live terminal output (pretty or NDJSON) with kind, level and scope filters.
- HTTP query API under `/api/sentra`, server-sent events at `/api/sentra/stream` and a stateless MCP endpoint at `/mcp`, protected by `Host` / `Origin` checks.
- `sentra dsn` to print scoped DSNs.
- Clean shutdown on SIGINT / SIGTERM, also during startup.
