import { close, flush, init, logger, startSpan } from "@sentry/node";

init({ dsn: process.env.SENTRA_DSN, tracesSampleRate: 1, traceLifecycle: "static" });

startSpan({ name: "my-span", op: "test" }, () => {
  startSpan({ name: "child" }, () => {
    logger.info("log in span %s", ["x"]);
  });
});

await flush(3000);
await close(3000);
