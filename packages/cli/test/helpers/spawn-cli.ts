import { execFile, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { object, record, string } from "zod";

import { loadEnvelopeFixture } from "../../../../test/fixtures/envelopes.js";

interface ExitResult {
  code: number | null;
  signal: NodeJS.Signals | null;
}

interface CliProcess {
  port: number;
  baseUrl: string;
  stdout(): string;
  stderr(): string;
  waitForStdout(pattern: RegExp, timeoutMs?: number): Promise<string>;
  waitForStderr(pattern: RegExp, timeoutMs?: number): Promise<string>;
  /** Idempotent; SIGKILL after 5 s if the process does not exit. */
  stop(signal?: NodeJS.Signals): Promise<ExitResult>;
}

const PACKAGE_DIR = path.resolve(import.meta.dirname, "../..");
const REPO_ROOT = path.resolve(PACKAGE_DIR, "../..");
const DEFAULT_TIMEOUT_MS = 5000;
const KILL_AFTER_MS = 5000;
const BANNER = /listening on http:\/\/(?<host>[^\s/]+):(?<port>\d+)/;

const packageSchema = object({ bin: record(string(), string()) });

/** Built entry from `bin.sentra` in package.json. */
function cliEntry(): string {
  const pkg = packageSchema.parse(
    JSON.parse(readFileSync(path.join(PACKAGE_DIR, "package.json"), "utf8")),
  );
  const bin = pkg.bin.sentra;
  if (bin === undefined) {
    throw new Error("package.json has no bin.sentra");
  }
  return path.join(PACKAGE_DIR, bin);
}

function newestMtime(dir: string): number {
  return Math.max(
    0,
    ...readdirSync(dir, { recursive: true, encoding: "utf8" }).map(
      (file) => statSync(path.join(dir, file)).mtimeMs,
    ),
  );
}

/** Runs `pnpm build` when the entry is missing or older than any source file. */
async function ensureBuilt(): Promise<void> {
  const entry = cliEntry();
  const sources = ["packages/core/src", "packages/cli/src"].map((dir) => path.join(REPO_ROOT, dir));
  const files = ["scripts/build.ts", "packages/core/package.json", "packages/cli/package.json"].map(
    (file) => path.join(REPO_ROOT, file),
  );
  let builtAt = 0;
  try {
    builtAt = statSync(entry).mtimeMs;
  } catch {
    builtAt = 0;
  }
  const newest = Math.max(
    ...sources.map((dir) => newestMtime(dir)),
    ...files.map((file) => statSync(file).mtimeMs),
  );
  if (newest < builtAt) {
    return;
  }
  await promisify(execFile)("pnpm", ["build"], { cwd: REPO_ROOT });
}

/** Private data dir so a test can never touch `~/.local/share`. */
const dataHome = mkdtempSync(path.join(tmpdir(), "sentra-e2e-home-"));
const live = new Set<ChildProcess>();

function childEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NO_COLOR: "1",
    TZ: "UTC",
    XDG_DATA_HOME: dataHome,
  };
  // FORCE_COLOR (set by test runners) beats NO_COLOR.
  delete env.FORCE_COLOR;
  return { ...env, ...overrides };
}

function launch(args: string[], env?: Record<string, string>): ChildProcess {
  const child = spawn(process.execPath, [cliEntry(), ...args], {
    env: childEnv(env),
    stdio: ["ignore", "pipe", "pipe"],
  });
  live.add(child);
  child.once("exit", () => {
    live.delete(child);
  });
  return child;
}

function collect(child: ChildProcess): { stdout: () => string; stderr: () => string } {
  let out = "";
  let err = "";
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    out += chunk;
  });
  child.stderr?.on("data", (chunk: string) => {
    err += chunk;
  });
  return { stdout: () => out, stderr: () => err };
}

function exitResult(child: ChildProcess): ExitResult | null {
  return child.exitCode === null && child.signalCode === null
    ? null
    : { code: child.exitCode, signal: child.signalCode };
}

async function waitForExit(child: ChildProcess): Promise<ExitResult> {
  const done = exitResult(child);
  if (done !== null) {
    return done;
  }
  return new Promise((resolve) => {
    child.once("exit", (code, signal) => {
      resolve({ code, signal });
    });
  });
}

async function waitForOutput(
  child: ChildProcess,
  streams: { stdout: () => string; stderr: () => string },
  which: "stdout" | "stderr",
  pattern: RegExp,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<string> {
  const stream = which === "stdout" ? child.stdout : child.stderr;
  return new Promise((resolve, reject) => {
    const cleanups: (() => void)[] = [];
    function settle(result: Error | string): void {
      for (const cleanup of cleanups.splice(0)) {
        cleanup();
      }
      if (result instanceof Error) {
        reject(result);
      } else {
        resolve(result);
      }
    }
    function failure(reason: string): Error {
      return new Error(
        `${reason} waiting for ${String(pattern)} on ${which}\n--- stdout ---\n${streams.stdout()}\n--- stderr ---\n${streams.stderr()}`,
      );
    }
    function check(): void {
      // Listeners run in registration order, so the collector has already appended this chunk.
      const match = pattern.exec(streams[which]());
      if (match !== null) {
        settle(match[0]);
      }
    }
    function onExit(): void {
      settle(failure("process exited"));
    }
    stream?.on("data", check);
    cleanups.push(() => stream?.off("data", check));
    child.once("exit", onExit);
    cleanups.push(() => child.off("exit", onExit));
    const deadline = setTimeout(() => {
      settle(failure(`timeout after ${timeoutMs} ms`));
    }, timeoutMs);
    cleanups.push(() => {
      clearTimeout(deadline);
    });
    check();
    if (cleanups.length > 0 && exitResult(child) !== null) {
      onExit();
    }
  });
}

async function stopChild(child: ChildProcess, signal: NodeJS.Signals): Promise<ExitResult> {
  const done = exitResult(child);
  if (done !== null) {
    return done;
  }
  const killer = setTimeout(() => {
    child.kill("SIGKILL");
  }, KILL_AFTER_MS);
  child.kill(signal);
  try {
    return await waitForExit(child);
  } finally {
    clearTimeout(killer);
  }
}

async function spawnCli(
  args: string[],
  options: { env?: Record<string, string>; bannerStream?: "stdout" | "stderr" } = {},
): Promise<CliProcess> {
  const child = launch(args, options.env);
  const streams = collect(child);
  const banner = await waitForOutput(
    child,
    streams,
    options.bannerStream ?? "stdout",
    BANNER,
  ).catch(async (error: unknown) => {
    await stopChild(child, "SIGKILL");
    throw error;
  });
  const port = Number(BANNER.exec(banner)?.groups?.port);
  return {
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    stdout: streams.stdout,
    stderr: streams.stderr,
    waitForStdout: async (pattern, timeoutMs) =>
      waitForOutput(child, streams, "stdout", pattern, timeoutMs),
    waitForStderr: async (pattern, timeoutMs) =>
      waitForOutput(child, streams, "stderr", pattern, timeoutMs),
    stop: async (signal = "SIGTERM") => stopChild(child, signal),
  };
}

async function runCliOnce(
  args: string[],
  env?: Record<string, string>,
  entry?: string,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child =
    entry === undefined
      ? launch(args, env)
      : spawn(process.execPath, [entry, ...args], {
          env: childEnv(env),
          stdio: ["ignore", "pipe", "pipe"],
        });
  const streams = collect(child);
  const killer = setTimeout(() => {
    child.kill("SIGKILL");
  }, KILL_AFTER_MS * 2);
  try {
    const { code } = await waitForExit(child);
    return { code, stdout: streams.stdout(), stderr: streams.stderr() };
  } finally {
    clearTimeout(killer);
  }
}

async function postFixture(
  baseUrl: string,
  name: string,
  scopePath = "/my-app/3f9a1c/web",
): Promise<Response> {
  const fixture = loadEnvelopeFixture(name);
  const headers = new Headers();
  for (const [key, value] of Object.entries(fixture.meta.headers)) {
    if (value !== undefined) {
      headers.set(key, value);
    }
  }
  return fetch(`${baseUrl}${scopePath}/api/1/envelope/`, {
    method: "POST",
    headers,
    body: fixture.body,
  });
}

/** Kills leftovers and reports how many were still running. */
async function killAll(): Promise<number> {
  const leftovers = [...live];
  await Promise.all(leftovers.map(async (child) => stopChild(child, "SIGKILL")));
  return leftovers.length;
}

function removeDataHome(): void {
  rmSync(dataHome, { recursive: true, force: true });
}

export { cliEntry, ensureBuilt, killAll, postFixture, removeDataHome, runCliOnce, spawnCli };
export type { CliProcess, ExitResult };
