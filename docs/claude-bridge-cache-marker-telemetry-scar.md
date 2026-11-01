# Scar: claude-bridge cache marker and telemetry failure

Date: 2026-05-27

## What broke

Pi sessions routed through `claude-bridge` caused high `cache_creation_input_tokens` during long Opus conversations. The bridge only marked the latest message for prompt caching, so the assistant response inserted before the next user turn was not cached. The next request reused the stable system/tools cache anchor but rewrote most of the transcript body.

## Pi-side responsibility

Pi must send caller metadata on every `claude-bridge` request:

- `x-pi-session-id`
- `x-pi-session-title`
- `x-pi-cwd`
- `x-pi-pid`
- `x-pi-source`
- `x-pi-child-agent`
- `x-pi-parent-session`

This lets the bridge expose `/top-callers` and prevents quota forensics from becoming guesswork.

## Rules

- Long Opus sessions without caller telemetry are an incident; add telemetry before continuing analysis.
- Bridge log analysis scopes to the latest bridge start unless explicitly doing history.
- `read=21149` is a shared system/tools anchor, not a session id.
- Cache health is caller-scoped: inspect cache read/write/input by session, not global totals only.

Canonical scar: `~/Projects/agent-scripts/SCARS/issue-09-claude-bridge-cache-marker-telemetry.md`.
