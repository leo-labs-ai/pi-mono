# Fork upstream sync 2026-10-15 — 1.0.4 → 1.3.0

Worktree: `pii-sync-130`, branch `lue/pii-sync-130`. Status: merge committed 2026-10-21 after local build and gates on the M2 Max (Luke approved local compute).

## B / L / U

| | SHA | Proof |
|---|---|---|
| B (last integrated upstream) | `7c10bd433` = tag `v1.0.4` | `docs/fork-merge-conflict-log-2026-10-06.md` |
| L (fork) | `f6ce52d36` = `origin/main` | lane base |
| U (upstream) | `71023aec1` = tag `v1.3.0` | selected tag |

## Classification

| Class | What |
|---|---|
| adopt | Upstream removal of client/server/protocol/experimental; schema-derived compat types; `configurationUpdateEffort`; exact pinning in `sync-versions`; provider-specific error-tool-result image handling (#10794); codemode output layout (`==> text N/M <==`, `<console_output>`); `_startRun` refactor of `agent-session`; `loadContextFile` worktree realpath fix |
| adapt (package identity) | All manifests, tsconfig paths (fork-scope twins of upstream paths), vitest aliases (added `utils/` and `api/` twins), `check-entry-graphs`, `durable-browser-smoke-entry` |
| adapt (behaviour) | Per-model opt-in `supportsMidConvoEffort` mapped onto `configurationUpdateEffort`, request effort fixed to `medium`; ported to `openai-codex-responses` |
| adapt (schema) | Fork-only compat fields added to `compat-schema.ts` |
| preserve | slash-means-provider (re-grafted onto the new resolver), cwd omission, cache-safe compaction, `modelVisible`, `_projectedHiddenDeclarations`, fork-only `model-api-support.ts` drift check, Codex gateway guards, realpath dedupe of context files |
| supersede | #584 omit images in errored tool results (replaced by upstream #10794); fork `midConvoEffort` machinery |
| reject | `build-binaries.yml` `publish-npm`/`env-daemons` jobs (remote mutation the fork does not run) |
| adapt (lockfiles) | Root `package-lock.json` regenerated with `npm install --package-lock-only --ignore-scripts`; install lock regenerated with `scripts/generate-coding-agent-install-lock.mjs` (184 packages) |
| adapt (model snapshot) | Fork-only `packages/ai/model-catalog.snapshot.json` (#621) still listed `kimi-coding` models as `anthropic-messages`, so upstream's Chat Completions switch (`a3f265b1c`) failed `tsc`. Only the four `kimi-coding` entries were replaced from a live refresh; every other provider entry is unchanged (a full live refresh dropped models such as `mimo-v2.5-pro` that upstream 1.3.0 tests reference). |

## Decisions that change behaviour

1. **Slash policy vs upstream gateway ids.** Upstream tests (#10160/#5643/#5823) expect `anthropic/future` to resolve to a usable gateway raw id. The fork keeps #162 and adapted those tests in `packages/coding-agent/test/model-resolver.test.ts`. To adopt upstream behaviour, delete `isProviderQualified` and its three uses in `model-resolver.ts`.
2. **Mid-convo effort.** The old design replayed the first effective effort in the request. The new design fixes the request effort at `medium` and sends changes as `configuration_update` items. Cache behaviour on clawrouter has not been measured for the Codex path.
3. **Failed codemode scripts keep images.** Anthropic/Bedrock converters now reposition them.

## Base re-check (2026-10-21)

`origin/main` contains tag `v1.1.2`, but that tag is the fork's own release tag (`49774fcbd`, `chore(release): version fork packages (#643)`), not an upstream tag. Upstream has no `v1.1.2`; `v1.1.0` and `v1.2.0` are not in `origin/main`. B = `v1.0.4` is correct.

## Verification status (local, M2 Max)

- `npm run check`: exit 0 (biome, changelog, pinned/runtime deps, ts-imports, entry graphs, install-lock check, `tsc --noEmit`, browser smoke).
- `npm run build`: all packages build; `dist/cli.js --version` = 1.3.0.
- `test:system-prompt` 151/151; `test:cache-stability` 31 passed / 4 skipped; `test:loader-resolver` is a documented skip.
- `test:e2e`: 476/476 with `PI_CODING_AGENT_DIR` pointed at an empty temp dir. With Luke's real agent dir, `6999-models-json-hot-reload` fails because real provider auth is visible to the selector (environment leak, not a merge defect).
- `truncated-recovery-custom-message-turn` (fork-only) is intermittent: 1 of 3 isolated reruns failed, and it failed once in the full suite. Not yet determined whether this predates the merge.
- `test:my-pi-extensions` against a clean `my-pi` `origin/main` worktree: 89/92; `test:otel-exporter` passes on rerun (timeout under load); `test:pi-memory:cache` and `test:psyche-cli:smoke` fail only because the temp worktree was installed with `--ignore-scripts` (no `better-sqlite3` native binding).
