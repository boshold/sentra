import { int, object } from "zod";

import type { Connection } from "#src/storage/sqlite/connection.js";
import {
  ENVELOPE_COLUMNS,
  ITEM_COLUMNS,
  envelopeToRow,
  itemToRow,
  toMs,
} from "#src/storage/sqlite/rows.js";
import type { IngestBatch } from "#src/storage/types.js";

const issueCountRowSchema = object({ count: int() });

export function writeBatch(
  { statements }: Connection,
  batch: IngestBatch,
): { issues: { id: string; isNew: boolean; count: number }[] } {
  const { envelope } = batch;
  const receivedAt = toMs(envelope.receivedAt);
  statements.touchScope.run(
    envelope.scope.project,
    envelope.scope.session,
    envelope.scope.service,
    receivedAt,
    receivedAt,
    batch.items.length,
  );
  const envelopeRow = envelopeToRow(envelope);
  statements.insertEnvelope.run(...ENVELOPE_COLUMNS.map((column) => envelopeRow[column]));
  for (const { item, blob } of batch.items) {
    const itemRow = itemToRow(item);
    statements.insertItem.run(...ITEM_COLUMNS.map((column) => itemRow[column]));
    if (blob !== null) {
      statements.insertBlob.run(item.id, blob);
    }
  }
  const issues = batch.issues.map((entry) => {
    const previous = issueCountRowSchema
      .optional()
      .parse(statements.selectIssueCount.get(entry.id));
    const seenAt = toMs(entry.seenAt);
    statements.upsertIssue.run(
      entry.id,
      entry.project,
      entry.session,
      entry.kind,
      JSON.stringify(entry.fingerprint),
      entry.fingerprintHash,
      entry.title,
      entry.culprit,
      entry.level,
      entry.platform,
      seenAt,
      seenAt,
      entry.itemId,
    );
    return previous === undefined
      ? { id: entry.id, isNew: true, count: 1 }
      : { id: entry.id, isNew: false, count: previous.count + 1 };
  });
  return { issues };
}
