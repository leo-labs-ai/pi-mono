# Releasing

Canonical release runbook for `leo-labs-ai/pi-mono`. [`.pi/skills/release.md`](../.pi/skills/release.md)
is the agent-facing copy and [`docs/agents/releases-and-changes.md`](agents/releases-and-changes.md) the
short context note. When a step changes, change it here first and keep the other two in sync.

Releases are cut by [`.github/workflows/release.yml`](../.github/workflows/release.yml) with
[Changesets](https://github.com/changesets/changesets). Nothing is versioned, tagged or published from
a laptop. Fork packages publish to GitHub Packages under the restricted `@leo-labs-ai` scope; compiled
`pi` binaries ship as GitHub Releases on this repository.

## The flow in one screen

1. **A change that should ship carries a changeset.** The PR adds `.changeset/<name>.md` naming a
   package of the fixed group with a bump type. Naming any package of the group bumps the whole group.
2. **Every push to `main` runs Release.** The workflow builds, runs the release gate
   (`test:system-prompt`, `test:cache-stability`, `test:e2e`) and `npm run check`, then
   `changesets/action` does one of two things:
   - with pending changesets it opens or updates the PR **"chore(release): version fork packages"**
     (branch `changeset-release/main`, author `valkyriweb-clawsweeper[bot]`) by running
     `npm run version-packages`;
   - with none pending it runs `npm run publish:changesets`, which publishes every public workspace
     package whose version is not yet on its registry.
3. **Releasing means merging the version PR.** It is reviewed like any PR, its checks are the normal
   checks, and the land queue merges it on `ready-to-land`. The push of its merge commit starts the
   publish run.
4. **The publish run** pushes one tag per package (`@leo-labs-ai/<name>@<version>`), creates one
   GitHub Release per published package with a short body that points at `FORK-CHANGELOG.md`
   ([`.github/scripts/create-github-releases.mjs`](../.github/scripts/create-github-releases.mjs)) and,
   when `@leo-labs-ai/pi-coding-agent` was published, calls
   [`build-binaries.yml`](../.github/workflows/build-binaries.yml) with tag `v<version>`: six platform
   binaries, the source archive, the coding-agent install lock and `SHA256SUMS`, smoke tests on Linux,
   macOS and Windows, then a published `v<version>` GitHub Release.

## Package set and version numbers

[`.changeset/config.json`](../.changeset/config.json) fixes six packages to one version (`fixed`):
`@leo-labs-ai/pi-ai`, `pi-agent-core`, `pi-tui`, `pi-telemetry`, `pi-durable` and `pi-coding-agent`.
`@leo-labs-ai/pi-env` is public and fork-owned but outside the group: Changesets bumps it as a dependent
of `pi-durable`, and `scripts/sync-versions.js` (run by `version-packages`) fails the version PR if any
public `@leo-labs-ai/*` package falls out of lockstep. `@leo-labs-ai/pi-evals` is private and never
published.

The vendored upstream packages `@earendil-works/chord`, `@earendil-works/pi-codemode` and
`@earendil-works/pi-mcp` keep upstream's version numbers and are never published by the fork:
`changeset publish` skips them because those versions already exist on npmjs. See "Known gaps" for the
chord exception.

Bump types: `patch` for fixes and additions, `minor` for breaking changes; the group takes the highest
bump among the pending changesets. Numbers continue from the last upstream sync: an upstream
`Release vX.Y.Z` commit sets the manifests, fork-only releases then go `X.Y.Z+1`, `X.Y.Z+2`, and so on.
`"access": "restricted"` in the config and `publishConfig.registry` in each manifest keep everything on
GitHub Packages; the root `.npmrc` routes the `@leo-labs-ai` and legacy `@valkyriweb` scopes there.

## Adding a changeset

Interactive: `npm run changeset`. Or write the file by hand:

```md
---
"@leo-labs-ai/pi-coding-agent": patch
---

One or two sentences on what changes for users of the package.
```

- Name a package of the fixed group (naming several is fine). Never name a vendored
  `@earendil-works/*` package: the config `ignore` list is empty and a changeset that mixes skipped and
  released packages fails `changeset version`.
- The config sets `"changelog": false`, so the text is not rendered anywhere and the version PR body
  lists package names only. Keep the text accurate anyway.
- Release notes live in `FORK-CHANGELOG.md`. `npm run check:changelog` requires an entry under
  `## [Unreleased]` for any change that is not docs-only or tests-only; a changeset does not replace it.
  Package `CHANGELOG.md` files are upstream-owned, do not edit them.
- `npm run changeset:status` shows what the next version PR would bump.
- Docs-only and changeset-only PRs skip the agentic review, and so does the version PR itself.

## Merging the version PR

Before merging:

1. All checks are green. The land queue requires `check` (Changelog), `fork-safety-check` (CI), `gate`
   and `review` (Agentic PR Review); CI's `unit-tests` and `mcp-conformance` must pass too. Do not merge
   around a red check with `--admin`: `release.yml` mints a GitHub App token
   (`CLAWSWEEPER_APP_PRIVATE_KEY`) precisely so the version PR's pushes trigger the required checks.
2. The diff is mechanical: manifests, `package-lock.json`, `packages/coding-agent/install-lock/*`,
   `packages/ai/src/utils/version.ts`, and the consumed `.changeset/*.md` files removed. Anything else
   means `version-packages` did something unexpected; stop and look before merging.
3. `FORK-CHANGELOG.md` `[Unreleased]` reflects what ships. Nothing cuts that section automatically
   (`"changelog": false`): insert `## [X.Y.Z] - YYYY-MM-DD` above the shipping entries, either as a
   commit on `changeset-release/main` before merging or as a follow-up on `main`. The numbering and
   dating rules are at the top of the file.
4. When the release touches startup, packaging or the binary, run the local smoke test below.

Merge through the land queue (`ready-to-land`, see [`.github/LAND-QUEUE.md`](../.github/LAND-QUEUE.md))
or by hand with a merge commit. Then watch the Release run of the merge commit on `main`.

## Verifying a release

- Actions → Release: the run on the merge commit is green. "Version or publish packages" logs a
  `New tag:` line per package, "Create GitHub Releases (bounded body)" created one release per package,
  and `binaries` ran when coding-agent shipped.
- Releases: `@leo-labs-ai/<name>@<version>` per package, plus `v<version>` with
  `pi-<version>-source.tar.gz`, `pi-{darwin,linux}-{arm64,x64}.tar.gz`, `pi-windows-{x64,arm64}.zip`,
  `pi-coding-agent-install-package.json`, `pi-coding-agent-install-package-lock.json` and `SHA256SUMS`.
  Its notes are the coding-agent `CHANGELOG.md` section for that version when upstream has one, else
  `Release <version>` (`scripts/release-notes.mjs extract`).
- Registry: `npm view @leo-labs-ai/pi-coding-agent@<version> version --registry https://npm.pkg.github.com`
  with a token that has `read:packages`.
- Consumers (`my-pi`, `harbor`, …) pin exact versions; bump them there.

## Local smoke test

`scripts/local-release.mjs` builds the publishable packages from the checkout, packs them, and installs
the Node package and the Bun binary into isolated directories outside the repo, so they cannot resolve
workspace files. It publishes nothing.

```bash
npm run release:local -- --out /tmp/pi-local-release --force
cd /tmp

/tmp/pi-local-release/node/pi --help
/tmp/pi-local-release/node/pi --version
/tmp/pi-local-release/node/pi --list-models
/tmp/pi-local-release/node/pi -p "Say exactly: ok"
/tmp/pi-local-release/node/pi        # interactive: run in tmux, submit a prompt, await the reply

/tmp/pi-local-release/bun/pi --help
/tmp/pi-local-release/bun/pi --version
/tmp/pi-local-release/bun/pi --list-models
/tmp/pi-local-release/bun/pi -p "Say exactly: ok"
/tmp/pi-local-release/bun/pi          # interactive: same check
```

Start the tmux session in `/tmp` ([`.pi/skills/interactive-testing.md`](../.pi/skills/interactive-testing.md)).
Verify Node and Bun startup, model and account listing, interactive startup, and at least one real prompt
against the intended default provider. Failures block the release unless the maintainer explicitly accepts
the risk. The script runs `npm run check` and `./test.sh` first; `--skip-check` and `--skip-test` skip them.

## When something fails

- **Release run red before "Version or publish packages"** (build, release gate, `npm run check`):
  nothing was published. Fix `main` with a normal PR; the next push re-runs the workflow and refreshes
  the version PR.
- **Publish failed part-way**: re-run the failed run. `changeset publish` skips versions already on the
  registry and `create-github-releases.mjs` skips existing releases, so the re-run finishes what is
  missing. `binaries` only runs when coding-agent was published in that same run: if the publish
  succeeded and only the binaries failed, dispatch **Build Binaries** by hand with `tag: v<version>` and
  `source_ref: <merge commit SHA>`.
- **Version PR red**: see "Known gaps"; otherwise fix the cause on `main` and the PR is regenerated on
  the next push. Do not edit the version PR's manifests by hand: the action force-pushes
  `changeset-release/main` on every push to `main`.
- Do not run `npm run version-packages` or `npm run publish:changesets` by hand, and do not push tags
  by hand.

## Legacy paths, do not run

`scripts/release.mjs` (`npm run release:patch|minor|major`), `scripts/publish.mjs` (`npm run publish`,
`publish:dry`), `npm run version:*` and `scripts/release-packages.mjs` are upstream's laptop flow: they
commit `Release vX.Y.Z`, push a `v*` tag and publish to public npm. In this fork `build-binaries.yml`
has no `publish-npm` job and the `push: tags: v*` trigger is not the release path. They stay only for an
explicit, maintainer-reviewed fallback.

## Secrets the workflow needs

- `CLAWSWEEPER_APP_PRIVATE_KEY`: private key of the repo-installed valkyriweb-clawsweeper GitHub App
  (client id `Iv23lirdjmVqYd1gwY26`, the same App the land queue uses). The workflow fails fast without
  it; copy the secret from `my-pi` if it is missing.
- `GITHUB_TOKEN` with `packages: write`, used as `NODE_AUTH_TOKEN` for GitHub Packages. No npm token.

## Known gaps (2026-11-04)

- The 1.4.1 version PR (#663) was red twice. `unit-tests`: `packages/ai/test/identity.test.ts` saw
  `PI_AI_VERSION` still on 1.4.0, fixed by #664 (`version-packages` now runs `sync-versions.js`).
  `fork-safety-check`: `check:changelog` rejects the bump of `@earendil-works/chord` to 1.4.1 and the
  rewritten chord pins in `durable` and `env`. chord is bumped because it depends on
  `@leo-labs-ai/pi-telemetry`, and no fork-numbered chord exists on npmjs, so `changeset publish` would
  also fail on it after publishing the `@leo-labs-ai/*` packages (the `@earendil-works/pi-env@1.1.1`
  ENEEDAUTH pattern). Decide how chord is versioned before merging a version PR that bumps it.
- `FORK-CHANGELOG.md` has had no version heading cut since 0.82.0; every release since is under
  `[Unreleased]`.
