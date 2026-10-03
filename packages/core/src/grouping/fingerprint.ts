import { createHash } from "node:crypto";

import { truncate } from "#src/normalize/schemas.js";
import type { GroupingInput } from "#src/normalize/types.js";
import type { EventData, Frame, Scope } from "#src/types.js";

type GroupingKind = "error" | "message";

interface GroupingRequest {
  scope: Scope;
  kind: GroupingKind;
  data: EventData;
  grouping: GroupingInput;
}

interface GroupingResult {
  fingerprint: string[];
  fingerprintHash: string;
  issueId: string;
  title: string;
  culprit: string | null;
}

const MAX_FRAMES = 30;
const ISSUE_TITLE_MAX = 200;
const UNKNOWN_TITLE = "<unknown error>";
const DEFAULT_TYPE = "Error";
const DEFAULT_MARKERS: ReadonlySet<string> = new Set(["{{ default }}", "{{default}}"]);

const UUID_PATTERN = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const HEX_PATTERN = /\b(?:0x)?[0-9a-f]{8,}\b/gi;
const NUMBER_PATTERN = /\d+(?:\.\d+)?/g;
const SCHEME_PATTERN = /^[a-z][a-z\d+.-]*:\/\//i;
const QUERY_OR_HASH_PATTERN = /[?#].*$/s;
const LINE_BREAK_PATTERN = /\r?\n/;

function sha1(text: string): string {
  return createHash("sha1").update(text).digest("hex");
}

function normalizeText(text: string): string {
  return text
    .replace(UUID_PATTERN, "<id>")
    .replace(HEX_PATTERN, "<id>")
    .replace(NUMBER_PATTERN, "<n>");
}

function decodePath(path: string): string {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

function normPath(frame: Frame): string {
  if (frame.mapped !== null) {
    return frame.mapped.source;
  }
  const location = frame.absPath ?? frame.filename;
  if (location === null) {
    return "?";
  }
  if (SCHEME_PATTERN.test(location) && URL.canParse(location)) {
    return decodePath(new URL(location).pathname);
  }
  return location.replace(QUERY_OR_HASH_PATTERN, "");
}

function frameFunction(frame: Frame): string | null {
  return frame.mapped?.function ?? frame.function;
}

function groupingFrames(frames: Frame[]): Frame[] {
  const inApp = frames.filter((frame) => frame.inApp);
  return (inApp.length > 0 ? inApp : frames).slice(-MAX_FRAMES);
}

function defaultComponents(
  kind: GroupingKind,
  data: EventData,
  messageTemplate: string | null,
): string[] {
  if (kind === "message") {
    return [normalizeText(messageTemplate ?? data.message ?? "")];
  }
  const primary = data.exceptions.at(-1);
  const type = primary?.type ?? DEFAULT_TYPE;
  const frames = groupingFrames(primary?.frames ?? []);
  if (frames.length === 0) {
    return [type, normalizeText(primary?.value ?? "")];
  }
  return [type, ...frames.map((frame) => `${normPath(frame)}:${frameFunction(frame) ?? "?"}`)];
}

function resolveComponents(kind: GroupingKind, data: EventData, grouping: GroupingInput): string[] {
  const defaults = defaultComponents(kind, data, grouping.messageTemplate);
  const custom = grouping.payloadFingerprint;
  if (custom === null || custom.length === 0) {
    return defaults;
  }
  return custom.flatMap((entry) => (DEFAULT_MARKERS.has(entry) ? defaults : [entry]));
}

function rawTitle(kind: GroupingKind, data: EventData): string {
  if (kind === "message") {
    return (data.message ?? "").split(LINE_BREAK_PATTERN).find((line) => line.trim() !== "") ?? "";
  }
  const primary = data.exceptions.at(-1);
  return [primary?.type, primary?.value]
    .filter((part): part is string => typeof part === "string" && part !== "")
    .join(": ");
}

function resolveTitle(kind: GroupingKind, data: EventData): string {
  const title = rawTitle(kind, data);
  return title === "" ? UNKNOWN_TITLE : truncate(title, ISSUE_TITLE_MAX);
}

function crashingFrame(frames: Frame[]): Frame | undefined {
  return frames.findLast((frame) => frame.inApp) ?? frames.at(-1);
}

function resolveCulprit(kind: GroupingKind, data: EventData): string | null {
  if (data.culprit !== null && data.culprit !== "") {
    return data.culprit;
  }
  if (data.transaction !== null) {
    return data.transaction;
  }
  const frames = kind === "error" ? (data.exceptions.at(-1)?.frames ?? []) : data.stacktrace;
  const frame = crashingFrame(frames);
  if (frame === undefined) {
    return null;
  }
  const source = normPath(frame);
  const line = frame.mapped?.lineno ?? frame.lineno;
  const location = line === null ? source : `${source}:${line}`;
  return `${frameFunction(frame) ?? "?"} (${location})`;
}

function computeGrouping({ scope, kind, data, grouping }: GroupingRequest): GroupingResult {
  const fingerprint = resolveComponents(kind, data, grouping);
  const fingerprintHash = sha1(fingerprint.join("\n"));
  const issueId = sha1(`${scope.project}\0${scope.session}\0${fingerprintHash}`).slice(0, 16);
  return {
    fingerprint,
    fingerprintHash,
    issueId,
    title: resolveTitle(kind, data),
    culprit: resolveCulprit(kind, data),
  };
}

export { computeGrouping, defaultComponents, normalizeText, normPath };
export type { GroupingKind, GroupingRequest, GroupingResult };
