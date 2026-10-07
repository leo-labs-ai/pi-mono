---
"@lue-labs/pi-ai": patch
---

Stop the high/xhigh truncation + failed compact-and-retry loop near a full context window.

- `clampMaxTokensToContext` no longer floors the output cap at 1 token. When the context estimate leaves less than `MIN_ANSWER_TOKENS` of room, the cap is bounded to the remaining window (never below `MIN_ANSWER_TOKENS`), covering explicit caller caps and the thinking-budget add-back. Previously every request past `contextWindow - 4096`, including the compaction summary used to recover, went out with `max_tokens: 1` and came back as a 1-token `length` stop (202 consecutive turns observed on `clawrouter/claude-fable-5-1-200k`); passing the full model cap through instead would overflow the window on Anthropic.
- `isContextOverflow` recognizes Anthropic's "input length and `max_tokens` exceed context limit" error, so a window overflow routes to compaction like "prompt is too long".
