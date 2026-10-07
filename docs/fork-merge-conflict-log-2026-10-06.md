# Fork upstream sync 2026-10-06 — 1.0.3 → 1.0.4

Worktree: `lue-pii-sync-104`, branch `lue/pii-sync-104`. Lane: Harbor `pii-sync-104`, attempt 1.

## B / L / U

| | SHA | Proof |
|---|---|---|
| B (last integrated upstream) | `d78dc83d6` = tag `v1.0.3` | second parent of merge `3f56750e1` (PR #583) |
| L (fork) | `2f514de8a` = `origin/main` | worktree base |
| U (upstream) | `7c10bd433` = tag `v1.0.4` | upstream tag selected for this sync (`upstream/main` is newer and not taken) |

Range `v1.0.3..v1.0.4` = 28 non-merge commits, 133 files. Operation: ordinary two-parent merge of `v1.0.4` into a branch based on `origin/main`; no rebase. 19 conflicting paths.

## Classification

| Class | What |
|---|---|
| adopt | New `packages/env` (`@earendil-works/pi-env`, SSH remote execution plus Rust daemon), durable PowerShell tool and watcher fixes, codemode built-in patch survival (`b223082bb`), codemode `read` image blocks (`021eae60a`), MCP OAuth `application_type`, MCP shutdown close, `--tools` MCP patterns and `--no-mcp`, HTTP/2 stream-cancel retry, hidden tools out of prompt rules, login-shell test fix |
| adapt (package identity) | 11 conflicting manifests and the install-lock: keep fork-owned names and exact 1.0.4 pins; `packages/env` imports and depends on `@lue-labs/pi-durable` (workspace name), adds root build/local-release/tsconfig entries; regenerate root and install lockfiles |
| adapt | `agent-session-codemode.test.ts`: upstream's added `writeFileSync`/`join` imports with the fork-scoped `pi-agent-core` type import |
| adapt (workflow) | `ci.yml`: keep fork jobs; add the pi-env daemon build before `./test.sh` in `unit-tests` (env tests require it). `env.yml`: quote `$(which fdfind)` (SC2046), shellcheck-ignore SC2016 on the embedded `node -e`, rename job `check` to `env-package` (it collided with the required `check` context) and drop its `npm run check` step (fork CI owns it; it needs `origin/main`, absent in that checkout) |
| equivalent | `durable-env.yml` deleted upstream; superseded by `env.yml` |
| reject | `build-binaries.yml` `env-daemons`, `publish-npm`, `announce-pi-dev-release` jobs: npm publish and R2 announce are remote mutations the fork does not run |
| preserve | #584 image stripping from errored `tool_result` blocks (Anthropic/Bedrock converters, codemode `execute.ts`); #581 revert; #578 realpath dedupe |
| defer | none |
