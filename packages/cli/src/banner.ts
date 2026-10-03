import path from "node:path";

import { buildDsn } from "@boshold/sentra-core";

import { isUnspecifiedHost } from "#src/config.js";

interface BannerInput {
  version: string;
  host: string;
  port: number;
  publicUrl: string;
  storage: { type: "memory" | "sqlite"; driver: string | null; path: string | null };
  /** `sentra.info().retention`, e.g. `30d idle, noise 7d`. */
  retention: string;
  maxItems: number;
  api: boolean;
  mcp: boolean;
  lanAddresses: string[];
  homeDir: string;
}

const LABEL_WIDTH = 14;

function line(label: string, value: string): string {
  return `${label.padEnd(LABEL_WIDTH)}${value}`;
}

function urlHost(host: string): string {
  return host.includes(":") ? `[${host}]` : host;
}

function shortenHome(file: string, homeDir: string): string {
  if (homeDir === "" || homeDir === path.sep) {
    return file;
  }
  if (file === homeDir) {
    return "~";
  }
  return file.startsWith(`${homeDir}${path.sep}`) ? `~${file.slice(homeDir.length)}` : file;
}

function storageLine(input: BannerInput): string {
  const { storage, retention } = input;
  if (storage.type === "memory") {
    return `memory (max ${input.maxItems} items, retention: ${retention})`;
  }
  const details = [
    storage.driver === null ? null : `driver: ${storage.driver}`,
    `retention: ${retention}`,
  ]
    .filter((part) => part !== null)
    .join(", ");
  const file = storage.path === null ? "" : ` ${shortenHome(storage.path, input.homeDir)}`;
  return `sqlite${file} (${details})`;
}

/** Plain banner lines (no colors). */
function renderBanner(input: BannerInput): string[] {
  const listenUrl = `http://${urlHost(input.host)}:${input.port}`;
  const wildcard = isUnspecifiedHost(input.host);
  const dsn = buildDsn({ baseUrl: input.publicUrl });
  const lines = [
    `sentra ${input.version}  listening on ${listenUrl}`,
    line("storage", storageLine(input)),
    line("DSN", dsn),
    ...(wildcard
      ? input.lanAddresses.map((address) =>
          line("DSN", buildDsn({ baseUrl: `http://${urlHost(address)}:${input.port}` })),
        )
      : []),
    line("scoped DSN", `${dsn.slice(0, -"/1".length)}/<project>/<session>/<service>/1`),
    ...(input.api ? [line("query API", `${listenUrl}/api/sentra`)] : []),
    ...(input.mcp ? [line("MCP", `${listenUrl}/mcp`)] : []),
    ...(wildcard
      ? [
          line(
            "warning",
            "ingest is reachable from the network; query API/MCP need --allowed-host <ip>",
          ),
        ]
      : []),
  ];
  return lines;
}

export { renderBanner };
export type { BannerInput };
