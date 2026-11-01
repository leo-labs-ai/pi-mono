# Merge conflict log — upstream/main → main (2026-05-23)

Upstream brought 17 commits (re-fetched mid-flow), fork was 163 ahead.
26 files auto-merged cleanly. 6 files needed manual resolution.

| # | File | Conflict | Resolution |
|---|------|----------|-----------|
| 1 | `AGENTS.md` | Upstream renumbered release step 4→5 (added "Verify npm authentication" + WebAuthn brief steps); fork kept old step 4 plus an explanatory sentence about what the release script does | Took upstream's renumber to 5, kept fork's explanatory sentence above it |
| 2 | `packages/coding-agent/examples/extensions/custom-provider-anthropic/package.json` | Tab-indented + version 0.75.4 (fork) vs space-indented + 0.75.5 (upstream) | `git checkout --theirs` (example metadata, upstream canonical) |
| 3 | `…/custom-provider-gitlab-duo/package.json` | Same as #2 | Same |
| 4 | `…/with-deps/package.json` | Same as #2 | Same |
| 5 | `packages/coding-agent/src/core/tools/bash.ts` | Imports: fork uses sync `closeSync/existsSync/mkdirSync/openSync/readFileSync/statSync` for bg-job log persistence; upstream added `constants` + async `fsAccess` for new cwd-existence check in `createLocalBashOperations.exec()` | Kept both — merged imports. Both code paths coexist (sync for bg-job, async for `BashOperations.exec`). |
| 6 | `packages/coding-agent/src/core/tools/edit.ts` | Upstream's "Finish async tool cleanup" / "Refine async tool control flow" rewrote the inner edit logic to use `withFileMutationQueue` wrapper (file read/transform/write happens once above the conflict). Fork still had the old inline `new Promise((resolve, reject) => { (async () => { … read file again, write again … })() })` block which became dead-code duplication. Fork added `hunks` + `originalContent` fields to `details` for `ColorDiffComponent` rendering. | Took upstream's clean mutation-queue structure (no redundant re-read/re-write). Kept fork's extra `hunks` + `originalContent` in the returned `details` since the fork's `formatEditResult` consumer relies on them. |

## Lessons

- **bash.ts** was the only "real" structural conflict — the fork's bg-job system was orthogonal to upstream's new `BashOperations.exec` async cwd check, so a clean import-line merge sufficed. **No new core hook would have prevented this conflict** — both sides legitimately needed imports in the same place. Acceptable noise.
- **edit.ts** is a clear "extract me" signal. Fork's only meaningful divergence in edit.ts is `hunks` + `originalContent` fields used by `ColorDiffComponent`. If those fields lived upstream, edit.ts would be zero-conflict. Two options:
  1. Upstream `generateDiffString` to always return them (most LOC; cheap upstream PR).
  2. Move the `ColorDiffComponent` consumer to its own extension that re-runs the diff on the result content. ~10 LOC duplication for the diff regenerate, **zero core fork**.
- The `createUppercaseXxx` aliases in 6 native tool files **did not produce conflicts this round** (upstream didn't touch the alias sites) but they're a latent risk every cycle. Worth extracting to an extension that calls `pi.registerTool({ name: "Edit", ...wrap(lowercaseEdit) })`.
- The 3 example package.json conflicts are pure upstream-tooling noise (formatting + version bump on examples). Could be eliminated by either:
  - Adopting upstream's tab/space convention in the fork commits, or
  - Excluding `examples/*/package.json` from fork edits entirely (we don't actually maintain them).
- The fork's bg-job system in bash.ts (~800 LOC) survived this cycle without conflict because upstream didn't touch its sites. **But that surface is large and will conflict eventually.** Extracting it to `my-pi/extensions/bash-bg` is the single highest-ROI extraction.
