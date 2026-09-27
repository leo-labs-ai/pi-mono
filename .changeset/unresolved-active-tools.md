---
"@lue-labs/pi-coding-agent": patch
---

Warn at startup when a requested active tool is not registered. The default request includes Read, Edit, Write, and Grep, while core registers read, edit, write, and grep. The warning says names are case-sensitive and to request those lowercase names or register uppercase aliases through an extension. The active tool set is unchanged. Later tool-selection changes are not announced.
