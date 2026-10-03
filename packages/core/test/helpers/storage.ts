import { memoryStorage } from "#src/storage/memory/index.js";
import type { StorageAdapter } from "#src/storage/types.js";

interface StorageOverrides {
  write?: (
    inner: StorageAdapter,
    batch: Parameters<StorageAdapter["write"]>[0],
  ) => ReturnType<StorageAdapter["write"]>;
  getItem?: (inner: StorageAdapter, id: string) => ReturnType<StorageAdapter["getItem"]>;
}

/** Memory storage with replaceable `write` / `getItem`. */
function storageWith(
  overrides: StorageOverrides,
  inner: StorageAdapter = memoryStorage(),
): StorageAdapter {
  const { write, getItem } = overrides;
  return {
    type: inner.type,
    init: async () => inner.init(),
    write: async (batch) => (write === undefined ? inner.write(batch) : write(inner, batch)),
    listScopes: async (filter) => inner.listScopes(filter),
    listIssues: async (filter, page) => inner.listIssues(filter, page),
    findIssues: async (prefix, scope) => inner.findIssues(prefix, scope),
    getIssue: async (id) => inner.getIssue(id),
    listItems: async (filter, page) => inner.listItems(filter, page),
    getItem: async (id) => (getItem === undefined ? inner.getItem(id) : getItem(inner, id)),
    getItemByEventId: async (eventId) => inner.getItemByEventId(eventId),
    getBlob: async (itemId) => inner.getBlob(itemId),
    getEnvelope: async (id) => inner.getEnvelope(id),
    listFailedEnvelopes: async (filter, page) => inner.listFailedEnvelopes(filter, page),
    deleteItems: async (filter) => inner.deleteItems(filter),
    pruneIdleSessions: async (cutoff) => inner.pruneIdleSessions(cutoff),
    pruneOldItems: async (kinds, cutoff) => inner.pruneOldItems(kinds, cutoff),
    vacuum: async () => inner.vacuum(),
    close: async () => inner.close(),
  };
}

export { storageWith };
