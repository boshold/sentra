/*
 * Release step: computes the next version from the latest vX.Y.Z tag, writes it into both
 * packages, commits and tags locally. Nothing is pushed. An already tagged HEAD resumes that
 * release, so a failed run can be repeated.
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

import { z } from "zod";

const CORE_MANIFEST = "packages/core/package.json";
const PACKAGES = [CORE_MANIFEST, "packages/cli/package.json"];
const TAG = /^v(?<major>\d+)\.(?<minor>\d+)\.(?<patch>\d+)$/;

const bumpSchema = z.enum(["patch", "minor", "major"]);
const manifestSchema = z.looseObject({ version: z.string() });

type Version = [number, number, number];

function git(...args: string[]): string {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

function parseTag(tag: string): Version | null {
  const groups = TAG.exec(tag)?.groups;
  if (!groups) {
    return null;
  }
  return [Number(groups.major), Number(groups.minor), Number(groups.patch)];
}

function compare(a: Version, b: Version): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

function bump([major, minor, patch]: Version, part: z.infer<typeof bumpSchema>): Version {
  if (part === "major") {
    return [major + 1, 0, 0];
  }
  if (part === "minor") {
    return [major, minor + 1, 0];
  }
  return [major, minor, patch + 1];
}

function latestTag(...args: string[]): Version | undefined {
  return git("tag", "--list", "v*", ...args)
    .split("\n")
    .map(parseTag)
    .filter((version) => version !== null)
    .toSorted(compare)
    .at(-1);
}

const part = bumpSchema.parse(process.env.RELEASE_BUMP);
const headTag = latestTag("--points-at", "HEAD");
const resumed = headTag !== undefined;

if (!resumed && process.env.GITHUB_SHA && git("rev-parse", "HEAD") !== process.env.GITHUB_SHA) {
  throw new Error("the branch moved since the run started; start a new release");
}

if (resumed) {
  console.log(
    `::notice::HEAD is already tagged; resuming v${headTag.join(".")} and ignoring bump=${part}`,
  );
}

const current = manifestSchema.parse(JSON.parse(readFileSync(CORE_MANIFEST, "utf8"))).version;
const currentVersion = parseTag(`v${current}`);
if (!currentVersion) {
  throw new Error(`${CORE_MANIFEST} has an invalid version ${current}`);
}
const next = headTag ?? bump(latestTag() ?? [0, 0, 0], part);
if (!resumed && compare(next, currentVersion) <= 0) {
  throw new Error(
    `next version ${next.join(".")} is not above ${current}; are the release tags fetched?`,
  );
}
const version = next.join(".");
const tag = `v${version}`;

const changed: string[] = [];
for (const file of PACKAGES) {
  const text = readFileSync(file, "utf8");
  const manifest = manifestSchema.parse(JSON.parse(text));
  if (manifest.version === version) {
    continue;
  }
  if (resumed) {
    throw new Error(`${tag} is already tagged but ${file} has ${manifest.version}`);
  }
  // Replaces only the version line so the file keeps its formatting.
  writeFileSync(file, text.replace(/^(?<key> {2}"version": )"[^"]*"/mu, `$<key>"${version}"`));
  changed.push(file);
}

if (changed.length > 0) {
  git("add", "--", ...changed);
  git("commit", "--message", `chore(release): ${tag}`);
}
if (!resumed) {
  git("tag", "--annotate", tag, "--message", tag);
}

const output = `version=${version}\ntag=${tag}\nresumed=${resumed}`;
console.log(output);
if (process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT, `${output}\n`);
}
