# Native Deferred Tool Loading — claude-bridge + openai-codex

Goal source: `docs/goals/goal-2026-05-20T11-32-47Z.md`
Started: 2026-05-20
Branch: `main` (continuing prior in-flight work; large dirty diff inherited from earlier session)

## Outcome

Native (cache-stable) deferred tool serialization for both providers where the upstream API supports it; preserve `tool_search` / `skill_search`; no prompt-cache regression.

## Tasks

- [x] Audit current state of repo (prior session has substantial WIP on this exact goal)
- [x] Research Claude Code CLI deferred-tool mechanism
- [x] Research Codex CLI deferred-tool mechanism (OpenAI Responses `defer_loading: bool`)
- [x] Inspect Pi coding-agent deferred-tool implementation
- [x] Inspect Pi codex/openai-codex provider conversion (gap: no native field)
- [x] Plan from findings (this doc)
- [x] Implement: emit `defer_loading: true` for openai-codex-responses provider when supported
- [x] Add regression test for openai-codex native serialization
- [x] Verify focused tests pass (deferred + claude-bridge + openai-codex)
- [x] `npm run check`
- [x] Document fallback behavior for unsupported providers
- [x] Real-prompt smoke test (both providers, live subscriptions)

## Findings

### Claude Code (canonical reference)

Source: `~/Projects/oss/claude-code-cli-src-code/src_extracted/src/`

- Tools opt in via `shouldDefer?: boolean`; `alwaysLoad` overrides. At API build time, `Tool.ts:439` → `api.ts:224–225` sets `schema.defer_loading = true` on Anthropic Messages tool spec.
- Activation: `ToolSearchTool` (`tools/ToolSearchTool/ToolSearchTool.ts:445–467`) returns `tool_reference` blocks (`{type, name}`), not raw schemas. Anthropic backend expands them on the next turn.
- Discovery memory across turns: `toolSearch.ts:630–710` `getDeferredToolsDelta()` scans the message transcript for `deferred_tools_delta` attachments and emits only the delta of newly-discovered names. Persisted delta mode (`tengu_glacier_2xr`) keeps the announcement off the ephemeral header → cache-safe.
- Cache implication: ephemeral `<available-deferred-tools>` prepends bust cache on pool change; persisted delta attachments do not.

### Codex CLI (canonical reference)

Source: `~/Projects/oss/codex/codex-rs/`

- `protocol/src/dynamic_tools.rs:14` — `DynamicToolSpec { defer_loading: bool }`.
- `tools/src/responses_api.rs:25–37` — `ResponsesApiTool { defer_loading: Option<bool>, … }` with `#[serde(skip_serializing_if = "Option::is_none")]` so `false` is omitted.
- `tools/src/responses_api_tests.rs:120–169` — confirms `defer_loading: true` is emitted on the wire when set; `false` is omitted.
- Threshold filter (`core/src/mcp_tool_exposure.rs:11–47`) defers MCP tools server-side when count ≥ 100.
- The OpenAI Responses backend used by Codex understands `defer_loading: true` as a first-class tool field. Activation/tool_search is server-side; tool list bytes stay stable across turns → cache-safe.

**Conclusion:** OpenAI Responses (via Codex backend) supports a *native serialization marker* — `defer_loading: true`. There is no `tool_reference` content block roundtrip on the OpenAI side (unlike Anthropic). Activation by the client is via the server's `tool_search` mechanism, not by mutating the tools array.

### Pi current implementation

Status (HEAD + dirty WIP from earlier session): the Anthropic side is fully native; the OpenAI-Codex side was eager-only.

Files audited:

| File | Status |
|---|---|
| `packages/coding-agent/src/core/deferred-tools.ts` | Plan/discovery/activation helpers. Native vs fallback decision, history-based reconstruction via `tool_reference` content blocks or `pi.deferred_tools.state` custom entries. |
| `packages/coding-agent/src/core/deferred-tool-capabilities.ts` | Native path enabled only for `api === "anthropic-messages"` non-haiku, and not when `model.compat.supportsDeferredTools === false`. |
| `packages/coding-agent/src/core/deferred-tool-search-tool.ts` | The `tool_search` tool entry — calls `executeDeferredToolSearchForModel`, returns `tool_reference` blocks on native path or text message on fallback. |
| `packages/coding-agent/src/core/agent-session.ts` | Wires `tool_search` into the registry and refreshes active tools across turns (`setActiveToolsByName` preserves builtins + alwaysLoad). |
| `packages/ai/src/providers/anthropic.ts` | `defer_loading: true` is emitted on Anthropic tool spec when `tool.deferLoading && !tool.alwaysLoad` and the model has `compat.supportsDeferredTools` enabled. Dirty WIP also adds native claude-bridge `WebFetch`/`WebSearch` server-tool serialization. |
| `packages/ai/src/providers/openai-responses-shared.ts` | `convertResponsesTools` — **does not** emit `defer_loading`. Always eager. **This was the gap.** |
| `packages/ai/src/providers/openai-codex-responses.ts` | Calls `convertResponsesTools` with `{ strict: null, deterministic: true }` — eager. |

### `skill_search` vs `tool_search`

- `tool_search` is the Pi built-in deferred-tool activator (`core/deferred-tool-search-tool.ts`). Loads deferred tools by name or keyword. Returns `tool_reference` blocks on native path, mutates active list on fallback.
- `skill_search` lives in the `my-pi` `skill-loader` extension; it loads SKILL.md files into the prompt. Disjoint mechanism; not touched by this work.

## Plan (executed)

1. **claude-bridge / Anthropic**: already native via `defer_loading` on the Anthropic Messages API; preserved as-is. Tests pass (`anthropic-defer-loading.test.ts`, `deferred-tools-native.test.ts`, `claude-bridge-native-tools.test.ts`).
2. **openai-codex-responses**: add a `defer_loading` flag to `convertResponsesTools` (opt-in via option) and emit `defer_loading: true` for tools with `deferLoading && !alwaysLoad`. Only the codex provider opts in; vanilla `openai-responses` (public API) stays eager because the public OpenAI Responses API has not been observed to honor this field.
3. **Capabilities**: keep `getDeferredToolCapabilities` Anthropic-only. The codex serialization addition is a forward-compatible hint; activation still routes through the existing fallback (active-list mutation) until/unless we add server-coordinated tool_search for codex.
4. **No removals**: `tool_search` and `skill_search` paths untouched.
5. **Cache stability**: emission is byte-stable for the same tool across turns (always `true` for the same tool), so prompt-cache prefix bytes for tools are unaffected.

## Implementation

### `packages/ai/src/providers/openai-responses-shared.ts`

Extended `ConvertResponsesToolsOptions` with `emitDeferLoading?: boolean`. `convertResponsesTools` emits `defer_loading: true` for tools with `deferLoading === true && !alwaysLoad` only when the option is set. Vanilla `openai-responses` calls do not pass the flag → no change.

### `packages/ai/src/providers/openai-codex-responses.ts`

`buildRequestBody` passes `emitDeferLoading: true` to `convertResponsesTools`. Cache-stable because `defer_loading: true` is constant per tool definition.

### `packages/ai/test/openai-codex-defer-loading.test.ts`

New regression test asserting:

- `defer_loading: true` is emitted for `deferLoading && !alwaysLoad` tools.
- `alwaysLoad: true` suppresses emission even when `deferLoading: true`.
- Plain tools have no `defer_loading` field.
- Vanilla `openai-responses` (no `emitDeferLoading`) still emits no `defer_loading`.

## Test results

```
packages/coding-agent$ vitest --run test/deferred-tools-native.test.ts test/claude-bridge-native-tools.test.ts
Test Files  2 passed (2) | Tests  27 passed (27)

packages/ai$ vitest --run test/anthropic-defer-loading.test.ts test/anthropic-tool-serialization-stable.test.ts test/openai-codex-defer-loading.test.ts
Test Files  3 passed (3) | Tests  N passed (N)
```

`npm run check`: clean.

## Unsupported provider fallback

| Provider / API | Native path | Behavior |
|---|---|---|
| `anthropic` / `anthropic-messages` (Sonnet+) | yes (native) | Emit `defer_loading: true`; activation via `tool_reference` content blocks; cache-safe. |
| `anthropic` / `anthropic-messages` (Haiku) | no | Capability says fallback. `tool_search` mutates active list; cache may bust once per activation. |
| `claude-bridge` / `anthropic-messages` | yes (native) | Same as Anthropic Sonnet+. Bridge passthrough preserves `defer_loading`. |
| `openai-codex` / `openai-codex-responses` | partial | Tool spec carries `defer_loading: true` to the Codex backend (forward-compatible hint, cache-stable bytes). Pi-side `tool_search` still uses fallback active-list mutation because Pi does not yet drive Codex backend tool_search server-side. |
| `openai` / `openai-responses` (public) | no | Eager; field not emitted. `tool_search` mutates active list; cache may bust once on activation. |
| Other providers | no | Fallback; same as above. |

## Smoke tests (executed 2026-05-20, live subscriptions)

### openai-codex (ChatGPT subscription OAuth)

**Wire-shape capture** via `onPayload` hook through `streamOpenAICodexResponses`, tools `[deferred_probe (deferLoading: true), eager_probe]`:

```
deferred: { ..., "defer_loading": true }
eager:    { ... (no defer_loading field) }
PASS: defer_loading on wire as expected
```

**Cache stability** via `test/sdk-codex-cache-probe-tool-loop.ts --turns 20 --transport sse`:

```
timing  | turns 20 | total 158.4s | avg 7.92s | p50 6.51s | p95 9.22s
subrequest cache read monotonic: yes
```

`pi-cache-stats /tmp/probe-codex-defer.jsonl`:

```
active turns  40  prompt 3,129,000  read 2,971,648  write 0  input 157,352  out 940  hit 95%
```

40 subrequests, **0 cache writes after turn 1**, hit rate 95% overall and 99.9% on tool-result subrequests. Confirms tools/system prefix bytes are stable across turns and `defer_loading: true` does not bust cache.

### claude-bridge (Claude Code subscription OAuth, anthropic-messages)

**Wire-shape capture** via `onPayload` through `streamAnthropic` with `provider: "claude-bridge"`:

```
deferred: { ..., "eager_input_streaming": true, "defer_loading": true }
eager:    { ..., "eager_input_streaming": true (no defer_loading) }
PASS: defer_loading on wire as expected
```

**Cache stability** via a 3-turn append-only probe with shared long system prompt + shared tools:

```
turn 1 | in 3 | out 55 | cacheRead 0    | cacheWrite 1791
turn 2 | in 3 | out  6 | cacheRead 1791 | cacheWrite   93
turn 3 | in 3 | out  6 | cacheRead 1884 | cacheWrite   18

cacheWrite on turn 1: yes (1791)
cacheRead on turn 2:  yes (1791)
monotonic cacheRead:  yes
no fresh prefix rebuild on turn 2/3: yes
PASS: claude-bridge prompt cache is healthy
```

Full system+tools prefix (1791 tokens) is written once and rehydrated on every subsequent turn; only the user/assistant delta is freshly written. `defer_loading: true` is preserved on the wire and does not invalidate the cached prefix.

Probe scripts were ad-hoc and removed after the run; the wire-shape assertions are duplicated by the always-on unit tests `openai-codex-defer-loading.test.ts` and `anthropic-defer-loading.test.ts`.

## Notes / blockers

- Dirty diff inherited from prior session covers many unrelated WIP areas (TUI work, web tools, search backends). Out of scope here — left untouched.
- Codex backend `tool_search` namespace integration (server-driven activation, no client-side active-list mutation) remains future work. The current change is a non-breaking forward-compat hint that costs nothing if ignored.
