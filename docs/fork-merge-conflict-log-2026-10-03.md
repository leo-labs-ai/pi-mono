# Fork upstream sync 2026-10-03 — 1.0.0 → 1.0.1

Worktree: `~/Projects/personal/pi-mono-fork/.worktrees/lue-pii-update-1.0.1`, branch `lue/pii-update-1.0.1`.
Lane: Harbor `pii-update-1-0-1` (Luke authorized the pii update on 2026-10-03).

## B / L / U

| | SHA | Proof |
|---|---|---|
| B (last integrated upstream) | `a13d35a74` = tag `v1.0.0` | second parent of merge `fbaaa6131` on `lue/sync-upstream-1.0.0` (PR #571); `git merge-base --is-ancestor v1.0.0 origin/lue/sync-upstream-1.0.0` = yes |
| L (fork) | `9572a34c1` = `origin/lue/sync-upstream-1.0.0` (PR #571 head) | branch created from `origin/main` (6a3c92b25) and fast-forwarded; #571 is the open 1.0.0 sync, so this lane stacks on it instead of redoing the 106-commit 1.0.0 merge |
| U (upstream) | `a7229ddc2` = tag `v1.0.1` | `git fetch upstream --tags`; upstream/main is `83692682f` (2 commits past the tag: Nix workflow fix + Unreleased section — not taken) |

Range `v1.0.0..v1.0.1` = 28 commits, 136 files. Operation: whole-fork merge
(`git merge --no-commit --no-ff v1.0.1`), 20 conflicts (11 manifest/scope,
4 modify/delete, 2 source scope-only, README, root check script, install lock).

## Classification

| Class | What |
|---|---|
| adopt | all `packages/*/src` + test changes: MCP tool calls render before server connect (#10285), project `mcp.json` overrides global servers, opt-in MCP OAuth client-ID metadata, codemode output cap, Bedrock stale thinking blocks, Cloudflare Clef classifiers / dashed Claude IDs, Together DeepSeek V4 Pro ID, NVIDIA Nemotron 3 Ultra default, retry on "Selected model is at capacity", Anthropic mid-conversation tools defined inline, ChatGPT sign-in port-in-use failure, Kitty non-PNG image conversion, WezTerm scroll image preservation, OAuth URL copy (`auth-url.ts`), 3D pi logo / Armin easter eggs (daxnuts removed), `--models` empty-entry fix; `scripts/npm-audit.mjs` + node-forge advisory acceptance; `scripts/update-model-catalog-pin.mjs`; docs/README |
| adopt (supply chain) | `@anthropic-ai/sdk` 0.124.0 → 0.129.0; new direct pin `brace-expansion@5.0.12`; lockfile regenerated with `npm install --package-lock-only --ignore-scripts` (changed entries: `@anthropic-ai/sdk`, `brace-expansion` 5.0.9 → 5.0.12, and workspace/example version bumps — nothing else); install lock regenerated (212 packages) |
| adopt (release mechanics) | **npm shrinkwrap removed** (upstream `581e7ba78`): deleted `packages/coding-agent/npm-shrinkwrap.json`, `scripts/generate-coding-agent-shrinkwrap.mjs`, the `check:shrinkwrap` / `shrinkwrap:coding-agent` / `shrinkwrap` scripts, the `version-packages` shrinkwrap step and the CODEOWNERS line. The install lock (`packages/coding-agent/install-lock/`), which the fork already generates and checks, remains the pinned install path. `pii` is promoted from source, so no consumer loses pinning. Reversible if a fork npm consumer needs transitive pins. |
| adapt | lockstep **1.0.1** on every fork-owned `@leo-labs-ai/pi-*` manifest and exact internal pin; `@earendil-works/chord` `^1.0.1`, `@earendil-works/pi-codemode` / `pi-mcp` exact `1.0.1` (kept under upstream names per #571); install-lock root 1.0.1; scope rename applied to the four new/changed upstream files (`auth-url.ts`, `auth-url-copy.test.ts`, `easter-egg-3d.lazy.ts`, `image-convert.ts`) and to the two conflicted imports (`mcp/index.ts`, `tool-execution.ts`); dual-scope files (`virtual-modules.ts`, `loader.ts`, `check-entry-graphs.mjs`, evals Docker, `sync-versions`, …) kept the fork's mapping tables; `loader.ts` and `evals/docker/entrypoint.ts` three-way merged with `git merge-file` |
| equivalent | `49b9df489` (Nemotron) and `28eaccb8e` (DeepSeek) are also cherry-picked on PR #575; the merge carries the same patches, so #575 becomes redundant for those two once this lands |
| reject | `.github/workflows/nix.yml`: on `v*` tags it builds the flake and fast-forwards a `stable` branch, and on main it commits catalog-pin refreshes — remote-mutating automation the fork does not publish. `flake.nix`, `flake.lock`, `nix/` are kept as inert source to stay conflict-free. |
| defer | upstream/main commits after the tag (`83692682f`, `4c6fb7cfe`): next sync |

## Gates (this worktree)

- `git diff --check` and `git diff --cached --check`: clean; no conflict markers.
- `npm run check` (biome, changelog, pinned-deps, runtime-deps, ts-imports, entry-graphs, install-lock, `tsc --noEmit`, browser smoke): exit 0.
- `npm run build`: exit 0 (bundle 74 files).
- `npm run test:build-gate`: exit 0 (system-prompt 148/148, cache-stability 32 passed / 4 skipped, loader-resolver, e2e, my-pi extensions 435/435).
- `packages/ai` vitest: 1260 passed / 854 skipped; `packages/tui` `npm test` (node --test): exit 0; `packages/codemode` 63/63; `packages/mcp` 40/40; `npm run test:scripts` 36/0.
- `packages/coding-agent` targeted (model-resolver, extensions-discovery, mcp-extension, mcp-oauth-refresh, image-processing, tool-execution-component, auth-url-copy, args, export-html-whitespace, extensions-runner, 10285, 7027, compaction-summary-reasoning, agent-context-inheritance): 350/350.

## Fork-only behaviours checked

`supportsMidConvoEffort` / `configuration_update` (`packages/ai/test/openai-mid-conversation-effort.test.ts`, in the ai run), ClawRouter models.json routes (no provider code touched by B..U outside Bedrock/Cloudflare/Anthropic inline tools), cache-safe compaction, `shouldStopAfterTurn`, PI_COMMAND_NAME hints — all outside the B..U file set except `anthropic-messages.ts` (inline mid-conversation tool definitions, auto-merged, covered by cache-stability gate).

## Independent review

Static review by a different model family (GPT-6 Astra via clawrouter, `context: none`): **APPROVE WITH NITS**. No upstream source change or fork behaviour dropped. Nits: lockfile receipt corrected above; pre-existing (not introduced here) scope residue in `scripts/coding-agent-consumer.mjs`, `scripts/publish-release-announcement.mjs`, `scripts/durable-browser-smoke-entry.ts`, `packages/coding-agent/examples/plugins/pi-example-plugin/package.json` (`^0.84.4` peers) and a stale shrinkwrap comment in `scripts/check-changelog-updated.mjs:47-49` — left for a follow-up.

## Not done here

- No push to `origin` (needs Luke's approval). Never push `upstream`.
- PR target branch not specified by the lane contract; PR #571 is the natural base.
