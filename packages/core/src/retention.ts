import type { StorageAdapter } from "#src/storage/types.js";
import type { ItemKind, SentraLogger } from "#src/types.js";

const NOISE_KINDS: ItemKind[] = ["span", "transaction", "log", "other"];
const INTERVAL_MS = 60 * 60 * 1000;

interface RetentionDeps {
  storage: StorageAdapter;
  /** `null` = never. */
  maxIdleMs: number | null;
  /** `null` = never. */
  noiseMaxAgeMs: number | null;
  logger: SentraLogger;
  now?: () => number;
}

interface PruneResult {
  sessionsDeleted: number;
  itemsDeleted: number;
}

interface Retention {
  prune(): Promise<PruneResult>;
  start(): void;
  stop(): void;
}

function createRetention(deps: RetentionDeps): Retention {
  const { storage, maxIdleMs, noiseMaxAgeMs, logger } = deps;
  const now = deps.now ?? Date.now;
  let timer: ReturnType<typeof setInterval> | null = null;

  async function prune(): Promise<PruneResult> {
    const at = now();
    const idle =
      maxIdleMs === null
        ? { sessionsDeleted: 0, itemsDeleted: 0 }
        : await storage.pruneIdleSessions(new Date(at - maxIdleMs));
    const noise =
      noiseMaxAgeMs === null
        ? { itemsDeleted: 0 }
        : await storage.pruneOldItems([...NOISE_KINDS], new Date(at - noiseMaxAgeMs));
    const result = {
      sessionsDeleted: idle.sessionsDeleted,
      itemsDeleted: idle.itemsDeleted + noise.itemsDeleted,
    };
    logger.debug(
      `retention: ${result.sessionsDeleted} sessions, ${result.itemsDeleted} records deleted`,
      result,
    );
    return result;
  }

  async function tick(): Promise<void> {
    try {
      await prune();
    } catch (error) {
      logger.error(`retention failed: ${error instanceof Error ? error.message : String(error)}`, {
        error,
      });
    }
  }

  return {
    prune,
    start() {
      if (timer !== null || (maxIdleMs === null && noiseMaxAgeMs === null)) {
        return;
      }
      timer = setInterval(() => {
        void tick();
      }, INTERVAL_MS);
      timer.unref();
    },
    stop() {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}

export { createRetention };
export type { PruneResult, Retention, RetentionDeps };
