import { matchesItemFilter, matchesScope } from "#src/storage/match.js";
import type { ResolvedLiveFilter } from "#src/storage/types.js";
import type { LiveEvent, SentraLogger } from "#src/types.js";

type LiveListener = (event: LiveEvent) => void;

interface LiveBus {
  subscribe(filter: ResolvedLiveFilter, listener: LiveListener): () => void;
  publish(event: LiveEvent): void;
  clear(): void;
}

interface Subscription {
  filter: ResolvedLiveFilter;
  listener: LiveListener;
}

function matches(event: LiveEvent, filter: ResolvedLiveFilter): boolean {
  return event.type === "item.created"
    ? matchesItemFilter(event.item, filter)
    : matchesScope(event.envelope.scope, filter);
}

function createLiveBus(logger: SentraLogger): LiveBus {
  const subscriptions = new Set<Subscription>();

  function deliver(subscription: Subscription, event: LiveEvent): void {
    try {
      subscription.listener(event);
    } catch (error) {
      logger.error(
        `live listener failed: ${error instanceof Error ? error.message : String(error)}`,
        {
          error,
          event: event.type,
        },
      );
    }
  }

  return {
    subscribe(filter, listener) {
      const subscription: Subscription = { filter, listener };
      subscriptions.add(subscription);
      return () => {
        subscriptions.delete(subscription);
      };
    },
    publish(event) {
      // Set iteration skips entries deleted during delivery.
      for (const subscription of subscriptions) {
        if (matches(event, subscription.filter)) {
          deliver(subscription, event);
        }
      }
    },
    clear() {
      subscriptions.clear();
    },
  };
}

export { createLiveBus };
export type { LiveBus, LiveListener };
