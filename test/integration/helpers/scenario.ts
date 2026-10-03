import { spawn } from "node:child_process";

interface ScenarioResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

const TIMEOUT_MS = 30_000;

/** Runs a scenario script with the current Node binary; rejects after 30 s. */
async function runScenario(file: string, env: Record<string, string>): Promise<ScenarioResult> {
  const child = spawn(process.execPath, [file], {
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk;
  });
  return new Promise<ScenarioResult>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`scenario ${file} timed out after ${TIMEOUT_MS} ms\n${stderr}`));
    }, TIMEOUT_MS);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

export { runScenario };
export type { ScenarioResult };
