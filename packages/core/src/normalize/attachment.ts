import { looseObject, string } from "zod";

import { lenient, normalizeEventId, truncate } from "#src/normalize/schemas.js";
import { baseSummary } from "#src/normalize/summary.js";
import type { NewItem, NormalizeContext } from "#src/normalize/types.js";
import type { ParsedItem } from "#src/parse/envelope.js";
import type { AttachmentData } from "#src/types.js";

const TITLE_MAX = 500;
const DEFAULT_FILENAME = "attachment";

const attachmentHeaderSchema = looseObject({
  filename: lenient(string()),
  content_type: lenient(string()),
  attachment_type: lenient(string()),
});

function normalizeAttachment(item: ParsedItem, ctx: NormalizeContext): NewItem {
  const header = attachmentHeaderSchema.parse(item.header);
  const size = item.payload.byteLength;
  const stored = size <= ctx.maxAttachmentBytes;
  const data: AttachmentData = {
    filename: header.filename ?? DEFAULT_FILENAME,
    contentType: header.content_type ?? null,
    attachmentType: header.attachment_type ?? null,
    size,
    stored,
  };
  const summary = baseSummary(ctx, {
    itemType: "attachment",
    timestamp: ctx.receivedAt,
    eventId: normalizeEventId(ctx.envelopeHeader.event_id),
    title: truncate(data.filename, TITLE_MAX),
  });
  return {
    item: { ...summary, kind: "attachment", data },
    blob: stored ? item.payload : null,
    grouping: null,
    warnings: [],
  };
}

export { normalizeAttachment };
