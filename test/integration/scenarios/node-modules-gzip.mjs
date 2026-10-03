import { createRequire } from "node:module";

import { captureException, close, flush, init } from "@sentry/node";

init({ dsn: process.env.SENTRA_DSN, tracesSampleRate: 0 });

const fakepkg = createRequire(import.meta.url)(process.env.FAKEPKG_PATH);
try {
  fakepkg.thrower();
} catch (error) {
  captureException(error);
}
captureException(new Error("big"), { extra: { blob: "x".repeat(40_000) } });

await flush(3000);
await close(3000);
