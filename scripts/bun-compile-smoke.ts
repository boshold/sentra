import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { literal, number, object, string } from "zod";

const ROOT = path.resolve(import.meta.dirname, "..");
const HOST = path.join(ROOT, "test/fixtures/bun-compile/host.ts");

const outputSchema = object({
  storage: object({ type: literal("sqlite"), driver: string(), path: string() }),
  issues: number(),
});

function fail(message: string): never {
  process.stderr.write(`bun-compile-smoke: ${message}\n`);
  process.exit(1);
}

function bunAvailable(): boolean {
  const probe = spawnSync("bun", ["--version"], { encoding: "utf8" });
  return probe.error === undefined && probe.status === 0;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return fail(`binary printed no JSON:\n${text}`);
  }
}

function lastLine(text: string): string {
  return text.trim().split("\n").at(-1) ?? "";
}

if (!bunAvailable()) {
  if (process.env.CI) {
    fail("bun not found on PATH");
  }
  process.stdout.write("skipped: bun not found\n");
  process.exit(0);
}

const dir = mkdtempSync(path.join(tmpdir(), "sentra-bun-smoke-"));
try {
  const binary = path.join(dir, "sentra-smoke");
  const build = spawnSync(
    "bun",
    [
      "build",
      "--compile",
      "--bytecode",
      "--format=esm",
      "--external",
      "better-sqlite3",
      "--outfile",
      binary,
      HOST,
    ],
    { cwd: ROOT, encoding: "utf8" },
  );
  if (build.status !== 0) {
    fail(`compilation failed (exit ${build.status}):\n${build.stderr}${build.stdout}`);
  }

  // From `/` the external better-sqlite3 cannot resolve from the repo's node_modules.
  const run = spawnSync(binary, [path.join(dir, "smoke.db")], { cwd: "/", encoding: "utf8" });
  if (run.status !== 0) {
    fail(`binary exited with ${run.status}:\n${run.stderr}${run.stdout}`);
  }

  const parsed = outputSchema.safeParse(parseJson(lastLine(run.stdout)));
  if (!parsed.success) {
    fail(`unexpected output ${lastLine(run.stdout)}: ${parsed.error.message}`);
  }
  const { storage, issues } = parsed.data;
  if (storage.driver !== "node") {
    fail(`expected driver "node", got "${storage.driver}"`);
  }
  if (issues !== 1) {
    fail(`expected 1 issue, got ${issues}`);
  }
  process.stdout.write(`${lastLine(run.stdout)}\n`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
