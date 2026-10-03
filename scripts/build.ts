import { execSync } from "node:child_process";
import { chmodSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, posix, relative, resolve } from "node:path";

import { build } from "esbuild";

interface Target {
  dir: string;
  entry: string;
  out: string;
  banner?: string;
  declarations: boolean;
}

const ROOT = resolve(import.meta.dirname, "..");

// Core before CLI: the CLI bundle imports core's dist at runtime.
const TARGETS: Target[] = [
  { dir: "packages/core", entry: "src/index.ts", out: "dist/index.mjs", declarations: true },
  {
    dir: "packages/cli",
    entry: "src/cli.ts",
    out: "dist/cli.mjs",
    banner: "#!/usr/bin/env node",
    declarations: false,
  },
];

/** Version for `sentra --version`: CI tag (SENTRA_VERSION) → core package.json → "dev". */
function resolveVersion(): string {
  const envVersion = process.env.SENTRA_VERSION;
  if (envVersion) {
    return envVersion;
  }
  const parsed: unknown = JSON.parse(
    readFileSync(join(ROOT, "packages/core/package.json"), "utf8"),
  );
  if (
    typeof parsed === "object" &&
    parsed !== null &&
    "version" in parsed &&
    typeof parsed.version === "string"
  ) {
    return parsed.version;
  }
  return "dev";
}

function listDts(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((file) => file.endsWith(".d.ts"))
    .map((file) => join(dir, file));
}

/** Published packages ship no `src/`, so `#src/*` in declarations must become relative. */
function rewriteSrcAlias(distDir: string): void {
  for (const file of listDts(distDir)) {
    const content = readFileSync(file, "utf8");
    const rewritten = content.replace(
      /(["'])#src\/([^"']+)\1/g,
      (_match, quote: string, path: string) => {
        const rel = relative(dirname(file), join(distDir, path)).split("\\").join(posix.sep);
        const specifier = rel.startsWith(".") ? rel : `./${rel}`;
        return `${quote}${specifier}${quote}`;
      },
    );
    if (rewritten !== content) {
      writeFileSync(file, rewritten);
    }
  }
}

const version = resolveVersion();

for (const target of TARGETS) {
  const absDir = join(ROOT, target.dir);
  const distDir = join(absDir, "dist");
  rmSync(distDir, { recursive: true, force: true });

  await build({
    entryPoints: [target.entry],
    outfile: target.out,
    absWorkingDir: absDir,
    bundle: true,
    platform: "node",
    format: "esm",
    packages: "external",
    banner: target.banner ? { js: target.banner } : undefined,
    define: { __VERSION__: JSON.stringify(version) },
  });

  if (target.declarations) {
    execSync("tsc -p tsconfig.build.json --emitDeclarationOnly", {
      cwd: absDir,
      stdio: "inherit",
    });
    rewriteSrcAlias(distDir);
  }

  if (target.banner) {
    chmodSync(join(absDir, target.out), 0o755);
  }
}
