# Nuxt

Draft of the README "Nuxt" section. Verified with Nuxt 4.5.2, `@sentry/nuxt` 11.4.0, Vite 8.3.2 and Node 24 in `nuxt dev`.

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

`sentry.server.config.ts` (picked up by the module; no `--import` needed in dev):

```ts
import * as Sentry from "@sentry/nuxt";

Sentry.init({
  dsn: process.env.NUXT_PUBLIC_SENTRY_DSN,
  enabled: true,
  tracesSampleRate: 0,
});
```

`sentry.client.config.ts`:

```ts
import * as Sentry from "@sentry/nuxt";

Sentry.init({
  dsn: useRuntimeConfig().public.sentry.dsn,
  enabled: true,
  tracesSampleRate: 0,
});
```

Start the dev server with the Sentra DSN. Scope segments are `project/session/service`:

```bash
NUXT_PUBLIC_SENTRY_DSN=http://sentra@localhost:8969/q12/s1/web/1 pnpm dev
```

Keep `enabled: true`. With `enabled: false` the SDK never calls `Sentry.init` and nothing is sent.

Sentra needs the app directory as a source root to map server frames. When embedding the core:

```ts
import http from "node:http";
import { createSentra, memoryStorage, toNodeListener } from "@bosdev/sentra-core";

const sentra = await createSentra({
  storage: memoryStorage(),
  publicUrl: "http://localhost:8969",
  sourceMaps: { sourceRoots: ["/path/to/nuxt-app"] },
});
http.createServer(toNodeListener(sentra.handle)).listen(8969, "::");
```

Roots can also be added at runtime with `sentra.addSourceRoot(dir)`. Listen on `::` (or on both loopback addresses): browsers may resolve `localhost` to `::1`.

## What gets mapped

- **Browser frames** (`http://localhost:3000/_nuxt/...`): Sentra fetches the module from the Nuxt dev server (loopback hosts only by default) and reads Vite's inline source map. Example: a click handler throwing in `app/pages/client.vue` line 3 is stored as `pages/client.vue:3:9` with context lines. Paths are shown relative to `srcDir` because that is what the URL contains.
- **Nitro frames** (`file://<app>/.nuxt/dev/index.mjs`): Sentra reads the bundle and its sibling `index.mjs.map` from disk. The map has no `sourcesContent`, so context lines come from the original file (`server/api/boom.get.ts:3:9`). The bundle, the map and the original must all be inside a source root.
- Files outside the source roots are never read, also not through symlinks or `sourceMappingURL` references.

## SSR frames

Code that Vite runs on the server during SSR (`<script setup>` of pages and components, composables, plugins) reports frames with the original file path (`app/pages/ssr-page.vue`) but **generated** line and column. Nuxt's own stack fix does not reach the Sentry event: Sentry's Nitro `error` hook runs before it, and the hook gets an h3-wrapped error whose `stack` cannot be rewritten. Errors reported with `Sentry.captureException` inside a component never go through that hook.

Sentra cannot map these frames: the files on disk are the original sources and have no source map. It stores them with `positionReliable: false`, drops the SDK context lines (they were read from the wrong lines) and records the reason `ssr_position_unreliable`. The CLI marks such positions with `~`.

To get correct SSR positions, add this dev-only Nitro plugin. It maps stack frames through the source maps of Nuxt's vite-node runner before any error is captured.

`server/dev/ssr-stack-positions.ts` (not in `server/plugins/`, so it is only loaded through `$development` in `nuxt.config.ts` above):

```ts
// Dev only: rewrites vite-node SSR stack frames to original positions.
import { SourceMap } from "node:module";
// @ts-expect-error virtual module from @nuxt/vite-builder (dev only)
import runner from "#internal/nuxt/vite-node-runner.mjs";

const FRAME = /(\(|at )([^()\s]+):(\d+):(\d+)(\)?)$/;

function toOriginal(line: string): string {
  const match = FRAME.exec(line);
  if (!match) return line;
  const [, open, file, lineNo, colNo, close] = match;
  const payload = runner.moduleCache.getSourceMap(file);
  if (!payload) return line;
  const entry = new SourceMap(payload).findEntry(Number(lineNo) - 1, Number(colNo) - 1);
  if (!("originalLine" in entry)) return line;
  return line.replace(
    FRAME,
    `${open}${file}:${entry.originalLine + 1}:${entry.originalColumn + 1}${close}`,
  );
}

const previous = Error.prepareStackTrace;

Error.prepareStackTrace = (error, callSites) => {
  const stack = previous
    ? previous(error, callSites)
    : [String(error), ...callSites.map((site) => `    at ${site}`)].join("\n");
  return typeof stack === "string" ? stack.split("\n").map(toOriginal).join("\n") : stack;
};

export default defineNitroPlugin(() => {});
```

With the plugin, SSR frames carry the original line and column (e.g. `app/pages/ssr-page.vue:4:9`), also for `Sentry.captureException`. Sentra still flags them with `positionReliable: false`, because the file on disk has no `sourceMappingURL`; the raw `lineno` / `colno` of the stored frame are correct.

## Troubleshooting

Each error/message record has `data.sourceMaps` with `status` (`not_applicable`, `none`, `partial`, `full`) and `errors: { absPath, reason }[]`. Common reasons:

| Reason                                     | Meaning                                                                     | Fix                                                                  |
| ------------------------------------------ | --------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `not_javascript`                           | The dev server answered with HTML (unknown path, SPA fallback).             | Check that the frame URL is a module the dev server still serves.    |
| `http_status_<code>`                       | The dev server answered with an error status (`504` = stale optimized dep). | Reload the page so the browser uses current URLs.                    |
| `fetch_failed` / `timeout`                 | The dev server is not reachable or too slow.                                | Make sure the dev server runs on the host and port in the frame URL. |
| `budget_exceeded`                          | The per-envelope time budget (3 s) is used up.                              | Usually transient; raise `sourceMaps.budgetMs`.                      |
| `no_source_map`                            | The file has no `sourceMappingURL` (often libraries in `node_modules`).     | Nothing to do for library frames.                                    |
| `invalid_source_map` / `no_mapping`        | The map is broken or has no entry for the position.                         | Restart the dev server.                                              |
| `map_outside_source_root`                  | The map file is missing or outside the source roots.                        | Add the directory with `addSourceRoot`.                              |
| `map_not_allowed` / `redirect_not_allowed` | The map or a redirect points to another host or port.                       | Not followed on purpose.                                             |
| `ssr_position_unreliable`                  | SSR frame with generated positions (see above).                             | Add the SSR plugin; positions are then correct, the flag stays.      |

Frames on hosts outside `sourceMaps.allowedHosts` (loopback by default) and files outside the source roots are not candidates: they are not listed in `errors`, and `status` is `not_applicable` when no frame is a candidate.

If browser frames map to the wrong line after restarting the dev server with a changed config, restart Sentra: cached maps are keyed by URL, and Vite only changes the URL (`?t=`) on HMR updates.
