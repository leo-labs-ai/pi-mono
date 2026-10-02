# Fork upstream sync 2026-10-02 — 0.99.1 → 1.0.0

Worktree: `~/.herdr/worktrees/pi-mono-fork/lue-sync-upstream-1-0-0`, branch `lue/sync-upstream-1.0.0`.
Base (fork): `origin/main` = 6a3c92b25 (PR #565, carries upstream 0.99.1).
Upstream: tag `v1.0.0` = a13d35a74 (carries v0.99.2). Merge-base (last reviewed
upstream): d86654abb (Release v0.99.1). Range d86654abb..v1.0.0 = 88 commits,
682 files. Merge commit: `Merge upstream Pi v1.0.0 into the fork`, followed by
`docs(sync)`, `chore(sync): adopt upstream 1.0.0 workflow changes` and the
cherry-pick `fix(extensions): reuse upstream host aliases and canonicalize
linked entries` (from `de1fffac4`, PR #568). Two CI fixes followed the first
PR run (see "CI vs baseline" below).

## Method

A naive `git merge v1.0.0` produced 192 conflicts, 109 of them pure
`@earendil-works/pi-*` ↔ `@lue-labs/pi-*` scope churn. The merge was instead
done against scope-normalized synthetic commits (B', U' = upstream base/tip with
the fork's scope rename and `biome check --write` applied; L' = fork tree on
B'), which left 35 real conflicts. The resolved tree was committed with the
real parents (6a3c92b25, v1.0.0), so history is an ordinary two-parent merge.

## What changed upstream

- **pi-durable** (`packages/durable`) replaces `packages/session-backends/
  sqlite-node` and the experimental harness that lived in `pi-agent-core`
  (Packages 16–23: tool turns, live UI, subagents/ownership, structured
  concurrency, compaction/overflow, extensions, lifecycle conformance, task
  graph view; async SQLite storage). The experimental client/server and a TUI
  coding agent were ported onto it.
- **coding-agent**: fullscreen is the default TUI mode; header-only
  `quietStartup`; durable TUI task panel on by default; smaller codemode
  prompt, `models.generateImages()`, MCP servers listed instead of tools;
  MCP: OAuth credentials per server name+URL, provider-login auth,
  `oauth.authServerMetadataUrl` + RFC 9207 `iss` check, custom client name,
  tool names aligned with codemode identifiers, no first-prompt wait, tools
  restored on resume/reload, official client conformance suite
  (`test:mcp-conformance`); Radius provider; `--provider` requires `--model`;
  newly added `defaultTools` enabled on reload.
- **ai**: Anthropic workload identity federation and copy-code OAuth login,
  non-strict tools for schemas with rejected keywords, exponential backoff on
  unparseable Retry-After, Z.AI CN overflow detection, lightweight
  `pi-ai/models` entry, grammar tool-call replay fix.
- **tui**: less memory per rendered message (`flattenLines`), ANSI order kept
  at slice boundaries, slash completion after leading whitespace.
- **mcp**: granted scopes kept on step-up, empty/null optional OAuth fields,
  fetch called without receiver.

## Classification

| Class | Upstream change | Fork handling |
| --- | --- | --- |
| adopt | Everything under `packages/{ai,agent,client,protocol,server,telemetry,tui,codemode,mcp,chord}/src` and `packages/coding-agent/src` (all 88 commits' source) | Taken verbatim after scope rename; fork patches (`addedToolNames`, TUI editor highlighter / layout graph+renderer / stdin buffer / focus-reporting / background-continuity sources) merged cleanly on top. |
| adopt | `packages/durable` (new package, 0.99.0→1.0.0 work) | Workspace member `@lue-labs/pi-durable` at lockstep 1.0.0; built by root `build`; **not wired into `pii`** (no my-pi consumer). |
| adopt | `feat(agent): remove the experimental harness from pi-agent-core`; deletion of `packages/session-backends/sqlite-node`, `mini-test.sh`, `packages/agent/benchmark/tsconfig.json`, `packages/agent/docs/*` | Deletions accepted (10 modify/delete conflicts); fork tsconfig aliases for `pi-agent-core/{harness/session/testing,experimental/pico3,node,session/testing}` and `pi-session-backend-sqlite-node` dropped; `.changeset/config.json` fixed group swaps sqlite-node for durable. |
| adopt | `scripts/local-release.mjs`, `scripts/smoke-test-codemode-binary.mjs`, `packages/{ai,server}/README.md`, `.github/APPROVED_CONTRIBUTORS`, root `test:mcp-conformance` script | Upstream versions. |
| adapt | Root `package.json` | Upstream workspaces/scripts (durable in, session-backends out) plus the fork's `build` → `test:build-gate` hook. |
| adapt | `packages/*/package.json` version bumps (`^1.0.0`) | Fork lockstep **1.0.0**: `@lue-labs/pi-*` pinned exact, `@earendil-works/{pi-codemode,pi-mcp}` exact, `@earendil-works/chord` `^1.0.0`; `packages/agent` keeps `typescript 7.0.2`. `scripts/sync-versions.js` reports lockstep OK. |
| adapt | `tsconfig.json` | Fork dual-scope path aliases; added `pi-durable`/`pi-durable/*` (66 paths). |
| adapt | `packages/durable/test/*`, `packages/durable/vitest.config.ts` | Imports rewritten to `@lue-labs/pi-durable`; vitest keeps a dual alias so upstream-authored tests resolve either scope. |
| adapt | `package-lock.json`, `packages/coding-agent/npm-shrinkwrap.json`, `packages/coding-agent/install-lock/` | Regenerated with the fork generators (`npm install --package-lock-only --ignore-scripts`, `generate-coding-agent-{shrinkwrap,install-lock}.mjs`); no new external deps. |
| equivalent | `fix(tui): preserve ANSI order at slice boundaries`, `reduce memory retained per rendered message` | Land in `packages/tui/src/utils.ts` next to the fork's own `utils.ts` patch; both kept, no overlap. |
| equivalent | Package `CHANGELOG.md` files | Fork-owned stubs (`merge=ours`, docs/adr/0002); upstream text continues to live in `CHANGELOG.upstream.md`. |
| adapt | `.github/workflows/ci.yml` (+`mcp-conformance` job), `.github/workflows/build-binaries.yml` (+`SOURCE_REF` smoke-test checkout and codemode binary smoke) | First resolved as ours (the `gh` token lacks the `workflow` scope), then adopted in a follow-up commit once SSH push was confirmed: `ci.yml` gains the `mcp-conformance` job in the fork's install shape (node 24, GitHub Packages registry, `NODE_AUTH_TOKEN`, `contents: read` / `packages: read`; upstream's `npm test` step dropped); `build-binaries.yml` taken from PR #568's resolution (`64afbaefa`: `contents: read`, `inputs.*` `SOURCE_REF` fallbacks, smoke checkout, codemode binary smoke); `agentic-review.yml` builds `packages/durable` instead of the removed `session-backends/sqlite-node`. `actionlint` clean; `npm run test:mcp-conformance` passes locally. |
| adopt (sibling lane) | `de1fffac4` from `lue/pi-upstream-0992-0930` (PR #568): `@earendil-works/pi-{coding-agent,agent-core,tui,ai,ai/providers/all,ai/compat,ai/oauth}` host aliases in the extension loader and bundled virtual modules; linked extension entries canonicalized with `realpathSync` before Jiti; `test/extension-host-aliases.test.ts` | Required, not optional: without it the 1.0.0 build's `pii -p` smoke printed nothing and failed two profile extensions (`tokenjuice.js: Cannot find module './policy.mjs'`, `@howaboua/pi-codex-conversion: Cannot find module '@earendil-works/pi-ai'`). Cherry-picked with `-x`; applies cleanly on 1.0.0. PR #568 itself is left untouched (its upstream content is a subset of this branch). |
| re-graft (review repair) | Fork behaviours dropped by the 0.99.0 green-path reset (`c059384c9`) that the independent review of PR #571 required back, compared against the actual pre-reset fork main `206aef83d` | Five patch-level fork commits, each with provenance and a FORK-CHANGELOG bullet; see "Review repair" below. |
| defer | Remaining fork-seam residual from the 0.99.0 reset (`shouldStopAfterTurn`, `adoptInheritedForkMessages`, deferred-tool Anthropic patches, ThinkingLevel `ultra`/`adaptive`, footer usage-cache, bash background jobs, task registry, `extensionConfig`, `ToolPanel`, …) | Unchanged by this sync; itemized with sizes under "Open seams" below. |

## Review repair (against fork main `206aef83d`)

The different-family review of PR #571 (`harbor/state/reviews/pm571.md`) failed
the sync because it compared against the reset fork main rather than the real
one (`206aef83d`, "chore(release): version fork packages (#544)", coding-agent
0.87.1), and found fork behaviours missing that the sync had classified as
`defer`. Each is now a patch-level fork commit on top of the merge:

| # | Behaviour | Commit | Re-grafted from | Deviation from `206aef83d` |
| --- | --- | --- | --- | --- |
| 1 | Opaque Codex gateway credentials (ClawRouter): `sendChatgptAccountId`, `supportsWebSocketTransport`, `supportsZstdRequestCompression` compat flags | `bb428acd6` | `454ae229b` (#298), `077913c02` (#299), `a41aa35fa` (#459) | Patch-level, not whole-file: cache-affinity keying, thread-id headers, websocket continuations, deferred tools and the debug snapshot of the fork's Codex transport are not ported (open seams). #298's agent-session tool-name filter not ported. |
| 2 | Provider-qualified model references resolve only through that provider | `238b04920` | `ab9170a79` (#162), `858a331d5`, tests `bd83bcacb` | None; upstream's bare-vendor-id tests replaced by the fork's policy tests. |
| 3 | `modelVisible: false` custom messages stay out of provider context | `36493530a` | #528 | Threaded through 1.0.0's new surfaces (`_applyBoundaryDrafts`, `message_end` persistence, branch summaries); `wakeOnIdle` and `packages/agent/src/harness` out of scope. |
| 4 | Cache-safe compaction + summary grounding rules | `86b621a7e` | `cff1cf52c`, `9b3a20591`, `144632035`, `703283830`, `894a613ed` (#549) | `CacheSafeCompactionContext = { messages }` (1.0.0 transcripts carry the system message and tool declarations; `normalizeContext` is branded). Context built via the agent's `transformContext` + `convertToLlm` (the fork skipped `transformContext`; at 1.0.0 `AgentSession` chains projections into it that change the cached prefix). Retention mirrors the live loop (`PI_CACHE_RETENTION=long` → long, else short) instead of the fork's hardcoded `"long"`, because 1.0.0's loop sends no retention. `stripModelFacingContextImages` not ported (fork-only `tool-artifacts.ts`). Legacy standalone path keeps upstream's `TURN_PREFIX_SUMMARIZATION_PROMPT`. |
| 4b | Compaction summaries run with thinking off | `e4c0002bb` + follow-up | `39a3a49fa` | Applied at the `AgentSession` seam, not inside `compact()`: the fork's unconditional override broke upstream's virtual-model routing (`virtual-models.test.ts` expects the router's level on compaction summaries). A routed level is kept; the inherited session level is replaced by `off`; direct `compact()` callers keep the level they pass. `getSummarizationFailure`'s length-stop guard had survived the reset. |
| 5 | TUI DEC 1004 focus gate consumer; `Box` background continuity | `3101f5874` | `38110b709`, `d40e64763` (#442) | `Box.applyBg` keeps upstream `54c19a252`'s single measurement by letting `applyBackgroundToLine` pad. Fork-only `ToolPanel` (`tool-panel.ts`) not ported. |

Each commit carries a regression test that fails with the source change
stashed (negative control) and passes with it. Tests moved from pinning the
reset behaviour to pinning the fork behaviour: `test/suite/agent-session-compaction.test.ts`
"uses the standalone compaction request context" (asserted `transformContext`
not called and `cacheRetention: "none"`) is now "uses the cache-safe compaction
request context without the active agent transport"; `test/model-resolver.test.ts`
bare-vendor-id matches replaced by the slash-means-provider tests;
`test/compaction-summary-reasoning.test.ts` "honors caller-supplied routing
session and tool choice without prompt caching" now expects caller retention
to be honored.

### Open seams (still dropped by the reset; not addressed here)

| Seam | Where on `206aef83d` | Size | my-pi consumer |
| --- | --- | --- | --- |
| Bash background jobs (`createBashBgJobStore`, `bash-kill`/`bash-output` tools, extension bridge) | `core/bash-bg-jobs.ts`, `core/extensions/bash-bg-jobs.ts`, `core/tools/bash-{kill,output}.ts` | ~1500 lines | `native-tool-overrides` (5 gate suites) |
| Task registry (`TaskStatus`, `isTerminalTaskStatus`, `TaskSnapshot`) | `core/tasks/{index,types}.ts` | ~180 lines + consumers | `agent-panel` (1 suite) |
| `extensionConfig` settings namespace (`SettingsManager.getExtensionConfig`/`setExtensionConfigValue`, `ExtensionAPI.getExtensionConfig`) | `core/settings-manager.ts`, `core/extensions/extension-api-fork.ts` (392 lines), `resource-loader.ts` | ~450 lines | `skill-workshop`, `pi-worktree` deps test (2 suites) |
| Fork-only `ToolPanel` component | `modes/interactive/components/tool-panel.ts` (96 lines) + `tool-execution.ts` wiring | ~170 lines | none direct |
| Codex transport remainder: cache-affinity keying, thread-id headers, websocket continuations, deferred tools, debug snapshot | `packages/ai/src/api/openai-codex-responses.ts` | fork delta +323/−65 vs its upstream base | clawrouter routing (works without them) |
| Fork `cache-retention.ts` (`"long"` default for the main loop) | `packages/ai/src/utils/cache-retention.ts` | ~40 lines | behaviour: 1.0.0 defaults to short retention unless `PI_CACHE_RETENTION=long` |
| Mid-run tool-result cap + `stripModelFacingContextImages` image budget | `core/tool-artifacts.ts` | 385 lines | compaction continuation |
| `shouldStopAfterTurn`, `adoptInheritedForkMessages`, deferred-tool Anthropic patches, ThinkingLevel `ultra`/`adaptive`, footer usage-cache | various | — | listed by the reset's own FORK-CHANGELOG entry |

## Conflict resolutions (35, normalized)

- 10 modify/delete → `git rm` (upstream deletions, see adopt rows).
- `.github/workflows/{build-binaries,ci}.yml` → ours in the merge commit, upstream changes re-applied in `chore(sync): adopt upstream 1.0.0 workflow changes` (adapt row).
- 9 `packages/durable/test/*`, `scripts/local-release.mjs`, `packages/ai/README.md`, `packages/server/README.md` → theirs, then scope rename.
- `tsconfig.json`, root `package.json`, `packages/{agent,ai,client,coding-agent,durable,evals,server}/package.json` → hand-merged (adapt rows).
- `packages/coding-agent/{npm-shrinkwrap.json,install-lock/package-lock.json}` → regenerated.

## Gates

- `npm run check` green (biome, changelog, pinned-deps, runtime-deps, ts-imports, entry-graphs, shrinkwrap, install-lock, `tsc --noEmit`, browser smoke).
- `npm run build:offline` green; `dist/cli.js --version` → `1.0.0`.
- `test:system-prompt` 148/148, `test:cache-stability` 32 passed / 4 skipped, `test:e2e` (suite) 96 files / 431 tests passed.
- `packages/durable` 853 passed / 1 skipped; `packages/agent` 90 passed; `packages/ai` 1237 passed / 853 skipped (no keys); `packages/tui` serial run: only the two pre-existing fork-seam files fail (same on `origin/main`) — after the review repair (`3101f5874`) the tui suite is **1061 passed / 1 skipped / 0 failed** serially.
- Review repair (head `79fa9b837`): `npm run check` and `npm run build:offline` green; `test:system-prompt` 148/148; `test:cache-stability` 32 passed / 4 skipped; `test:e2e` 97 files / 433 tests; coding-agent compaction/session files (56 files) 470 passed / 28 skipped; `packages/ai` `openai-codex-stream.test.ts` 43/43; `model-resolver` 52/52; `packages/tui` serial 1061 passed / 1 skipped; `test:mcp-conformance` "No regressions against the baseline" (the same three suites fail as in the baseline run); my-pi extension gate re-run on the rebuilt `dist`: **96/107 with the identical failure set** as before the repair (no regression from the re-grafts); `pii -p` smoke with `PI_BIN` → this build: `OK`, exit 0, same two warnings.
- `npm run test:mcp-conformance`: no regressions against the baseline. Cherry-pick: `tsc --noEmit` clean, `extension-host-aliases` + regression tests 8237/9540 pass (3 files / 5 tests).
- my-pi extension gate (`npm run test:extension-gate`, my-pi `fc48b0f5` in an isolated lane with `@lue-labs/pi-*` repointed at this build): **96/107 suites**. None of the 11 failures is a 0.99.1 → 1.0.0 regression:
  - 8 are fork-API drift from the 0.99.0 green-path reset — `createBashBgJobStore` (`native-tool-overrides` ×5), `isTerminalTaskStatus` (`agent-panel`), `SettingsManager.getExtensionConfig` (`pi-worktree` deps test, `skill-workshop`) exist only on the pre-reset fork (`206aef83d`) and are absent on `origin/main`, `v1.0.0` and this branch alike.
  - 2 are lane environment — `pi-memory:cache` re-fetched `@lue-labs/pi-coding-agent@0.87.1` from GitHub Packages via pnpm (`ERR_PNPM_IGNORED_BUILDS`) and `psyche-cli:smoke` cascades from it (better-sqlite3 binding never built).
  - 1 is anchor drift — `vanilla-wake-pin` fails identically against the canonical my-pi checkout because vanilla `pi` is already 1.0.0.
- `pii -p` smoke (profile `@valkyriweb/my-pi-full`, `PI_BIN` → this build's `dist/cli.js`): before the cherry-pick, empty stdout and two extension load failures; after it, `OK` with exit 0 and only the two warnings the promoted 0.99.2 build also emits (builtin `mcp` skipped for pi-mcp-adapter's `/mcp`; typebox peer warning). `--list-models` shows the same clawrouter `claude-fable-5*`, `claude-haiku-4-5`, `gpt-6-astra(-200k)`, `gpt-6-sol` entries as the promoted build, and a tools-list prompt returns the identical tool set. `supportsMidConvoEffort` (ai `types.ts`, `anthropic-messages.ts`, coding-agent `model-config.ts`) is unchanged by the merge; `configuration_update`, `adoptInheritedForkMessages`, `shouldStopAfterTurn` and `clawrouter` have no source occurrences on `origin/main` either (reset residual, not a regression).

## CI vs baseline

The first PR run (36986153227, head `4d5217193`) was red on `unit-tests`,
`fork-safety-check` and `mcp-conformance`. A dispatched baseline run on
`origin/main` `6a3c92b25` (36988317541) is red on the first two with the same
failures; `mcp-conformance` has no baseline because the job is new on this
branch (adopted from upstream 1.0.0). After `521114aca` + `7d7608a19` the rerun
(36989421571, head `7d7608a19`) is green on `fork-safety-check` and
`mcp-conformance`; `unit-tests` is left with only the `packages/tui` failures
that main has too.

| Job | main `6a3c92b25` (36988317541) | #571 `4d5217193` (36986153227) | #571 `7d7608a19` (36989421571) | Cause | Fix |
| --- | --- | --- | --- | --- | --- |
| unit-tests | red: `pi-coding-agent` (`extensions-discovery` #9863 test), `pi-ai` (`together-models`), `pi-tui` (`tui-focus-gate` 2 + `background-continuity` 5 subtests) | red: same three workspaces | red: `pi-tui` only, same 7 subtests as main | #9863 test created its fake dependency under `node_modules/@earendil-works` while importing `@lue-labs/pi-coding-agent` (since the 0.99.0 scope rename; also red on #564/#565/#568). Together removed `deepseek-ai/DeepSeek-V4-Pro`, so CI's freshly generated catalog (`generate-models` runs at CI time; data is gitignored) no longer has it. tui: fork-seam residual from the 0.99.0 reset — DEC 1004 is enabled in `terminal.ts` but the focus-gate and background-continuity consumers were not re-grafted (`defer` above) | `521114aca` (test scope), `7d7608a19` (upstream `28eaccb8e`, #10336, cherry-picked `-x`); tui left as `defer` — needs the consumers re-grafted or the tests retired, not a sync-lane change |
| fork-safety-check | red: `tsc` TS2345 `DeepSeek-V4-Pro` in `together-models.test.ts` | red: same | green | catalog drift as above (passed on #565/#568 on 2026-09-29/30, before the catalog changed) | `7d7608a19` |
| mcp-conformance | n/a (job absent) | red: every case `client.ts wrote no report` | green | `source-resolver.ts` only applied `@earendil-works/*` tsconfig aliases, so `@lue-labs/pi-*` imports fell through to `dist`, absent in CI (`npm ci --ignore-scripts`, no build). Latent on main; surfaced by the new job | `521114aca`; verified locally with every `packages/*/dist` hidden: no regressions |

After the review repair, the run on head `3bb6679ca` (37031454690) is green on
all three jobs: `unit-tests` (110919037878 — the `pi-tui` subtests main fails
are fixed by `3101f5874`), `fork-safety-check` (110919037583) and
`mcp-conformance` (110919038021); Changelog, Workflow Sanity, Labeler and
Agentic PR Review are green too. First fully green CI on a fork PR since the
0.99.0 scope rename.

## Follow-ups

- `.github/workflows/release.yml:118` comment still mentions `session-backends` (comment only).
- `packages/coding-agent/src/experimental/**` imports `pi-durable` without declaring it in `package.json` (same as upstream; `check:runtime-deps` passes because the entry graph excludes it).
- my-pi still pins to the pre-reset fork API in 8 gate suites (see above); the gate only passes on the canonical checkout because that checkout's `@lue-labs/pi-*` links still point at the old fork main. Re-graft or retire those suites with the fork-seam re-graft.
- PR #568 (`lue/pi-upstream-0992-0930`, 0.99.2) is superseded by this branch for upstream content; its two fork commits are carried here (`64afbaefa` folded into the workflow commit, `de1fffac4` cherry-picked).
- ~~`packages/tui/test/{tui-focus-gate,background-continuity}.test.ts` still fail (pre-existing); `terminal.ts` enables DEC 1004 but `tui.ts` has no focus-gate consumer since the reset.~~ Fixed by `3101f5874` (review repair item 5).
- The three CHANGELOG-visible fork entries in `packages/coding-agent/CHANGELOG.md` (`merge=ours`) describe fork behaviour as present; after the review repair the compaction entries are true again, the others still describe reset-dropped seams.
