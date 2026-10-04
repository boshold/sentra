# Contributing to Sentra

This guide covers local setup, tests and the conventions the repo follows.

## Prerequisites

- [Node.js](https://nodejs.org) `>=22.15`
- [pnpm](https://pnpm.io); the repo pins its version in `packageManager`
- [Bun](https://bun.sh) `>=1.4`, optional, for the Bun tests and `pnpm smoke:bun`

## Setup

```bash
git clone https://github.com/boshold/sentra.git
cd sentra
pnpm install
```

The repo has two packages: `packages/core` (`@bosdev/sentra-core`, the library) and `packages/cli` (`@bosdev/sentra-cli`, the `sentra` binary).

## Development

```bash
pnpm check              # typecheck, lint, build, unit tests with coverage
pnpm test               # unit tests
pnpm test <path>        # a single test file
pnpm test:integration   # real Sentry SDKs, Vite and a Nitro-style bundle against Sentra (run pnpm build first)
pnpm smoke:bun          # compiles a host with bun build --compile and runs it (run pnpm build first)
pnpm lint:fix           # oxfmt and oxlint with autofix
pnpm build              # builds both packages into dist/
```

Core unit tests under Bun (as in CI):

```bash
cd packages/core && bun --bun x vitest run
```

Run `pnpm check` before opening a pull request.

## Pull requests

- Branch off `main` and keep each PR focused on one change.
- Use [Conventional Commits](https://www.conventionalcommits.org) for commit messages and PR titles, for example `feat(cli): ...`, `fix(core): ...`, `docs: ...`.
- Update the READMEs and `docs/` when behavior changes.
- Add a line under `Unreleased` in `CHANGELOG.md` for user-facing changes.
- Add tests for new behavior and bug fixes.
- CI has to be green.

## Releasing

Maintainers run the Release workflow (Actions, Release) with a `bump` of `patch`, `minor` or `major`. It runs CI, writes the version into both packages, commits and tags `vX.Y.Z`, stages both packages on npm with provenance and creates the GitHub release. `dry-run` builds without pushing or publishing. Do not push tags or edit versions by hand.

Staged versions are not installable until a maintainer approves them with 2FA on npmjs.com or with `npm stage approve` (core first, the CLI depends on it). The workflow cannot publish directly. Publishing runs in the `release` GitHub environment, which only allows `main`. `CHANGELOG.md` is maintained by hand: before a release, move the `Unreleased` entries under a heading for the new version. The GitHub release notes are generated from the merged pull requests.

## Reporting issues

Use the [issue tracker](https://github.com/boshold/sentra/issues). For security problems, follow [SECURITY.md](SECURITY.md) instead of opening a public issue.
