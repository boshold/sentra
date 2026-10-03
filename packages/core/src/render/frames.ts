import type { Frame } from "#src/types.js";
import { fenceFor, sanitizeText, singleLine } from "#src/util/text.js";

const DEFAULT_MAX_IN_APP = 5;

function position(lineno: number | null, colno: number | null, marker: string): string {
  if (lineno === null) {
    return "";
  }
  return colno === null ? `:${marker}${lineno}` : `:${marker}${lineno}:${colno}`;
}

function formatFrameLocation(frame: Frame): string {
  const { mapped } = frame;
  if (mapped !== null) {
    return singleLine(`${mapped.source}${position(mapped.lineno, mapped.colno, "")}`);
  }
  const file = frame.absPath ?? frame.filename ?? "<unknown>";
  const marker = frame.positionReliable ? "" : "~";
  return singleLine(`${file}${position(frame.lineno, frame.colno, marker)}`);
}

function functionName(frame: Frame): string {
  return singleLine(frame.mapped?.function ?? frame.function ?? "<anonymous>");
}

/** Crashing frame first; frames are treated as in-app when none is. */
function crashFirst(frames: Frame[]): {
  frames: Frame[];
  hasInApp: boolean;
  isInApp: (frame: Frame) => boolean;
} {
  const reversed = frames.toReversed();
  const hasInApp = reversed.some((frame) => frame.inApp);
  return { frames: reversed, hasInApp, isInApp: (frame) => !hasInApp || frame.inApp };
}

/** CLI style, crashing frame first, without indentation. */
function renderFrameLines(frames: Frame[], options: { maxInApp?: number } = {}): string[] {
  const maxInApp = options.maxInApp ?? DEFAULT_MAX_IN_APP;
  const ordered = crashFirst(frames);
  const printed = ordered.frames.filter(ordered.isInApp).slice(0, maxInApp);
  const names = printed.map(functionName);
  const width = Math.max(0, ...names.map((name) => name.length));
  const lines = printed.map(
    (frame, index) => `at ${(names[index] ?? "").padEnd(width)}  ${formatFrameLocation(frame)}`,
  );
  const rest = ordered.frames.filter((frame) => !printed.includes(frame));
  if (rest.length > 0) {
    const suffix = ordered.hasInApp && rest.every((frame) => !frame.inApp) ? " (library)" : "";
    lines.push(`… ${rest.length} more frames${suffix}`);
  }
  return lines;
}

function contextBlock(frame: Frame): string[] {
  if (!frame.positionReliable) {
    return [];
  }
  const source = frame.mapped ?? frame;
  const { contextLine, lineno, preContext, postContext } = source;
  if (contextLine === null || lineno === null) {
    return [];
  }
  const entries = [
    ...preContext.map((text, index) => ({
      n: lineno - preContext.length + index,
      text,
      marker: " ",
    })),
    { n: lineno, text: contextLine, marker: ">" },
    ...postContext.map((text, index) => ({ n: lineno + 1 + index, text, marker: " " })),
  ];
  const width = String(Math.max(...entries.map((entry) => entry.n))).length;
  const body = entries.map((entry) =>
    `${entry.marker} ${String(entry.n).padStart(width)} | ${entry.text}`.trimEnd(),
  );
  const fence = fenceFor(body);
  return [fence, ...body, fence];
}

/** MCP style, crashing frame first, library runs collapsed. */
function renderStackMarkdown(frames: Frame[]): string {
  const ordered = crashFirst(frames);
  const lines: string[] = [];
  let libraryRun = 0;
  function flushLibrary(): void {
    if (libraryRun > 0) {
      lines.push(`… ${libraryRun} library frame${libraryRun === 1 ? "" : "s"}`);
      libraryRun = 0;
    }
  }
  for (const frame of ordered.frames) {
    if (!ordered.isInApp(frame)) {
      libraryRun += 1;
      continue;
    }
    flushLibrary();
    lines.push(`at ${functionName(frame)} (${formatFrameLocation(frame)})`, ...contextBlock(frame));
  }
  flushLibrary();
  return sanitizeText(lines.join("\n"));
}

export { formatFrameLocation, renderFrameLines, renderStackMarkdown };
