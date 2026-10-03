import type { Item, Scope } from "#src/types.js";

export interface NormalizeContext {
  scope: Scope;
  envelopeId: string;
  envelopeHeader: Record<string, unknown>;
  receivedAt: string;
  maxAttachmentBytes: number;
  allowedHosts: readonly string[];
  newId(): string;
}

export interface GroupingInput {
  payloadFingerprint: string[] | null;
  messageTemplate: string | null;
}

export interface NewItem {
  item: Item;
  blob: Uint8Array | null;
  grouping: GroupingInput | null;
  warnings: string[];
}

export type NormalizeResult = { ok: true; items: NewItem[] } | { ok: false; error: string };
