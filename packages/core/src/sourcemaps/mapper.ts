import { fileURLToPath } from "node:url";

import {
  GREATEST_LOWER_BOUND,
  LEAST_UPPER_BOUND,
  TraceMap,
  originalPositionFor,
  sourceContentFor,
} from "@jridgewell/trace-mapping";
import type { Bias } from "@jridgewell/trace-mapping";

import type { RawSourceMap } from "#src/sourcemaps/extract.js";
import { toDisplaySource } from "#src/sourcemaps/paths.js";
import type { Frame, MappedLocation } from "#src/types.js";

/** Line 1-based, column 0-based (trace-mapping convention). */
interface OriginalPosition {
  source: string;
  line: number;
  column: number;
}

interface ContextLines {
  contextLine: string | null;
  preContext: string[];
  postContext: string[];
}

interface Budget {
  remainingMs(): number;
  exceeded(): boolean;
}

interface MapFrameDeps {
  roots: readonly string[];
  readSource: (absPath: string) => Promise<string | null>;
}

const CONTEXT_LINES = 5;
const MAX_CONTEXT_LINE_LENGTH = 300;
const BIASES: readonly Bias[] = [GREATEST_LOWER_BOUND, LEAST_UPPER_BOUND];

function createBudget(budgetMs: number, now: () => number = () => performance.now()): Budget {
  const start = now();
  const remainingMs = (): number => Math.max(0, budgetMs - (now() - start));
  return { remainingMs, exceeded: () => remainingMs() <= 0 };
}

function createTraceMap(map: RawSourceMap, sourcesBase: string): TraceMap {
  return new TraceMap(map, sourcesBase);
}

/** Sentry `colno` is 1-based; trace-mapping wants a 0-based column. */
function findOriginalPosition(
  traceMap: TraceMap,
  lineno: number,
  colno: number | null,
): OriginalPosition | null {
  if (!Number.isInteger(lineno) || lineno < 1) {
    return null;
  }
  const column = colno === null ? 0 : Math.max(0, colno - 1);
  for (const bias of BIASES) {
    const position = originalPositionFor(traceMap, { line: lineno, column, bias });
    if (position.source !== null && position.line !== null) {
      return { source: position.source, line: position.line, column: position.column };
    }
  }
  return null;
}

function truncate(line: string): string {
  return line.length > MAX_CONTEXT_LINE_LENGTH ? line.slice(0, MAX_CONTEXT_LINE_LENGTH) : line;
}

function extractContext(content: string, lineno: number): ContextLines {
  const lines = content.split(/\r?\n/);
  const index = lineno - 1;
  const current = Number.isInteger(lineno) ? lines[index] : undefined;
  if (current === undefined || index < 0) {
    return { contextLine: null, preContext: [], postContext: [] };
  }
  return {
    contextLine: truncate(current),
    preContext: lines.slice(Math.max(0, index - CONTEXT_LINES), index).map(truncate),
    postContext: lines.slice(index + 1, index + 1 + CONTEXT_LINES).map(truncate),
  };
}

function filePathOf(source: string): string | null {
  if (!source.startsWith("file:")) {
    return null;
  }
  try {
    return fileURLToPath(source);
  } catch {
    return null;
  }
}

async function mapFrame(
  frame: Pick<Frame, "lineno" | "colno">,
  traceMap: TraceMap,
  deps: MapFrameDeps,
): Promise<MappedLocation | null> {
  if (frame.lineno === null) {
    return null;
  }
  const position = findOriginalPosition(traceMap, frame.lineno, frame.colno);
  if (position === null) {
    return null;
  }
  const filePath = filePathOf(position.source);
  let content = sourceContentFor(traceMap, position.source);
  if (content === null && filePath !== null) {
    content = await deps.readSource(filePath);
  }
  const context =
    content === null
      ? { contextLine: null, preContext: [], postContext: [] }
      : extractContext(content, position.line);
  return {
    source: toDisplaySource(position.source, deps.roots),
    absPath: filePath ?? (/^https?:\/\//i.test(position.source) ? position.source : null),
    lineno: position.line,
    colno: frame.colno === null ? null : position.column + 1,
    function: null,
    ...context,
  };
}

export {
  CONTEXT_LINES,
  MAX_CONTEXT_LINE_LENGTH,
  createBudget,
  createTraceMap,
  extractContext,
  findOriginalPosition,
  mapFrame,
};
export type { Budget, ContextLines, MapFrameDeps, OriginalPosition };
