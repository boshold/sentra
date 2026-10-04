# Nuxt

How to send Nuxt dev errors to Sentra and what Sentra can map. Last checked in October 2026 with Nuxt 4.5.2, `@sentry/nuxt` 11.4.0 and Vite 8.3.2 in `nuxt dev`, on Node 24.21 and Node 22.23 (including the SSR plugin below).

## Setup

Install the Sentry SDK in the Nuxt app:

```bash
pnpm add @sentry/nuxt
```

`nuxt.config.ts`:

```ts
export default defineNuxtConfig({
  compatibilityDate: "2025-07-15",
  modules: ["@sentry/nuxt/module"],
  runtimeConfig: {
    public: {
      sentry: { dsn: "" }, // set by NUXT_PUBLIC_SENTRY_DSN
    },
  },
  $development: {
    nitro: { plugins: ["~~/server/dev/ssr-stack-positions"] },
  },
});
```

`sentry.server.config.ts` in the project root, next to `nuxt.config.ts` (picked up by the module; no `--import` needed in dev):

```ts
import * as Sentry from "@sentry/nuxt";

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  enabled: true,
  tracesSampleRate: 0,
});
```

`sentry.client.config.ts`, also in the project root:

```ts
import * as Sentry from "@sentry/nuxt";

Sentry.init({
  dsn: useRuntimeConfig().public.sentry.dsn,
  enabled: true,
  tracesSampleRate: 0,
});
```

Start the dev server with the Sentra DSN. The server SDK reads `SENTRY_DSN`; the browser gets the DSN through the public runtime config (`NUXT_PUBLIC_SENTRY_DSN`). Scope segments are `project/session/service`:

```bash
SENTRY_DSN=http://sentra@127.0.0.1:8969/my-app/3f9a1c/web/1 \
NUXT_PUBLIC_SENTRY_DSN=http://sentra@127.0.0.1:8969/my-app/3f9a1c/web/1 \
pnpm dev
```

`sentra dsn --project my-app --session 3f9a1c --service web` prints this DSN.

Keep `enabled: true` in dev. With `enabled: false` the SDK sends nothing.

Sentra needs the app directory as a source root to map server frames. The CLI uses the directory it was started in; otherwise pass `--source-root /path/to/nuxt-app`. When embedding the core:

```ts
import http from "node:http";
import { createSentra, memoryStorage, toNodeListener } from "@bosdev/sentra-core";

const sentra = await createSentra({
  storage: memoryStorage(),
  publicUrl: "http://127.0.0.1:8969",
  sourceMaps: { sourceRoots: ["/path/to/nuxt-app"] },
});
http.createServer(toNodeListener(sentra.handle)).listen(8969, "127.0.0.1");
```

An embedding host can also add roots at runtime with `sentra.addSourceRoot(dir)`; with the CLI, repeat `--source-root`. Sentra listens on `127.0.0.1` by default; use `127.0.0.1` (not `localhost`) in the DSN, because browsers may resolve `localhost` to `::1`.

## What gets mapped

- **Browser frames** (`http://localhost:3000/_nuxt/...`): Sentra fetches the module from the Nuxt dev server (loopback hosts only by default) and reads Vite's inline source map. Example: a click handler throwing in `app/pages/client.vue` line 3 is stored as `pages/client.vue:3:9` with context lines. Paths are shown relative to `srcDir` because that is what the URL contains.
- **Nitro frames** (`file://<app>/.nuxt/dev/index.mjs`): Sentra reads the bundle and its sibling `index.mjs.map` from disk. The map has no `sourcesContent`, so context lines come from the original file (`server/api/boom.get.ts:3:9`). The bundle, the map and the original must all be inside a source root.
- Files outside the source roots are never read, also not through symlinks or `sourceMappingURL` references.

## SSR frames

Code that Vite runs on the server during SSR (`<script setup>` of pages and components, composables, plugins) reports frames with the original file path (`app/pages/ssr-page.vue`) but **generated** line and column. Nuxt's own stack fix does not reach the Sentry event: Sentry's Nitro `error` hook runs before it, and the hook gets an h3-wrapped error whose `stack` cannot be rewritten. Errors reported with `Sentry.captureException` inside a component never go through that hook.

Sentra cannot map these frames: the files on disk are the original sources and have no source map. It stores them with `positionReliable: false`, drops the SDK context lines (they were read from the wrong lines) and records the reason `ssr_position_unreliable`. The CLI marks such positions with `~`.

To get correct SSR positions, add this dev-only Nitro plugin. It maps stack frames through the source maps of Nuxt's vite-node runner before any error is captured. It uses internal Nuxt APIs (`#internal/nuxt/vite-node-runner.mjs`, `runner.moduleCache`), which can change in any Nuxt release.

`server/dev/ssr-stack-positions.ts` (not in `server/plugins/`, so it is only loaded through `$development` in `nuxt.config.ts` above):

```ts
// Dev only: rewrites vite-node SSR stack frames to original positions.
import { SourceMap } from "node:module";
// @ts-expect-error virtual module from @nuxt/vite-builder (dev only)
import runner from "#internal/nuxt/vite-node-runner.mjs";

const INSTALLED = Symbol.for("sentra.ssrStackPositions");
const FRAME = /(\(|at )([^()\s]+):(\d+):(\d+)(\)?)$/;
const maps = new Map<string, { payload: unknown; map: SourceMap }>();

function sourceMapFor(file: string): SourceMap | null {
  const payload = runner.moduleCache.getSourceMap(file);
  if (!payload) return null;
  const cached = maps.get(file);
  // The runner keeps one payload object per module version.
  if (cached?.payload === payload) return cached.map;
  const map = new SourceMap(payload);
  maps.set(file, { payload, map });
  return map;
}

function toOriginal(line: string): string {
  const match = FRAME.exec(line);
  if (!match) return line;
  const [, open, file, lineNo, colNo, close] = match;
  const entry = sourceMapFor(file)?.findEntry(Number(lineNo) - 1, Number(colNo) - 1);
  if (!entry || !("originalLine" in entry)) return line;
  return line.replace(
    FRAME,
    `${open}${file}:${entry.originalLine + 1}:${entry.originalColumn + 1}${close}`,
  );
}

export default defineNitroPlugin(() => {
  if (Reflect.get(globalThis, INSTALLED) === true) return;
  Reflect.set(globalThis, INSTALLED, true);
  const previous = Error.prepareStackTrace;
  Error.prepareStackTrace = (error, callSites) => {
    const stack = previous
      ? previous(error, callSites)
      : [String(error), ...callSites.map((site) => `    at ${site}`)].join("\n");
    return typeof stack === "string" ? stack.split("\n").map(toOriginal).join("\n") : stack;
  };
});
```

With the plugin, SSR frames carry the original line and column (e.g. `app/pages/ssr-page.vue:4:9`), also for `Sentry.captureException`. Sentra still flags them with `positionReliable: false`, because the file on disk has no `sourceMappingURL`; the raw `lineno` / `colno` of the stored frame are correct.

## Troubleshooting

Each error/message record has `data.sourceMaps` with `status` (`not_applicable`, `none`, `partial`, `full`) and `errors: { absPath, reason }[]`. Common reasons:

| Reason                                     | Meaning                                                                                                              | Fix                                                                                             |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `not_javascript`                           | The dev server answered with HTML (unknown path, SPA fallback).                                                      | Check that the frame URL is a module the dev server still serves.                               |
| `http_status_<code>`                       | The dev server answered with an error status (`504` = stale optimized dep).                                          | Reload the page so the browser uses current URLs.                                               |
| `fetch_failed` / `timeout`                 | The dev server is not reachable or too slow.                                                                         | Make sure the dev server runs on the host and port in the frame URL.                            |
| `budget_exceeded`                          | The per-envelope time budget (3 s) is used up.                                                                       | Usually transient. Embedding hosts can raise `sourceMaps.budgetMs`; the CLI has no flag for it. |
| `too_many_candidates`                      | The envelope has more than 50 distinct module URLs or files; the rest are not loaded. At most 8 are fetched at once. | Nothing to do; this bounds the work one envelope can cause.                                     |
| `no_source_map`                            | The file has no `sourceMappingURL` (often libraries in `node_modules`).                                              | Nothing to do for library frames.                                                               |
| `invalid_source_map` / `no_mapping`        | The map is broken or has no entry for the position.                                                                  | Restart the dev server.                                                                         |
| `map_outside_source_root`                  | The map file is missing or outside the source roots.                                                                 | Add the directory with `--source-root` (CLI) or `addSourceRoot` (embedding).                    |
| `too_large` / `read_failed`                | The module or map is over the size limit, or the file could not be read.                                             | Check file size and permissions.                                                                |
| `map_not_allowed` / `redirect_not_allowed` | The map or a redirect points to another host or port.                                                                | Not followed on purpose.                                                                        |
| `ssr_position_unreliable`                  | SSR frame with generated positions (see above).                                                                      | Add the SSR plugin; positions are then correct, the flag stays.                                 |

Frames on hosts outside `sourceMaps.allowedHosts` (loopback by default) and files outside the source roots are not candidates: they are not listed in `errors`, and `status` is `not_applicable` when no frame is a candidate.

Sentra caches source maps by URL. Before reusing a cached map it asks the dev server whether the module changed (`If-None-Match` / `If-Modified-Since`; Vite answers `304` when it did not), and for a separate `.map` file whether that changed too. A module or `.map` file sent without `ETag` / `Last-Modified` is reloaded after 30 s, and failed lookups such as `no_source_map` are retried after 5 s.
