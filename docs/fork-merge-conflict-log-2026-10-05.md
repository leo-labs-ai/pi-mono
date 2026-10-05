# Fork upstream sync 2026-10-05 — 1.0.1 → 1.0.3

Worktree: `lue-pii-sync-103`, branch `lue/pii-sync-103`.
Lane: Harbor `pii-sync-103`, attempt 7.

## B / L / U

| | SHA | Proof |
|---|---|---|
| B (last integrated upstream) | `a7229ddc2` = tag `v1.0.1` | second parent of the prior upstream sync; ancestor of `v1.0.3` |
| L (fork) | `dc8004ef3` = `origin/main` | merged PR #582 after PR #581; task-pinned base was advanced by captain direction |
| U (upstream) | `d78dc83d6` = tag `v1.0.3` | upstream tag selected for this sync |

Range `v1.0.1..v1.0.3` = 29 commits, 140 files. Operation: ordinary two-parent merge of `v1.0.3` into a branch based on `origin/main`; no rebase. The merge reported 18 conflicting paths.

## Classification

| Class | What |
|---|---|---|
| adapt (package identity) | The 12 conflicting package/install-lock manifests: `packages/agent/package.json`, `packages/ai/package.json`, `packages/client/package.json`, `packages/coding-agent/package.json`, `packages/coding-agent/install-lock/package.json`, `packages/coding-agent/install-lock/package-lock.json`, `packages/durable/package.json`, `packages/evals/package.json`, `packages/protocol/package.json`, `packages/server/package.json`, `packages/telemetry/package.json`, and `packages/tui/package.json`. Keep fork-owned package names and exact internal pins at 1.0.3; retain upstream-compatible dependency changes; regenerate the root and coding-agent install lockfiles. Preserve upstream scopes for dependencies the fork does not own. |
| adapt | `packages/ai/src/api/openai-responses.ts`: retain the fork’s cache-safe `resolveMidConvoEffort` baseline and provider metadata, while adopting upstream’s sampling-parameter resolution and reasoning-summary default. |
| adapt | `packages/coding-agent/src/extensions/codemode/execute.ts` and `packages/coding-agent/src/extensions/mcp/tools.ts`: keep fork-scoped `@lue-labs` types, use upstream’s shared `writeOutputFile` helper, remove now-unused fork-local temp-file imports, and retain MCP resource conversion. |
| adapt | `packages/coding-agent/test/suite/agent-session-mcp.test.ts`: keep upstream’s deterministic integration coverage and temporary-file cleanup, using the fork-scoped `pi-ai` imports. |
| adapt | `packages/durable/src/harness/types.ts`: keep the fork-scoped `pi-ai` import and add upstream’s `ShellOutputSkip` / `ShellOutputWindow` environment types. |
| adapt (fork delta) | `.github/workflows/durable-env.yml` is new in upstream v1.0.3 and absent from fork main. Quote `$(which fdfind)` in the `ln -s` command to satisfy actionlint/ShellCheck SC2046 without changing behavior. |
| reject | `.github/workflows/nix.yml`: it is absent from fork main and includes tag-triggered `stable` branch updates and catalog-pin commits. Keep the fork’s deletion; `flake.nix`, `flake.lock`, and `nix/` remain inert source. |
| reject | `packages/durable/test/provider-session-cache-e2e.test.ts`: it reads local Codex authentication and makes live model requests. Remove it under the no-unapproved live/stochastic-test constraint. |
| preserve (captain decision) | Keep merged PR #581’s revert of #579. Do not restore the used-context-token footer; my-pi’s utilities extension provides that display. This supersedes the earlier task-pinned #579 requirement. |
| preserve | Keep #578’s context-file realpath deduplication in `packages/coding-agent/src/core/resource-loader.ts` and its regression tests. |

## Gates and review

- `npm --prefix packages/ai run generate-models`: exit 0; regenerated provider catalogs and model IDs.
- `npm run check`: exit 0 after generation, including Biome, changelog, pinned/runtime dependencies, import and entry-graph checks, install-lock, TypeScript, and browser smoke.
- Changed tests: `packages/ai` 146 passed / 672 skipped across 20 files; `packages/coding-agent` 249/249; `packages/durable` 341 passed / 1 skipped; `packages/tui` 71/71. The #578 realpath-dedupe regression passed separately (1 selected test).
- `npm run test:build-gate`: first run failed one MCP codemode setup wait (441/442); the focused test passed and a full rerun passed. Rerun results: system-prompt 148/148, cache-stability 32 passed / 4 skipped, coding-agent suite 442/442. The configured loader-resolver step skipped its pending fork-seam test. The my-pi extension step skipped because the expected sibling path is absent; the actual my-pi checkout is dirty, so it was not forced through the override.
- Independent PR review, merge, clean post-merge build/smoke gate, and promotion are pending.

## PR status (2026-10-05)

- Pushed branch `lue/pii-sync-103` over the authorized SSH URL; draft PR #583 targets `main`.
- The first GitHub CI run passed `check`, `review`, `gate`, `label`, `fork-safety-check`, and `mcp-conformance`; `actionlint` failed on the SC2046 warning documented above. `unit-tests` was still running when checked. The lint fix requires a new CI run.
- Independent model-family review, PR merge, clean post-merge build/smoke gate, and local `pii` promotion remain pending. No Harbor completion report has been made.
