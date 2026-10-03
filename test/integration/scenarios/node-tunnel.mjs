import { captureException, close, flush, init } from "@sentry/node";

init({
  dsn: process.env.SENTRA_DSN,
  tunnel: process.env.SENTRA_TUNNEL,
  defaultIntegrations: false,
});

captureException(new Error("tunneled"));

await flush(3000);
await close(3000);
