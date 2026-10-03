# Sentra

> Work in progress. Nothing is published yet.

Sentra is a local, Sentry-compatible event receiver written in TypeScript. Apps keep using the official Sentry SDKs (`@sentry/node`, `@sentry/browser`, `@sentry/vue`, `@sentry/nuxt`, ...) and only get a different DSN. Sentra accepts their envelopes, parses them into typed records (errors, messages, transactions, streamed spans, logs, attachments), groups errors into issues, maps stack frames back to the original source (Vite / Nuxt dev servers, Node files), stores everything in memory or SQLite, and lets consumers query and subscribe to it.

## Packages

| Package | Path | Role |
| ------- | ---- | ---- |
| `@bosdev/sentra-core` | `packages/core` | Library: ingest handler, parser, typed model, issues, source maps, storage, query, live subscribe, MCP tool definitions |
| `@bosdev/sentra-cli` | `packages/cli` | Standalone app: HTTP server, startup banner, live terminal output, HTTP query API, MCP endpoint |

## License

MIT, see [LICENSE](LICENSE) and [NOTICE](NOTICE).
