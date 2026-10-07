---
"@lue-labs/pi-coding-agent": minor
---

Add `createAgentSession({ omitCwdSection: true })`, which leaves the `<cwd>` section out of the system prompt so sessions in different directories share one prompt-cache entry.
