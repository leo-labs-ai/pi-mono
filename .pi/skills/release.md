---
name: release
description: Prepare, verify, and recover pi fork releases (Changesets version PR, GitHub Packages publish, release binaries). Use for release preparation, adding changesets, local release smoke tests, checking a release run, and failed release CI.
---

# Releasing pi (fork)

Run repository commands from the repo root (two directories above this skill). The human runbook is
[docs/RELEASING.md](../../docs/RELEASING.md); this skill is its agent-facing copy. Releases need the
maintainer's explicit approval: you prepare and verify, the maintainer merges.

**How releases work.** Changesets on `main`, driven by `.github/workflows/release.yml`. A PR that should
ship adds `.changeset/<name>.md`. Each push to `main` lets `changesets/action` open or update the PR
"chore(release): version fork packages" (branch `changeset-release/main`). Merging that PR publishes the
`@leo-labs-ai/*` packages to GitHub Packages, creates one GitHub Release per package and, when
`pi-coding-agent` ships, builds the `v<version>` binaries. Six packages move in lockstep
(`.changeset/config.json` `fixed`): pi-ai, pi-agent-core, pi-tui, pi-telemetry, pi-durable and
pi-coding-agent; `pi-env` follows as a dependent. Private packages are not versioned, tagged or
published, though their dependency pins may change. Vendored `@earendil-works/*` packages are intended
to stay on upstream npmjs releases, not be published by the fork. Changesets does not enforce that
policy for public vendored dependents such as Chord.

## Add a changeset to a PR

Write `.changeset/<kebab-name>.md`:

```md
---
"@leo-labs-ai/pi-coding-agent": patch
---

What changes for users of the package, one or two sentences.
```

`patch` = fixes and additions, `minor` = breaking changes. Name a fixed-group package, never an
`@earendil-works/*` one. The changeset does not replace the `FORK-CHANGELOG.md` entry that
`npm run check:changelog` requires for non-docs, non-test changes. `npm run changeset:status` previews
the bump.

## Prepare a release

1. On `main`, run `npm run changeset:status` and confirm the pending changesets are the ones meant to
   ship.
2. Find the version PR: `gh pr list --head changeset-release/main`. Check it with `gh pr checks <n>` and
   `gh pr diff <n>`. The diff must contain only manifests, `package-lock.json`,
   `packages/coding-agent/install-lock/*`, removed `.changeset/*.md` files and, once #664 lands,
   `packages/ai/src/utils/version.ts`. Verify that the pi-ai constant matches the manifest and that
   vendored pins resolve to approved upstream releases. Report discrepancies or unexpected diffs; do
   not patch the generated branch (the action regenerates it on pushes to `main`).
3. Confirm `FORK-CHANGELOG.md` `[Unreleased]` covers what ships. Nothing cuts the section automatically.
   Propose a `## [X.Y.Z] - YYYY-MM-DD` heading above the shipping entries; commit it only when the user
   asks.
4. When startup, packaging or the binary changed, run the local smoke test. It publishes nothing:
   ```bash
   npm run release:local -- --out /tmp/pi-local-release --force
   cd /tmp

   /tmp/pi-local-release/node/pi --help
   /tmp/pi-local-release/node/pi --version
   /tmp/pi-local-release/node/pi --list-models
   /tmp/pi-local-release/node/pi -p "Say exactly: ok"
   /tmp/pi-local-release/node/pi

   /tmp/pi-local-release/bun/pi --help
   /tmp/pi-local-release/bun/pi --version
   /tmp/pi-local-release/bun/pi --list-models
   /tmp/pi-local-release/bun/pi -p "Say exactly: ok"
   /tmp/pi-local-release/bun/pi
   ```
   The bare commands start interactive mode: run each in tmux started from `/tmp`, following
   [interactive-testing.md](interactive-testing.md), submit a prompt and wait for the model reply before
   calling the smoke test passed. Failures block the release unless the user explicitly accepts the risk.
5. Report the state to the user and ask them to merge the version PR, or to label it `ready-to-land` for
   the land queue. Do not merge, label, or push tags yourself.

## Verify a release

After the version PR merges, the Release run on the merge commit must be green:

- "Version or publish packages" logs a `New tag:` line per package.
- GitHub Releases: `@leo-labs-ai/<name>@<version>` per package, plus `v<version>` with the six binaries,
  `pi-<version>-source.tar.gz`, the two install-lock files and `SHA256SUMS` when coding-agent shipped.
- `npm view @leo-labs-ai/pi-coding-agent@<version> version --registry https://npm.pkg.github.com`
  resolves (needs a token with `read:packages`).

## Recover

- Run failed before "Version or publish packages": nothing was published. Fix `main` through a normal
  PR; the next push re-runs Release and refreshes the version PR.
- Publish failed part-way: ask the user to re-run the failed run. `changeset publish` skips versions
  already on the registry and `.github/scripts/create-github-releases.mjs` skips existing releases. If
  only `binaries` failed, dispatch the Build Binaries workflow with `tag: v<version>` and
  `source_ref: <merge commit SHA>`.
- Never run `npm run version-packages`, `npm run publish:changesets`, `npm run release:patch|minor|major`
  or `npm run publish`, and never push tags by hand. The `release:*` and `publish` scripts are upstream's
  legacy laptop flow and target public npm.

## Known gaps (2026-11-19 snapshot)

- #663 (1.5.3) leaves `PI_AI_VERSION` at 1.5.2; #664 is the proposed generation fix.
- #663 also bumps public `@earendil-works/chord` through its telemetry dependency; the changed pins
  in `apps/p2`, `durable`, and `env` fail `check:changelog`. The private-package opt-out does not
  protect Chord, and publish may try to publish a version missing from npmjs. Stop and ask the
  maintainer to decide the Chord policy and verify the dependency before Release regenerates the PR.
- `FORK-CHANGELOG.md` has had no version heading cut since 0.82.0.
