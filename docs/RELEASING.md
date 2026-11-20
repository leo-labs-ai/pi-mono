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
   - with none pending it runs `npm run publish:changesets`, which attempts to publish public workspace
     versions that are missing from their registries. See the vendored-package caveat below.
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
of `pi-durable`. On current `main`, `version-packages` runs `changeset version` and then refreshes the
root and coding-agent install locks. #664 proposes adding `scripts/sync-versions.js` between those
steps to regenerate `PI_AI_VERSION` and check fork lockstep. `@leo-labs-ai/pi-evals` and `apps/p2`
are private: #676 opts private packages out of versioning and tagging, but their dependency pins can
still change. Changesets does not publish private packages.

The intended policy is to keep the vendored `@earendil-works/chord`, `@earendil-works/pi-codemode`,
`@earendil-works/pi-mcp` and `@earendil-works/pi-schema` on upstream releases resolved from npmjs,
not to publish them from this fork. The policy is not enforced by `privatePackages` or the empty
Changesets `ignore` list: a public vendored package can still be bumped as a dependent. `changeset
publish` skips an existing registry version but may attempt to publish a missing one. See "Known gaps"
for Chord.

Bump types: `patch` for fixes and additions, `minor` for breaking changes; the group takes the highest
bump among the pending changesets. Numbers continue from the last upstream sync: an upstream
`Release vX.Y.Z` commit sets the manifests, fork-only releases then go `X.Y.Z+1`, `X.Y.Z+2`, and so on.
`"access": "restricted"` in the config and the fork packages' `publishConfig.registry` target GitHub
Packages. The root `.npmrc` routes the `@leo-labs-ai` and legacy `@valkyriweb` scopes there, not
`@earendil-works`.

## Adding a changeset

Interactive: `npm run changeset`. Or write the file by hand:

```md
---
"@leo-labs-ai/pi-coding-agent": patch
---

One or two sentences on what changes for users of the package.
```

- Name a package of the fixed group (naming several is fine). Never name a vendored
  `@earendil-works/*` package: nothing is in the config's `ignore` list, so `changeset version` would
  move it off upstream's version number, and the publish then fails on npmjs unless upstream already
  released that number (see "Known gaps").
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
   the consumed `.changeset/*.md` files removed, and `packages/ai/src/utils/version.ts` once #664
   lands. Check that `PI_AI_VERSION` matches the pi-ai manifest and that vendored pins resolve to
   approved upstream releases. Stop if either is wrong or if the diff includes unexpected changes.
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
  it; ask the maintainer to provision it if missing.
- `GITHUB_TOKEN` with `packages: write`, used as `NODE_AUTH_TOKEN` for GitHub Packages. No npm token.

## Known gaps (2026-11-19 snapshot)

- Generated version PR #663 bumps pi-ai from 1.5.2 to 1.5.3 but leaves `PI_AI_VERSION` at 1.5.2,
  failing `packages/ai/test/identity.test.ts`. #664 fixes generation of the constant, not the
  existing generated branch; rerun generation after the source fixes land.
- #663 also bumps public `@earendil-works/chord` to 1.5.3 because it depends on
  `@leo-labs-ai/pi-telemetry`. The resulting Chord pins in `apps/p2`, `durable`, and `env` are not a
  recognized fork-only version bump, so `check:changelog` asks for fork, durable, and env changelog
  updates. #676's private-package opt-out and #664's identity fix do not address this. A version
  already on npmjs can be skipped by `changeset publish`, but registry presence alone does not
  establish that the upstream package is compatible. If the version is missing, publish may
  attempt it and fail, potentially after other packages have been published. The maintainer must
  decide how to keep Chord on an approved upstream release, verify its resolution, and regenerate
  a green version PR before approving the release.
- `FORK-CHANGELOG.md` has had no version heading cut since 0.82.0; every release since is under
  `[Unreleased]`.
