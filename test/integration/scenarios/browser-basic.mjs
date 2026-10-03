import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register({ url: "http://localhost:3000/app/page", width: 1024, height: 768 });

// Imported after registration so the SDK sees the happy-dom globals.
const {
  browserTracingIntegration,
  captureException,
  captureMessage,
  close,
  flush,
  getCurrentScope,
  init,
  logger,
  makeFetchTransport,
  startSpan,
} = await import("@sentry/browser");

init({
  dsn: process.env.SENTRA_DSN,
  release: "r1",
  tracesSampleRate: 1,
  integrations: [browserTracingIntegration()],
  // The default native fetch lookup fails under happy-dom ("The window is closed").
  transport: (options) => makeFetchTransport(options, async (...args) => globalThis.fetch(...args)),
});

function boom() {
  throw new Error("browser boom");
}

try {
  boom();
} catch (error) {
  captureException(error);
}

const depError = new Error("dep boom");
depError.stack = [
  "Error: dep boom",
  "    at depFn (http://localhost:3000/node_modules/.vite/deps/vue.js?v=abc12345:10:5)",
  "    at setup (http://localhost:3000/src/components/Card.vue:8:9)",
].join("\n");
captureException(depError);

logger.info("browser log", { a: 1 });
startSpan({ name: "bspan" }, () => undefined);

getCurrentScope().addAttachment({ filename: "b.bin", data: new Uint8Array([1, 10, 2]) });
captureMessage("bmsg");

await flush(3000);
document.dispatchEvent(new Event("visibilitychange"));
await close(3000);
await GlobalRegistrator.unregister();
