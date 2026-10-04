import type { Duration } from "#src/types.js";

const MIB = 1024 * 1024;

/** Session idle time before deletion. */
const DEFAULT_MAX_IDLE: Duration = "30d";
/** Max age of span/transaction/log/other records. */
const DEFAULT_NOISE_MAX_AGE: Duration = "7d";
const DEFAULT_MAX_ENVELOPE_BYTES = 20 * MIB;
const DEFAULT_MAX_ATTACHMENT_BYTES = 10 * MIB;
/** Record cap of `memoryStorage()`. */
const DEFAULT_MAX_ITEMS = 10_000;
/** Timeout per HTTP source-map fetch. */
const DEFAULT_SOURCE_MAP_FETCH_TIMEOUT_MS = 1500;
/** Time budget for mapping one envelope. */
const DEFAULT_SOURCE_MAP_BUDGET_MS = 3000;

export {
  DEFAULT_MAX_ATTACHMENT_BYTES,
  DEFAULT_MAX_ENVELOPE_BYTES,
  DEFAULT_MAX_IDLE,
  DEFAULT_MAX_ITEMS,
  DEFAULT_NOISE_MAX_AGE,
  DEFAULT_SOURCE_MAP_BUDGET_MS,
  DEFAULT_SOURCE_MAP_FETCH_TIMEOUT_MS,
};
