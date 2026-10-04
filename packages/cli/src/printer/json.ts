import type { LiveEvent } from "@bosdev/sentra-core";

/** One NDJSON line (`JSON.stringify` never emits raw newlines). */
function formatLiveEventJson(event: LiveEvent): string {
  return JSON.stringify(event);
}

export { formatLiveEventJson };
