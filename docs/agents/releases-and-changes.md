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

The Changesets fixed group (`.changeset/config.json`) holds the six fork-owned publishable workspaces: `@leo-labs-ai/pi-ai`, `pi-agent-core`, `pi-tui`, `pi-telemetry`, `pi-durable` and `pi-coding-agent`. `@leo-labs-ai/pi-env` is public and fork-owned but outside the group; it is bumped as a dependent. #664 proposes running `scripts/sync-versions.js` during version PR generation to update the pi-ai version constant and check lockstep. Private workspaces such as `pi-evals` and `p2` are not versioned or tagged, although their pins can change. `protocol`, `client` and `server` were removed in the 1.3.0 upstream sync and the orchestrator workspace earlier; neither set should be reintroduced into the group.

The intended policy is to consume `@earendil-works/chord`, `pi-codemode`, `pi-mcp` and `pi-schema` from upstream npmjs releases, not publish them from the fork. That is not a guarantee: Changesets can still bump public Chord as a dependent. As of version PR #663 (1.5.3), that policy gap is open; see the [runbook](../RELEASING.md#known-gaps-2026-11-19-snapshot).

## Change records

- Add a Changeset for publishable package behavior unless the established Changesets tooling marks the change exempt. Name a fixed-group package, never a vendored `@earendil-works/*` one.
- Fork-owned release notes belong in [`FORK-CHANGELOG.md`](../../FORK-CHANGELOG.md) under `## [Unreleased]`; `npm run check:changelog` requires an entry for non-docs, non-test changes. Nothing cuts the section at release time: the `## [X.Y.Z] - date` heading is added by hand when the version PR merges.
- Do not edit package `CHANGELOG.md` files; this fork preserves them through merge policy, [`CONTRIBUTING.md`](../../CONTRIBUTING.md) reserves their updates for maintainers, and Changesets is configured with `"changelog": false`.
- Released history is immutable.
