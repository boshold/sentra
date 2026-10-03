import {
  DEFAULT_MAX_ATTACHMENT_BYTES,
  DEFAULT_MAX_ENVELOPE_BYTES,
  DEFAULT_MAX_IDLE,
  DEFAULT_MAX_ITEMS,
  DEFAULT_NOISE_MAX_AGE,
  VERSION,
  buildDsn,
} from "@boshold/sentra-core";
import { cli, command } from "cleye";
import type { Flags, Renderers } from "cleye";

import {
  CliUsageError,
  DEFAULT_PORT,
  dsnSchema,
  formatSize,
  resolveStartConfig,
  usageError,
} from "#src/config.js";
import type { StartConfig } from "#src/config.js";
import { start } from "#src/server.js";

const startFlags = {
  host: { type: String, description: "Bind address (default 127.0.0.1)" },
  port: {
    type: Number,
    alias: "p",
    description: `Port, 0 = random free port (default ${DEFAULT_PORT})`,
  },
  publicUrl: {
    type: String,
    description: "Base URL for printed DSNs (default http://127.0.0.1:<port>)",
  },
  storage: { type: String, description: "memory | sqlite (default sqlite)" },
  db: { type: String, description: "SQLite file (default $XDG_DATA_HOME/sentra/sentra.db)" },
  sqliteDriver: { type: String, description: "auto | better-sqlite3 | node (default auto)" },
  maxItems: {
    type: Number,
    description: `Memory storage record cap (default ${DEFAULT_MAX_ITEMS})`,
  },
  retention: {
    type: String,
    description: `Session idle time before deletion, or never (default ${DEFAULT_MAX_IDLE})`,
  },
  noiseRetention: {
    type: String,
    description: `Max age of span/transaction/log/other records, or never (default ${DEFAULT_NOISE_MAX_AGE})`,
  },
  maxBody: {
    type: String,
    description: `Max envelope size (default ${formatSize(DEFAULT_MAX_ENVELOPE_BYTES)})`,
  },
  maxAttachment: {
    type: String,
    description: `Max stored attachment size (default ${formatSize(DEFAULT_MAX_ATTACHMENT_BYTES)})`,
  },
  noRaw: { type: Boolean, description: "Do not keep raw envelope bodies" },
  noSourceMaps: { type: Boolean, description: "Disable source mapping" },
  sourceMapHost: { type: [String], description: "Extra allowed host for HTTP source-map fetches" },
  sourceRoot: {
    type: [String],
    description: "Allowed root for FS source-map lookups (default cwd)",
  },
  allowedHost: { type: [String], description: "Extra allowed Host/Origin for query API and MCP" },
  noApi: { type: Boolean, description: "Disable /api/sentra" },
  noMcp: { type: Boolean, description: "Disable /mcp" },
  show: {
    type: String,
    description: "Kinds printed live, comma list or all (default error,message,log)",
  },
  minLevel: { type: String, description: "Min level printed live" },
  project: { type: String, description: "Limit live output to this project" },
  session: { type: String, description: "Limit live output to this session" },
  service: { type: String, description: "Limit live output to this service" },
  format: { type: String, description: "pretty | json (default pretty)" },
  quiet: { type: Boolean, alias: "q", description: "No live output" },
  noColor: { type: Boolean, description: "Disable colors" },
  logLevel: { type: String, description: "error | warn | info | debug (default warn)" },
} satisfies Flags;

const dsnFlags = {
  project: { type: String, description: "Project segment" },
  session: { type: String, description: "Session segment" },
  service: { type: String, description: "Service segment" },
  publicUrl: { type: String, description: `Base URL (default http://127.0.0.1:${DEFAULT_PORT})` },
} satisfies Flags;

/** Plain help when stdout is not a terminal; ansis already handles `NO_COLOR`. */
function renderHelp(nodes: Parameters<Renderers["render"]>[0], renderers: Renderers): string {
  if (!process.stdout.isTTY && process.env.FORCE_COLOR === undefined) {
    renderers.bold = (text: string) => text.toLocaleUpperCase();
  }
  return renderers.render(nodes);
}

function runDsn(flags: unknown): number {
  const parsed = dsnSchema.safeParse(flags ?? {});
  if (!parsed.success) {
    throw usageError(parsed.error);
  }
  const { publicUrl, project, session, service } = parsed.data;
  process.stdout.write(`${buildDsn({ baseUrl: publicUrl, project, session, service })}\n`);
  return 0;
}

function checkLeftovers(parsed: { unknownFlags: Record<string, unknown>; _: string[] }): void {
  const unknown = Object.keys(parsed.unknownFlags);
  if (unknown.length > 0) {
    throw new CliUsageError(
      `unknown flag ${unknown.map((name) => (name.length === 1 ? `-${name}` : `--${name}`)).join(", ")}`,
    );
  }
  if (parsed._.length > 0) {
    throw new CliUsageError(`unexpected argument ${parsed._.join(" ")}`);
  }
}

async function runCli(
  argv: string[],
  deps: { start?: (config: StartConfig) => Promise<void> } = {},
): Promise<number> {
  try {
    const parsed = cli(
      {
        name: "sentra",
        version: VERSION,
        flags: startFlags,
        help: { render: renderHelp },
        commands: [
          command({
            name: "start",
            flags: startFlags,
            help: { description: "Start the server (default)", render: renderHelp },
          }),
          command({
            name: "dsn",
            flags: dsnFlags,
            help: { description: "Print a DSN", render: renderHelp },
          }),
        ],
      },
      undefined,
      [...argv],
    );
    checkLeftovers(parsed);
    if (parsed.command === "dsn") {
      return runDsn(parsed.flags);
    }
    const config = resolveStartConfig(parsed.flags, process.env, process.cwd());
    await (deps.start ?? start)(config);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`sentra: ${message}\n`);
    return error instanceof CliUsageError ? 2 : 1;
  }
}

export {
  CliRuntimeError,
  CliUsageError,
  createStderrLogger,
  defaultDbPath,
  isLoopbackHost,
  isUnspecifiedHost,
  lanAddresses,
  resolveStartConfig,
  toSentraOptions,
} from "#src/config.js";
export type { StartConfig } from "#src/config.js";
export { runCli };
