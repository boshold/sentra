import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { array, object, record, string } from "zod";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const PACKAGES = ["core", "cli"] as const;

const manifestSchema = object({
  files: array(string()),
  dependencies: record(string(), string()).default({}),
});

function readManifest(name: string) {
  return manifestSchema.parse(
    JSON.parse(readFileSync(path.join(ROOT, "packages", name, "package.json"), "utf8")),
  );
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((file) => file.endsWith(".ts"))
    .map((file) => path.join(dir, file));
}

describe.each(PACKAGES)("package %s", (name) => {
  it.each(["LICENSE", "NOTICE"])("ships %s identical to the repo root", (file) => {
    expect(readManifest(name).files).toContain(file);
    expect(readFileSync(path.join(ROOT, "packages", name, file), "utf8")).toBe(
      readFileSync(path.join(ROOT, file), "utf8"),
    );
  });

  it("imports every runtime dependency from src", () => {
    const sources = sourceFiles(path.join(ROOT, "packages", name, "src"))
      .map((file) => readFileSync(file, "utf8"))
      .join("\n");
    for (const dependency of Object.keys(readManifest(name).dependencies)) {
      expect(sources, dependency).toContain(`from "${dependency}`);
    }
  });
});
