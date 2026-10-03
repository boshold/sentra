import { VERSION } from "@bosdev/sentra-core";

if (process.argv.includes("--version")) {
  console.log(VERSION);
} else {
  console.error("sentra: not implemented yet");
  process.exitCode = 1;
}
