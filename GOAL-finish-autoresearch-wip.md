# Goal: Finish autoresearch WIP (subagents config + bash bg/output/kill) on top of triggerTokens port

## Context

`autoresearch/codex-cache-hit-rate-2026-05-12` carries one WIP snapshot commit:

- **`81f12007 wip: snapshot autoresearch branch state`** — 27 files, 483 inserts, never merged.

Bundled features:

1. **`compaction.triggerTokens`** — DONE. Surgically ported on branch `feat/compaction-trigger-tokens` as commit `d5ad4a51`. Includes the caller-side plumbing the WIP forgot (threading `contextWindow` into `getCompactionSettings()` from the three call sites in `agent-session.ts`). Do not redo.
2. **`settings.subagents`** — default model/thinking for native child agents, optionally per parent provider. UNPORTED.
3. **bash background runs** — `run_in_background`, `bash_output(bgId)`, `bash_kill(bgId)`. UNPORTED. Referenced commit on the same branch: `5e3a4e3d feat(bash): add run_in_background + bash_output + bash_kill`.
4. Plus drive-by churn: agent-runs-selector tweaks, agent tool changes, status fields, system-prompt edits, args parsing, lots of tests. Triage; cherry-pick only what each feature needs.

## Branches & commits

- Start branch: `feat/compaction-trigger-tokens` (off `main`, contains `d5ad4a51`).
- Source: `autoresearch/codex-cache-hit-rate-2026-05-12`, commits `81f12007` (WIP snapshot) and `5e3a4e3d` (bash bg/output/kill — landed cleanly there).
- Inspect: `git show 81f12007 --stat`, `git show 5e3a4e3d --stat`.

## Deliverables

### A. Bash background runs

Port `5e3a4e3d` cleanly onto `feat/compaction-trigger-tokens`. It looks like a self-contained feature commit — try `git cherry-pick 5e3a4e3d` first. If it conflicts, port the slices: tool definitions in `src/core/tools/`, registration in the tool runtime, AgentSession lifecycle hooks for tracking bg processes, tests.

Acceptance:

- `run_in_background({ command, description })` returns `{ bgId }`.
- `bash_output(bgId)` returns recent stdout/stderr since last poll, plus `exitCode` once finished.
- `bash_kill(bgId)` SIGTERMs then SIGKILLs after 3s.
- Bg processes are cleaned up on session shutdown.
- `npx vitest run` passes; new tests cover happy path + kill + cleanup.
- Document in `packages/coding-agent/docs/usage.md` or `tools.md` (whichever already documents `bash`).
- Update `FORK-CHANGELOG.md`.

### B. Subagents config

From `81f12007`, port only the subagents slice:

- `src/core/settings-manager.ts` — `SubagentThinkingSetting`, `SubagentDefaultSettings`, `SubagentSettings`, `settings.subagents`, `getSubagentSettings()`.
- `src/core/tools/agent.ts` + `src/core/agents/executor.ts` — apply precedence: explicit task option > agent frontmatter > `settings.subagents` > parent inheritance.
- `src/core/agents/types.ts` + `status.ts` — whatever metadata is needed to surface the effective model/thinking.
- `docs/settings.md` — the `subagents` section that's already in the WIP diff is good; reuse.
- Tests: `test/agent-model-selection.test.ts`, additions to `test/tools.test.ts`, `test/args.test.ts` — port the relevant cases.

Acceptance:

```json
{
  "subagents": {
    "defaults": { "thinking": "off" },
    "providers": {
      "openai-codex": { "model": "gpt-5.5", "thinking": "medium" },
      "claude-bridge": { "model": "claude-sonnet-4-6", "thinking": "off" }
    }
  }
}
```

- Native child agents pick model/thinking via precedence above. Verify with a unit test per layer.
- `agent` tool calls without overrides honour `subagents.providers[<parent.provider>]` first, then `subagents.defaults`.
- `npx vitest run` passes. Typecheck clean (`npx tsgo -p tsconfig.build.json --noEmit`).

### C. Drop the rest

Do not port: codex prompt cache affinity, generated model lists refresh, semantic-grep sqlite blobs, `.pi/` artefact churn, FORK-CHANGELOG noise from the WIP commit. If a hunk is unclear, leave it out and note in the PR description.

## Process

1. `cd ~/Projects/personal/pi-mono-fork && git checkout feat/compaction-trigger-tokens`
2. For each deliverable: cherry-pick or hand-port → typecheck → run the touched tests → commit as a focused commit (`feat(bash): …`, `feat(subagents): …`). One feature per commit.
3. Full gate before declaring done:
   - `npx tsgo -p tsconfig.build.json --noEmit` in `packages/coding-agent`
   - `npx vitest run` in `packages/coding-agent`
   - `~/Projects/personal/rusty/scripts/update-pi-agent` to rebuild + reinstall the local pi binary
   - Smoke: `pi -p "reply ok" --model openai-codex/gpt-5.5`
4. Update `FORK-CHANGELOG.md` once at the end with three bullets (triggerTokens, bash bg, subagents).
5. Don't open a PR — these are fork-only changes. Stay on the feature branch until Luke says ship.

## Watch-outs

- The WIP commit's `getCompactionSettings()` change was a no-op without caller updates. Same lesson applies for subagents: search for every read site of `settingsManager` and confirm the new fields are actually consumed.
- `agents/executor.ts` is shared with running-tasks panel + forkAgent recent work (see `main` log: `7a803bcb`, `76e16971`). Rebase early; expect conflicts there. Resolve by keeping `main`'s structure and layering subagents resolution on top.
- Bash bg lifecycle must not leak processes across `/clear` or session reload — add an explicit teardown test.
- Keep commits surgical. If a single commit grows past ~10 files, split it.

## Done when

- `git log main..feat/compaction-trigger-tokens` shows three clean commits: triggerTokens (already there), bash bg, subagents.
- Full gate green.
- `FORK-CHANGELOG.md` updated.
- Local `pi` rebuilt + smoke-tested.
