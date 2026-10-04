# Security Policy

## Supported versions

Sentra is pre-1.0 and ships fixes on the latest release only. Please check that you're on the most recent [release](https://github.com/boshold/sentra/releases/latest) before reporting.

| Version | Supported |
| ------- | --------- |
| latest  | Yes       |
| older   | No        |

## Reporting a vulnerability

Please do not open a public issue for security problems.

Report them privately through GitHub's [Report a vulnerability](https://github.com/boshold/sentra/security/advisories/new) form (Security, Advisories). Include:

- a description of the issue and its impact,
- steps to reproduce or a proof of concept,
- affected version, package (`@bosdev/sentra-cli` or `@bosdev/sentra-core`) and platform.

You should get a reply within a few days, and updates on the fix and disclosure timeline after that.

## Scope

Sentra is a local development tool. Some behavior is intentional:

- The ingest endpoint has no authentication and sends open CORS headers, because browser SDKs post from any origin. Anyone who can reach the port can send events.
- The CLI binds `127.0.0.1` by default. Binding another address (`--host`) exposes ingest to that network.
- Stored events can contain personal data (users, request headers, cookies with `sendDefaultPii`). Sentra keeps them on your machine and does not scrub them.

In scope, among others:

- Reading data through the query API, the SSE stream or MCP from a host or origin that is not allowed (DNS rebinding, cross-site reads).
- Source map loading that reads files outside the source roots or fetches from hosts that are not allowed.
- Crashes or unbounded resource use caused by a crafted envelope.
