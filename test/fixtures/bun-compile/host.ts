// Host for `scripts/bun-compile-smoke.ts`: compiled with `bun build --compile --external better-sqlite3`.
import { createSentra, sqliteStorage } from "@bosdev/sentra-core";

const dbPath = process.argv.at(2);
if (dbPath === undefined) {
  throw new Error("usage: sentra-smoke <db path>");
}

const body = [
  JSON.stringify({
    event_id: "0123456789abcdef0123456789abcdef",
    sent_at: new Date().toISOString(),
  }),
  JSON.stringify({ type: "event" }),
  JSON.stringify({
    event_id: "0123456789abcdef0123456789abcdef",
    platform: "node",
    level: "error",
    exception: { values: [{ type: "Error", value: "smoke" }] },
  }),
].join("\n");

const sentra = await createSentra({ storage: sqliteStorage({ path: dbPath, driver: "auto" }) });
try {
  const response = await sentra.handle(
    new Request("http://localhost/smoke/s1/web/api/1/envelope/", { method: "POST", body }),
  );
  if (response.status !== 200) {
    throw new Error(`ingest failed with HTTP ${response.status}`);
  }
  const issues = await sentra.query.listIssues();
  process.stdout.write(
    `${JSON.stringify({ storage: sentra.info().storage, issues: issues.items.length })}\n`,
  );
} finally {
  await sentra.close();
}
