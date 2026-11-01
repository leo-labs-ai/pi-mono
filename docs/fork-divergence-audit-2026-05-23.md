# Fork Divergence Audit — 2026-05-23

Audit performed before merging `upstream/main` (14 commits) into fork `main` (163 ahead).
Goal: assess whether existing fork hooks reduced conflicts, identify extraction targets.

## Pre-merge stats

- Fork `main`: **ahead 163, behind 14** of `upstream/main`
- Upstream-touched files in those 14 commits: **49**
- Fork-touched files in our 163: **837**
- **Conflict surface (files touched by both sides): 37 files**

## Conflict surface

```
AGENTS.md
package-lock.json
packages/agent/{CHANGELOG.md, package.json}
packages/ai/{CHANGELOG.md, package.json, src/models.generated.ts}
packages/coding-agent/CHANGELOG.md
packages/coding-agent/examples/extensions/{custom-provider-anthropic, custom-provider-gitlab-duo, sandbox, with-deps}/package*.json
packages/coding-agent/npm-shrinkwrap.json
packages/coding-agent/package.json
packages/coding-agent/src/cli/file-processor.ts
packages/coding-agent/src/core/package-manager.ts
packages/coding-agent/src/core/tools/{bash,edit,find,grep,ls,read,write}.ts
packages/coding-agent/src/utils/image-resize.ts
packages/coding-agent/test/{file-mutation-queue,image-processing,package-manager,tool-execution-component}.test.ts
packages/tui/{CHANGELOG.md, package.json, src/terminal.ts, test/terminal.test.ts}
scripts/{build-binaries.sh, local-release.mjs}
```

## Native tool fork mods — per file

| File | Fork delta | LOC fork-only | Hookable today? | Required hook if not |
|------|-----------|--------------:|-----------------|----------------------|
| `bash.ts` | Background job system (`BashBgJob` registry, `spawnBashBackground`, persistence to `~/.pi/agent/bash-bg/`), tools `bash_output` + `bash_kill`, `run_in_background` + `tui_only` params | ~800 | **Yes (via existing `pi.on("tool_call")` + `pi.registerTool`)** | — but `BashOperations` swap hook would also let SSH/remote backends live in extensions |
| `edit.ts` | `createUppercaseEditToolDefinition`/`Tool` alias | ~10 | Yes | None — `pi.registerTool({ name: "Edit", ... })` |
| `find.ts` | Uppercase alias | ~10 | Yes | None |
| `grep.ts` | Uppercase alias | ~10 | Yes | None |
| `ls.ts` | Uppercase alias | ~10 | Yes | None |
| `read.ts` | Uppercase alias | ~10 | Yes | None |
| `write.ts` | Uppercase alias | ~10 | Yes | None |
| `package-manager.ts` | None | 0 | n/a | n/a |
| `file-processor.ts` | None | 0 | n/a | n/a |
| `image-resize.ts` | None | 0 | n/a | n/a |
| `tui/terminal.ts` | None | 0 | n/a | n/a |

**Verdict on user's hypothesis:** Yes, native tools are the dominant conflict surface. But the dominant cause is the bash.ts fork mods (single heavy delta) and the uppercase variants (small but spread across 7 files). All of it is **extractable today** to `my-pi` without needing new core hooks.

## Existing extension surface (verified in code)

Already exposed via the documented extension API (`packages/coding-agent/docs/extensions.md`):

**Session/agent lifecycle:** `session_start`, `session_shutdown`, `session_before_{switch,fork,compact,tree}`, `session_{compact,tree}`, `agent_start`, `agent_end`, `before_agent_start`, `turn_start`, `turn_end`, `message_{start,end,update}`.

**Tool lifecycle:** `tool_execution_start`, `tool_execution_update`, `tool_execution_end`, `tool_call` (**can mutate args / block**), `tool_result` (**can mutate result**).

**Other:** `user_bash`, `input`, `context`, `before_provider_request`, `after_provider_response`, `model_select`, `thinking_level_select`, `resources_discover`.

**Direct registration APIs:** `pi.registerTool`, `pi.registerCommand`, `pi.registerShortcut`, `pi.registerFlag`, `pi.registerProvider`, `pi.registerMessageRenderer`, `pi.registerMainPane`, `pi.registerOverlay`, `pi.registerFooter`, `pi.registerAgentDefinitions`, `pi.registerAgentChain`.

**Context APIs:** `ctx.sendMessage`, `ctx.sendUserMessage`, `ctx.forkAgent`, `ctx.waitForIdle`, `ctx.newSession`, `ctx.switchSession`, `ctx.fork`, `ctx.navigateTree`, `ctx.ui.custom`.

## Real missing hooks (where extracting still requires new core)

| Capability | Why no current hook | Suggested hook |
|-----------|---------------------|----------------|
| Pluggable `BashOperations` (SSH/container/remote bash) | Hardcoded `createLocalBashOperations()` | `pi.registerBashOperations(provider)` |
| Output truncation/collapse before TUI render | `tool_result` fires after JSON serialize | `before_tool_render` event with mutation rights |
| Per-turn dynamic tool activation | `ctx.setActiveTools` is partial | Expand `turn_start` hook to allow tool list mutation |
| Custom session entry types | Fixed JSONL schema | `pi.registerSessionEntryType(deserializer, renderer)` |
| Provider payload mutation (not just request) | `before_provider_request` sees built payload only | `build_provider_payload` hook earlier in chain |
| Custom compaction strategies | LLM-prompted fixed flow | `pi.registerCompactionStrategy()` |

## my-pi extension inventory

`/Users/luke/Projects/personal/my-pi/packages/`:
- `pi-agent-ui`, `pi-agents`, `pi-observability` — non-extension packages
- `extensions/dream-memory` — uses event hooks for memory persistence
- `extensions/pi-routine` — goal workflow via `ctx.appendEntry` + memory

None require new hook surface — all use the documented API.

## Recommended extraction order (post-merge)

1. **Uppercase tool aliases** (edit/find/grep/ls/read/write) → move to `my-pi/extensions/uppercase-tools` using `pi.registerTool`. Removes 6 conflict files.
2. **bash.ts bg-job system** → move to `my-pi/extensions/bash-bg`. Register `bash_output`, `bash_kill` via `pi.registerTool`. Use `pi.on("tool_call", "bash")` to intercept `run_in_background:true` and spawn detached job. Persist registry to `~/.pi/agent/bash-bg/` from the extension. Removes the single largest conflict file.
3. **Add new core hooks** for the remaining gaps above only if/when concrete fork features need them.

After 1+2, the conflict surface drops from 37 files to ~5–10 (package.json/CHANGELOG only — pure metadata, easy resolves).
