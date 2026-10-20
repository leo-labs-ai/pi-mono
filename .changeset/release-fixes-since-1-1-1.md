---
"@leo-labs-ai/pi-coding-agent": patch
"@leo-labs-ai/pi-ai": patch
"@leo-labs-ai/pi-tui": patch
---

Release the fixes merged since 1.1.1:

- coding-agent: keep the transcript tool loadout on resume (#619)
- coding-agent: score terms most MCP tools share only from the tool name (#635)
- ai: send x-session-affinity from openai-responses (#620)
- ai: make source model builds deterministic (#621)
- ai: keep the prompt cache across tool_search loads after a tool removal (#616)
- tui: preserve scrollback during small off-screen shrinks (#625)
- deps: bump shell-quote and undici (#638)
