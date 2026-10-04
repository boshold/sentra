import { styleText } from "node:util";
import type { InspectColor } from "node:util";

import {
  firstLine,
  formatAttributes,
  formatDuration,
  formatScope,
  renderFrameLines,
  sanitizeText,
} from "@bosdev/sentra-core";
import type { Frame, Item, Level, LiveEvent, Scope } from "@bosdev/sentra-core";

interface PrettyOptions {
  color: boolean;
  stream?: NodeJS.WritableStream;
}

type Paint = (format: InspectColor, text: string) => string;

const LABEL_WIDTH = 5;
const MAX_IN_APP = 5;
const MAX_ATTRIBUTES = 120;

const LEVEL_LABELS: Record<Level, string> = {
  fatal: "FATAL",
  error: "ERROR",
  warning: "WARN",
  info: "INFO",
  debug: "DEBUG",
  trace: "TRACE",
};

const LABEL_COLORS: Record<string, InspectColor> = {
  FATAL: "red",
  ERROR: "red",
  BAD: "red",
  WARN: "yellow",
  INFO: "blue",
  DEBUG: "gray",
  TRACE: "gray",
  TXN: "magenta",
  ITEM: "gray",
};

function painter(options: PrettyOptions): Paint {
  if (!options.color) {
    return (_format, text) => text;
  }
  const stream = options.stream ?? process.stdout;
  return (format, text) => styleText(format, text, { stream });
}

function clock(iso: string): string {
  const date = new Date(iso);
  return [date.getHours(), date.getMinutes(), date.getSeconds()]
    .map((part) => String(part).padStart(2, "0"))
    .join(":");
}

function head(paint: Paint, time: string, label: string, scope: Scope): string {
  const color = LABEL_COLORS[label] ?? "gray";
  const padded = `${paint(color, label)}${" ".repeat(Math.max(0, LABEL_WIDTH - label.length))}`;
  return `${paint("dim", clock(time))} ${padded} ${formatScope(scope)}`;
}

function humanSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function eventFrames(item: Extract<Item, { kind: "error" | "message" }>): Frame[] {
  if (item.kind === "message" && item.data.stacktrace.length > 0) {
    return item.data.stacktrace;
  }
  return item.data.exceptions.at(-1)?.frames ?? item.data.stacktrace;
}

function issueFooter(
  paint: Paint,
  item: Item,
  issue: { id: string; isNew: boolean; count: number },
): string {
  const parts = [
    `issue ${issue.id.slice(0, 8)}${issue.isNew ? ` ${paint("green", "NEW")}` : ""}`,
    `${issue.count}×`,
    item.environment === null ? null : `env ${sanitizeText(item.environment)}`,
    item.release === null ? null : `release ${sanitizeText(item.release)}`,
  ];
  return `  ${parts.filter((part) => part !== null).join(" · ")}`;
}

function itemLines(
  paint: Paint,
  item: Item,
  issue: { id: string; isNew: boolean; count: number } | null,
): string[] {
  switch (item.kind) {
    case "error":
    case "message": {
      const label = LEVEL_LABELS[item.level ?? (item.kind === "error" ? "error" : "info")];
      const frames = renderFrameLines(eventFrames(item), { maxInApp: MAX_IN_APP }).map(
        (frameLine) => `  ${paint("dim", frameLine)}`,
      );
      return [
        `${head(paint, item.receivedAt, label, item.scope)}  ${firstLine(item.title)}`,
        ...frames,
        ...(issue === null ? [] : [issueFooter(paint, item, issue)]),
      ];
    }
    case "transaction":
    case "span": {
      const parts = [
        firstLine(item.data.name),
        formatDuration(item.data.durationMs),
        item.data.status === null ? null : firstLine(item.data.status),
      ].filter((part) => part !== null);
      return [`${head(paint, item.receivedAt, "TXN", item.scope)}  ${parts.join("  ")}`];
    }
    case "log": {
      const label = LEVEL_LABELS[item.level ?? "info"];
      const attributes = formatAttributes(
        Object.fromEntries(
          Object.entries(item.data.attributes).filter(([key]) => !key.startsWith("sentry.")),
        ),
        MAX_ATTRIBUTES,
      );
      const rest =
        attributes === ""
          ? firstLine(item.data.body)
          : `${firstLine(item.data.body)}  ${attributes}`;
      return [`${head(paint, item.receivedAt, label, item.scope)}  ${rest}`];
    }
    case "attachment":
    case "other": {
      return [
        `${head(paint, item.receivedAt, "ITEM", item.scope)}  ${firstLine(item.itemType)} ${humanSize(item.data.size)}`,
      ];
    }
    default: {
      return item satisfies never;
    }
  }
}

/** Live output lines without trailing newline. */
function formatLiveEvent(event: LiveEvent, options: PrettyOptions): string[] {
  const paint = painter(options);
  if (event.type === "envelope.failed") {
    const { envelope } = event;
    return [
      `${head(paint, envelope.receivedAt, "BAD", envelope.scope)}  invalid envelope: ${firstLine(event.error)} (envelope ${envelope.id})`,
    ];
  }
  return itemLines(paint, event.item, event.issue);
}

export { formatLiveEvent };
export type { PrettyOptions };
