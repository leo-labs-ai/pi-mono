# Releases and change records

Read when adding release metadata or preparing/publishing a release. Releases require explicit maintainer approval. Full runbook: [`docs/RELEASING.md`](../RELEASING.md); agent procedure: [`.pi/skills/release.md`](../../.pi/skills/release.md).

## Current release path

The canonical automation is [`.github/workflows/release.yml`](../../.github/workflows/release.yml):

1. A publishable change includes a Changeset (`.changeset/<name>.md`).
2. A push to `main` lets `changesets/action` create or update the version PR "chore(release): version fork packages" (`changeset-release/main`) through `npm run version-packages`.
3. Merging that PR publishes the restricted `@leo-labs-ai/*` packages to GitHub Packages through `npm run publish:changesets` and creates one GitHub Release per package.
4. When `@leo-labs-ai/pi-coding-agent` is published, the workflow invokes `build-binaries.yml` to build the `v<version>` release binaries.

Do not follow the legacy local tag/WebAuthn/public-npm flow in `scripts/release.mjs`. Do not run `release:patch`, `release:minor`, `release:major`, or `npm publish` unless the maintainer explicitly chooses the legacy path after reviewing it.

## Current package set

The Changesets fixed group (`.changeset/config.json`) holds the six fork-owned publishable workspaces: `@leo-labs-ai/pi-ai`, `pi-agent-core`, `pi-tui`, `pi-telemetry`, `pi-durable` and `pi-coding-agent`. `@leo-labs-ai/pi-env` is public and fork-owned but outside the group; it is bumped as a dependent and `scripts/sync-versions.js` keeps every public `@leo-labs-ai/*` package in lockstep. `@leo-labs-ai/pi-evals` is private. The vendored `@earendil-works/chord`, `pi-codemode` and `pi-mcp` keep upstream's versions and are not published by the fork. `protocol`, `client` and `server` were removed in the 1.3.0 upstream sync and the orchestrator workspace earlier; neither set may be reintroduced into the group.

## Change records

- Add a Changeset for publishable package behavior unless the established Changesets tooling marks the change exempt. Name a fixed-group package, never a vendored `@earendil-works/*` one.
- Fork-owned release notes belong in [`FORK-CHANGELOG.md`](../../FORK-CHANGELOG.md) under `## [Unreleased]`; `npm run check:changelog` requires an entry for non-docs, non-test changes. Nothing cuts the section at release time: the `## [X.Y.Z] - date` heading is added by hand when the version PR merges.
- Do not edit package `CHANGELOG.md` files; this fork preserves them through merge policy, [`CONTRIBUTING.md`](../../CONTRIBUTING.md) reserves their updates for maintainers, and Changesets is configured with `"changelog": false`.
- Released history is immutable.
