# 2. Slim the upstream-owned package changelogs to fork-owned stubs

Date: 2026-06-09

Status: Accepted

Supersedes part of the changelog-ownership model recorded in `FORK-CHANGELOG.md`
("Changelog ownership split"). Builds on [ADR 0001](./0001-bounded-github-release-body.md).

## Context

ADR 0001 fixed the release `422` ("body is too long") at the release step and
**deferred** slimming the package changelogs themselves. Those files remained a
problem:

- Each `packages/*/CHANGELOG.md` carried `earendil-works/pi-mono`'s full
  Keep-a-Changelog history and grew without bound because `.gitattributes`
  `*CHANGELOG.md merge=union` made every upstream sync *append* rather than
  replace. `coding-agent`'s reached **407KB**.
- The files are stale upstream baggage — the fork's real release notes live in
  `FORK-CHANGELOG.md`, and Changesets is `changelog: false` (it never writes
  them).

## Decision

Take the deferred ownership change:

- `git mv` each `packages/*/CHANGELOG.md` → `CHANGELOG.upstream.md` — a frozen
  reference preserving the full upstream history.
- Reset `CHANGELOG.md` to a small fork-owned stub pointing at `FORK-CHANGELOG.md`
  and the archive.
- `.gitattributes`: `packages/*/CHANGELOG.md merge=ours` so upstream syncs keep
  the fork's stub and never re-append their changelog; `*CHANGELOG.upstream.md`
  stays `merge=union`.

Changesets stays `changelog: false`; `FORK-CHANGELOG.md` remains the canonical
fork release log.

## Consequences

- Live package changelogs drop ~400KB → a few hundred bytes and stop growing.
- Upstream syncs no longer hard-conflict or re-bloat these files (`merge=ours`).
- Full upstream history is still available in `CHANGELOG.upstream.md`.
- Independent of the release pipeline: ADR 0001's bounded-body script already
  sources Release notes from `FORK-CHANGELOG.md`, so publishing is unaffected.
- If a package ever needs upstreamable per-version notes again, restore from the
  archive or re-enable a Changesets changelog generator deliberately.
