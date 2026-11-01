<!-- pi-mono-fork PR template. Gate mirrors AGENTS.md "PR Review Gate". CONTRIBUTING.md covers the external contributor gate. -->

## Summary

<!-- What changed and why. -->

## PR gate

Run the local review gate before requesting review/merge (wire via `pr-pipeline-orchestrator`), then tick each pass:

- [ ] `codex-review` — second-model correctness pass (bugs, stale-vs-real)
- [ ] `code-craft-pr` — architecture + craft pass
- [ ] `matt-pocock/improve-codebase-architecture` — architecture deepening / refactor opportunities
- [ ] `docs-freshness-pr` — dead refs, broken links, landed-TODO drift
- [ ] All Tier 1/2 findings resolved; Tier 3 filed as GitHub issues (link them below)

## Verification

- [ ] `npm run check` passes (full output, no tail; fix all errors/warnings/infos)
- [ ] `./test.sh` passes for touched packages
- [ ] `npm run test:build-gate` green
- [ ] Touched package `CHANGELOG.md` updated under `[Unreleased]` (code changes only)

## Extension-first

- [ ] Core change made only where extension/package APIs are insufficient (reason noted); otherwise routed through a `my-pi` extension/hook/filter

<!-- Tier 3 issues, deviations, notes: -->
