import { BUSY_TIMEOUT_MS } from "#src/storage/sqlite/driver/types.js";
import type { SqliteDriver } from "#src/storage/sqlite/driver/types.js";

export const SCHEMA_V1 = `
CREATE TABLE scopes (
  project TEXT NOT NULL, session TEXT NOT NULL, service TEXT NOT NULL,
  first_seen_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL,
  item_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (project, session, service)
);
CREATE TABLE envelopes (
  id TEXT PRIMARY KEY,
  project TEXT NOT NULL, session TEXT NOT NULL, service TEXT NOT NULL,
  received_at INTEGER NOT NULL,
  header TEXT NOT NULL,
  size INTEGER NOT NULL,
  content_encoding TEXT,
  item_count INTEGER NOT NULL,
  parse_error TEXT,
  parse_warnings TEXT NOT NULL DEFAULT '[]',
  body BLOB
);
CREATE INDEX envelopes_scope ON envelopes (project, session, received_at);
CREATE INDEX envelopes_failed ON envelopes (received_at) WHERE parse_error IS NOT NULL;
CREATE TABLE issues (
  id TEXT PRIMARY KEY,
  project TEXT NOT NULL, session TEXT NOT NULL,
  kind TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  fingerprint_hash TEXT NOT NULL,
  title TEXT NOT NULL, culprit TEXT, level TEXT NOT NULL, platform TEXT,
  count INTEGER NOT NULL,
  first_seen_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL,
  last_item_id TEXT NOT NULL
);
CREATE INDEX issues_scope ON issues (project, session, last_seen_at DESC);
CREATE TABLE items (
  id TEXT PRIMARY KEY,
  envelope_id TEXT NOT NULL REFERENCES envelopes(id) ON DELETE CASCADE,
  project TEXT NOT NULL, session TEXT NOT NULL, service TEXT NOT NULL,
  kind TEXT NOT NULL, item_type TEXT NOT NULL,
  received_at INTEGER NOT NULL, timestamp INTEGER NOT NULL,
  event_id TEXT, issue_id TEXT, trace_id TEXT,
  level TEXT, level_rank INTEGER,
  environment TEXT, release TEXT, platform TEXT,
  title TEXT NOT NULL,
  data TEXT NOT NULL
);
CREATE INDEX items_scope_time ON items (project, session, service, id DESC);
CREATE INDEX items_timestamp ON items (timestamp);
CREATE INDEX items_event_id ON items (event_id);
CREATE INDEX items_issue ON items (issue_id, id DESC);
CREATE INDEX items_trace ON items (trace_id);
CREATE INDEX items_kind ON items (kind, id DESC);
CREATE INDEX items_issue_service ON items (issue_id, service) WHERE issue_id IS NOT NULL;
CREATE INDEX items_kind_received ON items (kind, received_at);
CREATE TABLE blobs (
  item_id TEXT PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,
  data BLOB NOT NULL
);
`;

/** Runs outside any transaction; `journal_mode` cannot change inside one. */
export function applyPragmas(driver: SqliteDriver): void {
  driver.exec("PRAGMA journal_mode=WAL");
  driver.exec("PRAGMA synchronous=NORMAL");
  driver.exec("PRAGMA foreign_keys=ON");
  driver.exec(`PRAGMA busy_timeout=${BUSY_TIMEOUT_MS}`);
}
