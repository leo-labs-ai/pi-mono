# Fork upstream sync 2026-10-02 — 0.99.1 → 1.0.0

Worktree: `~/.herdr/worktrees/pi-mono-fork/lue-sync-upstream-1-0-0`, branch `lue/sync-upstream-1.0.0`.
Base (fork): `origin/main` = 6a3c92b25 (PR #565, carries upstream 0.99.1).
Upstream: tag `v1.0.0` = a13d35a74 (carries v0.99.2). Merge-base (last reviewed
upstream): d86654abb (Release v0.99.1). Range d86654abb..v1.0.0 = 88 commits,
682 files. Merge commit: `Merge upstream Pi v1.0.0 into the fork`.

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
| reject | `.github/workflows/ci.yml` (+`mcp-conformance` job), `.github/workflows/build-binaries.yml` (+`SOURCE_REF` smoke-test checkout and codemode binary smoke) | Kept byte-identical to origin: the push token lacks the `workflow` scope. Captain follow-up below. |
| defer | Fork-seam re-graft residual from the 0.99.0 reset (`shouldStopAfterTurn`, cache-safe compaction, `adoptInheritedForkMessages`, deferred-tool Anthropic patches, TUI focus gate and background continuity sources, …) | Unchanged by this sync. Fork-only tests `packages/tui/test/{tui-focus-gate,background-continuity}.test.ts` fail on `origin/main` and still fail here (7 subtests); everything else in the tui suite passes serially. |

## Conflict resolutions (35, normalized)

- 10 modify/delete → `git rm` (upstream deletions, see adopt rows).
- `.github/workflows/{build-binaries,ci}.yml` → ours (reject row).
- 9 `packages/durable/test/*`, `scripts/local-release.mjs`, `packages/ai/README.md`, `packages/server/README.md` → theirs, then scope rename.
- `tsconfig.json`, root `package.json`, `packages/{agent,ai,client,coding-agent,durable,evals,server}/package.json` → hand-merged (adapt rows).
- `packages/coding-agent/{npm-shrinkwrap.json,install-lock/package-lock.json}` → regenerated.

## Gates

- `npm run check` green (biome, changelog, pinned-deps, runtime-deps, ts-imports, entry-graphs, shrinkwrap, install-lock, `tsc --noEmit`, browser smoke).
- `npm run build:offline` green; `dist/cli.js --version` → `1.0.0`.
- `test:system-prompt` 148/148, `test:cache-stability` 32 passed / 4 skipped, `test:e2e` (suite) 96 files / 431 tests passed.
- `packages/durable` 853 passed / 1 skipped; `packages/agent` 90 passed; `packages/ai` 1237 passed / 853 skipped (no keys); `packages/tui` serial run: only the two pre-existing fork-seam files fail (same on `origin/main`).

## Captain follow-ups (cannot be pushed from this lane)

- Apply upstream's `ci.yml` `mcp-conformance` job and `build-binaries.yml` smoke-test checkout to the fork workflows (needs a token with `workflow` scope).
- `.github/workflows/agentic-review.yml:127` still builds `packages/session-backends/sqlite-node`, which no longer exists; replace with `npm --prefix packages/durable run build` (after `ai`, before `agent`).
