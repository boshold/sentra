// Second process for the contention test: hammers `scopes` with write transactions.
import { DatabaseSync } from "node:sqlite";

const [dbPath, rounds = "200"] = process.argv.slice(2);
const db = new DatabaseSync(dbPath, { timeout: 5000 });
const upsert = db.prepare(
  `INSERT INTO scopes (project, session, service, first_seen_at, last_seen_at, item_count)
   VALUES ('writer', 'w1', 'svc', ?, ?, 1)
   ON CONFLICT(project, session, service) DO UPDATE SET
     last_seen_at = excluded.last_seen_at, item_count = item_count + 1`,
);

process.stdout.write("ready\n");
let errors = 0;
for (let index = 0; index < Number(rounds); index += 1) {
  try {
    db.exec("BEGIN IMMEDIATE");
    upsert.run(index, index);
    db.exec("COMMIT");
  } catch (error) {
    errors += 1;
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    try {
      db.exec("ROLLBACK");
    } catch {
      // No open transaction.
    }
  }
}
db.close();
process.stdout.write(`${JSON.stringify({ errors })}\n`);
