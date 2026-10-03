import { execSync } from "node:child_process";
import { chmodSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { build } from "esbuild";

interface Target {
  dir: string;
  entry: string;
  /** Output name in `dist/`, without extension. */
  out: string;
  banner?: string;
  /** Dynamic imports become separate chunks under `dist/chunks/`. */
  splitting?: boolean;
  declarations: boolean;
}

const ROOT = path.resolve(import.meta.dirname, "..");

// Core before CLI: the CLI bundle imports core's dist at runtime.
const TARGETS: Target[] = [
  { dir: "packages/core", entry: "src/index.ts", out: "index", declarations: true },
  {
    dir: "packages/cli",
    // A tiny entry installs signal handlers before the CLI chunk and its dependencies load.
    entry: "src/bin.ts",
    out: "cli",
    banner: "#!/usr/bin/env node",
    splitting: true,
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
    readFileSync(path.join(ROOT, "packages/core/package.json"), "utf8"),
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
    .map((file) => path.join(dir, file));
}

/** Published packages ship no `src/`, so `#src/*` in declarations must become relative. */
function rewriteSrcAlias(distDir: string): void {
  for (const file of listDts(distDir)) {
    const content = readFileSync(file, "utf8");
    const rewritten = content.replace(
      /(?<quote>["'])#src\/(?<target>[^"']+)\k<quote>/g,
      (_match, quote: string, target: string) => {
        const rel = path
          .relative(path.dirname(file), path.join(distDir, target))
          .split(path.sep)
          .join(path.posix.sep);
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
  const absDir = path.join(ROOT, target.dir);
  const distDir = path.join(absDir, "dist");
  rmSync(distDir, { recursive: true, force: true });

  await build({
    entryPoints: [{ in: target.entry, out: target.out }],
    outdir: distDir,
    outExtension: { ".js": ".mjs" },
    splitting: target.splitting ?? false,
    chunkNames: "chunks/[name]-[hash]",
    absWorkingDir: absDir,
    bundle: true,
    platform: "node",
    format: "esm",
    packages: "external",
    // Tsconfig `paths` map workspace packages to sources; keep them external like other packages.
    external: ["@bosdev/*"],
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
    chmodSync(path.join(distDir, `${target.out}.mjs`), 0o755);
  }
}
