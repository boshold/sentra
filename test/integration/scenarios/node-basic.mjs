import {
  captureException,
  captureMessage,
  close,
  flush,
  getCurrentScope,
  init,
  logger,
  startSpan,
} from "@sentry/node";

init({ dsn: process.env.SENTRA_DSN, tracesSampleRate: 1, release: "r1" });

function boom(n) {
  throw new Error(`boom ${n}`);
}

getCurrentScope().addAttachment({
  filename: "a.txt",
  data: "line1\nline2\n",
  contentType: "text/plain",
});
for (const n of [1, 2]) {
  try {
    boom(n);
  } catch (error) {
    captureException(error);
  }
  getCurrentScope().clearAttachments();
}
captureMessage("hello msg");
startSpan({ name: "my-span", op: "test" }, () => {
  startSpan({ name: "child" }, () => {
    logger.info("log in span %s", ["x"]);
  });
});
logger.info("info log", { foo: 1, bar: "b", baz: true, q: 1.5 });
logger.warn("warn log");

await flush(3000);
await close(3000);
