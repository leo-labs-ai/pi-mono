---
"@lue-labs/pi-ai": patch
---

`isContextOverflow` recognizes Anthropic's "input length and `max_tokens` exceed context limit" error, so a window overflow routes to compaction like "prompt is too long".
