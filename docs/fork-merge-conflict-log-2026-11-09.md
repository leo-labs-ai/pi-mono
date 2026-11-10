# Fork upstream sync 2026-11-09 — 1.4.0 → 1.5.0

Worktree: `lue-t-pii-1-5-sync-1109`, branch `lue/t-pii-1-5-sync-1109`. Method: `git merge --no-ff v1.5.0` on a lane branch, as for 1.3.0 and 1.4.0.

## B / L / U

| | SHA | Proof |
|---|---|---|
| B (last integrated upstream) | `4a080252f` = tag `v1.4.0` | `git merge-base origin/main v1.5.0`; merge commit `cd0d70136` |
| L (fork) | `c4bfda4f3` = `origin/main` | lane base |
| U (upstream) | `f9a263655` = tag `v1.5.0` | selected tag, ancestor of `upstream/main` |

The merge reported 122 conflicted files. 84 of them differed only by package scope and were resolved by rule (ours equals base modulo scope: take upstream, rewrite the 8 fork package names). 32 files needed manual hunks. 5 modify/delete files had no fork delta and follow upstream's deletion.

## Classification

| Class | What |
|---|---|
| adopt | New package `packages/schema` (`@earendil-works/pi-schema`), which replaces direct typebox use; the "pi-ai extension view" for extensions (`bundledPiAiExtensionView`, `pi-ai-extension-view.ts`); the field-weighted tool-search ranker; `packages/ai/catalog/` as the home of model generation; deletion of `examples/extensions/sandbox`, `durable/src/harness/events.ts` and three tests |
| adapt (package identity) | All manifests (fork scope, GitHub Packages `publishConfig`, upstream dependency versions); 53 new or changed upstream files rewritten to `@leo-labs-ai/` for the 8 fork packages; 18 fork-scope path twins in `packages/coding-agent/examples/tsconfig.json`; `virtual-modules.ts` and `loader.ts` keep both scopes as aliases of the extension view |
| adapt (generator) | `scripts/generate-models.ts` is gone upstream. Its fork delta moved to `catalog/generate.ts` (`--check-api-drift`, `--diagnostics-json`, skipped-model report), `catalog/providers/opencode.ts` (unknown npm adapter is skipped, not guessed) and `catalog/families/kimi.ts` (Kimi K3 `cacheWrite: 3`). `scripts/model-api-support.ts` stays fork-only and exports the shared skip list |
| adapt (schema) | `providers/compat-schema.ts` taken from upstream, then the fork fields re-added with pi-schema builders: `sendSessionAffinityHeaders`, `sendChatgptAccountId`, `supportsWebSocketTransport`, `supportsZstdRequestCompression`; `supportsMidConvoEffort` still names `openai-codex-responses` |
| adapt (tool search) | `extensions/tool-search/tool.ts` taken from upstream, then the fork rules re-added: generic terms (#635) and required `+term` (#653). See decision 1 |
| adapt (model snapshot) | `nix/model-catalog.json` takes upstream's v1.5.0 pin `sha256-f4dbabe7…`. `packages/ai/model-catalog.snapshot.json` holds that revision (hash verified) plus the Kimi K3 override on `moonshotai`, `moonshotai-cn` and `kimi-coding` |
| adapt (lockfiles) | Root `package-lock.json` regenerated with `npm install --ignore-scripts`, then `npm audit fix --ignore-scripts` (zod 4.6.7, fast-uri 3.1.9, js-yaml 4.3.2 / 3.15.2, smol-toml 1.9.1). Install lock regenerated (186 packages); the generator now treats `@earendil-works/pi-schema` as a workspace package |
| preserve | Fork CI (`ci.yml` with `unit-tests` and `fork-safety-check`), fork release flow, `test:build-gate`, cache-safe compaction, `modelVisible`, hidden-tool declarations, slash-means-provider, dynamic OpenCode cache matrix (#666, `cache-retention.test.ts` kept as ours), fork doc notes in `docs/extensions.md` |
| reject | `.github/workflows/preview-packages.yml` and the `ci.yml` preview pack/upload steps (they publish to `pkg.earendil.com`). `scripts/preview-packages.mjs` and its test stay, unused, to keep the upstream diff small |
| not merged | `packages/*/CHANGELOG.md` use `merge=ours` (`.gitattributes`), so `packages/chord/CHANGELOG.md` has no upstream `[1.5.0]` section. Unchanged policy from earlier syncs |

## Decisions that change behaviour

1. **Generic terms in tool search.** Upstream's ranker scores name, namespace and description separately. The old fork rule dropped generic terms before scoring an `mcp__` tool, which made a tool that matched two query terms rank below one that matched one. The rule is now a filter: an `mcp__` tool is a match only when one of its matched query terms is not generic, is required with `+`, or occurs in the tool's name. Scores are upstream's.
2. **Invalid resource lists in settings no longer stop startup (#670).** `"extensions": {}` (also `skills`, `prompts`, `themes`) used to throw `entries is not iterable`. A non-array value is now dropped and reported as a settings warning.
3. **Upstream Sync picks a working push credential (#637).** See below.
4. **`build:ts` is now an alias of `build:unbundled`.** The fork-only `build:ts` script in `packages/coding-agent` called `shx`, which upstream removed in favour of `scripts/package-files.mjs`. The first merge commit kept the old script body, and the `review` CI job failed with `shx: not found`. Upstream's `build:unbundled` does the same three steps. No other use of a dependency removed by the sync remains (checked `shx`, `autoevals`, `@anthropic-ai/sandbox-runtime` and `typebox` in `agent`, `chord`, `durable`).
5. **One chord test has a longer timeout.** `packages/chord/test/manager.test.ts` (kernel-lock test, four child spawns) timed out at the 5 s default in two of three CI runs. The file is identical to upstream; 1.5.0 grows chord from 49 to 193 test files that run in parallel. The test now has a 20 s limit. Upstream deletes this file after 1.5.0, so follow the deletion at the next sync.

## Issues handled with the sync

- **#670**: fixed in `core/settings-manager.ts` with a test in `test/settings-manager.test.ts`.
- **#652**: `undici` was already above 6.28.1 after the 1.4.0 sync (8.12.3 direct, 7.30.1 under `openai`, 6.29.1 under gondolin by override). `node scripts/npm-audit.mjs` reports no unaccepted advisory after the bumps above.
- **#637**: the `UPSTREAM_SYNC_TOKEN` secret (set 2026-05-19) belongs to `valkyriweb` and predates the repo's move to `leo-labs-ai` on 2026-10-05, so GitHub denies its pushes with 403. `actions/checkout` stored that token as the git credential, and the first push (`Clean up stale sync branches`) failed. The workflow now tests the secret with `git push --dry-run` and uses `GITHUB_TOKEN` when the secret cannot push. Run 42714628177 on this branch confirmed it: cleanup and the branch push passed with `GITHUB_TOKEN`. Two more defects showed in that run. First, the repo does not let `GITHUB_TOKEN` open pull requests, so the PR step now warns with a compare link instead of failing. Automatic sync PRs return when Luke rotates the secret or allows Actions to create pull requests. Second, `dry_run` never worked: the steps compared the boolean input with the string `'true'`. That run was meant as a dry run and instead deleted the stale branch `sync/upstream-2026-08-21` (was `b06f158d8`, closed PR #489) and pushed `sync/upstream-2026-11-09`. The conditions now compare with `true`.

## Verification status (local, M2 Max)

- `npm run check`: exit 0.
- `npm run build:offline`: all packages build; `dist/cli.js --version` = 1.5.0.
- Focused suites: `packages/ai`, `packages/durable`, `packages/coding-agent` pass.
- `./test.sh` ran with a load average near 400 from other sessions. Remaining failures are environment-only as far as checked: `env` daemon not built (`terminal`, `conformance`, `differential`, `remote`, `ssh*`), 5-second timeouts in `chord`, `codemode` and `tui` that pass alone, and `codemode` Bun worker tests. Three `chord` files still fail alone on Node 26 (`upgrades`, `plugins/build`, `workers`); `packages/chord/src` differs from `v1.5.0` only by package names. CI on Node 24 is the gate.
