import { normalizeAttachment } from "#src/normalize/attachment.js";

import { bytes, context, fixtureEnvelope, fixtureItem, rawItem } from "./helpers.js";

describe("normalizeAttachment", () => {
  it("keeps binary payloads with newlines as blob", () => {
    const payload = bytes("a\nb", new Uint8Array([0, 0xff, 0x0a]));
    const { item, blob } = normalizeAttachment(
      rawItem("attachment", payload, {
        filename: "dump.bin",
        content_type: "application/octet-stream",
        attachment_type: "event.minidump",
      }),
      context({ envelopeHeader: { event_id: "5DE6E5B4-C2D5-4107-B369-E4AD5A6909CD" } }),
    );
    expect(blob).toEqual(payload);
    expect(item).toMatchObject({
      kind: "attachment",
      itemType: "attachment",
      title: "dump.bin",
      level: null,
      eventId: "5de6e5b4c2d54107b369e4ad5a6909cd",
      timestamp: "2026-10-03T12:00:00.000Z",
      data: {
        filename: "dump.bin",
        contentType: "application/octet-stream",
        attachmentType: "event.minidump",
        size: 6,
        stored: true,
      },
    });
  });

  it("does not store payloads above maxAttachmentBytes", () => {
    const { item, blob } = normalizeAttachment(
      rawItem("attachment", "12345"),
      context({ maxAttachmentBytes: 4 }),
    );
    expect(blob).toBeNull();
    expect(item.kind === "attachment" && item.data).toMatchObject({ size: 5, stored: false });
  });

  it("stores the empty attachment fixture", () => {
    const { item, blob } = normalizeAttachment(
      fixtureItem("node-empty-attachment", "attachment"),
      context(),
    );
    expect(item.kind === "attachment" && item.data).toMatchObject({ size: 0, stored: true });
    expect(blob?.byteLength).toBe(0);
  });

  it("reads the Node attachment fixture", () => {
    const envelope = fixtureEnvelope("node-attachment");
    const { item, blob } = normalizeAttachment(
      fixtureItem("node-attachment", "attachment"),
      context({ envelopeHeader: envelope.header }),
    );
    expect(item).toMatchObject({
      title: "a.txt",
      eventId: "a92e3187891e48d383e4222471890efa",
      data: {
        filename: "a.txt",
        contentType: "text/plain",
        attachmentType: null,
        size: 12,
        stored: true,
      },
    });
    expect(new TextDecoder().decode(blob ?? new Uint8Array())).toBe("line1\nline2\n");
  });

  it("defaults the filename", () => {
    const { item } = normalizeAttachment(rawItem("attachment", "x", { filename: 5 }), context());
    expect(item.title).toBe("attachment");
    expect(item.eventId).toBeNull();
  });
});
