import process from "node:process";

const SIGNALS = ["SIGINT", "SIGTERM"] as const;

/** Loading the CLI takes a while; a signal before the server installs its own handlers exits 0. */
function exitEarly(): void {
  process.exit(0);
}

for (const signal of SIGNALS) {
  process.on(signal, exitEarly);
}

const { runCli } = await import("#src/cli.js");
const result = runCli(process.argv.slice(2));
// After `runCli` added the server's handlers: removing the last listener drops a pending signal.
for (const signal of SIGNALS) {
  process.off(signal, exitEarly);
}
process.exitCode = await result;
