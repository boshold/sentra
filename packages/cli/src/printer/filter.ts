import { LEVELS } from "@boshold/sentra-core";
import type { Item, Level, LiveEvent } from "@boshold/sentra-core";

import type { StartConfig } from "#src/config.js";

type LiveFilterOptions = Pick<StartConfig, "show" | "minLevel" | "project" | "session" | "service">;

const NOISE_ITEM_TYPES: ReadonlySet<string> = new Set(["session", "sessions", "client_report"]);

function levelRank(level: Level): number {
  return LEVELS.indexOf(level);
}

function passesKind(item: Item, show: LiveFilterOptions["show"]): boolean {
  if (show === "all") {
    return true;
  }
  if (!show.includes(item.kind)) {
    return false;
  }
  if (item.kind === "span") {
    return item.data.isSegment;
  }
  return item.kind !== "other" || !NOISE_ITEM_TYPES.has(item.itemType);
}

function passesScope(item: Item, options: LiveFilterOptions): boolean {
  return (
    (options.project === null || item.scope.project === options.project) &&
    (options.session === null || item.scope.session === options.session) &&
    (options.service === null || item.scope.service === options.service)
  );
}

function passesLevel(item: Item, minLevel: Level | null): boolean {
  return minLevel === null || (item.level !== null && levelRank(item.level) >= levelRank(minLevel));
}

/** Live output filter; failed envelopes always pass. */
function createLiveFilter(options: LiveFilterOptions): (event: LiveEvent) => boolean {
  return function filter(event) {
    if (event.type === "envelope.failed") {
      return true;
    }
    const { item } = event;
    return (
      passesScope(item, options) &&
      passesKind(item, options.show) &&
      passesLevel(item, options.minLevel)
    );
  };
}

export { createLiveFilter };
export type { LiveFilterOptions };
