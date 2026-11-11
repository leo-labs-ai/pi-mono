# Upstream 1.5.2 integration

## Inputs and method

- Base: upstream v1.5.1, `dd30101cfc5b0609411dd80b6f93adbc14db14cf`.
- Fork parent: `994fbd6f3c038adf1c322719b7ff84f62ab290e2`.
- Upstream parent: v1.5.2, `b4afdddf44e059c67ccf5097e5317d913521b470`.
- Preserve both parents with a merge, without rebasing the existing PR. Apply the virtual three-way merge tree, then resolve conflicts explicitly.

## Resolutions

- Keep fork-owned `@leo-labs-ai/pi-*` identities and bump their exact internal pins to 1.5.2. Keep chord, schema, codemode and MCP upstream-scoped. Regenerate the coding-agent install lock from the resolved manifests and root lock.
- Adopt upstream Chord host-data APIs. `src/node/app/app.ts` keeps only its fork telemetry import. Preserve the new `./compression` package export.
- Adopt the upstream p2 Settings and views plugins. Rewrite eight new host-package imports in three views modules, two test files and the waiting documentation to the existing fork identity. Do not introduce another host identity.
- Adopt immutable catalog revision `sha256-4cbd75daee429216860f6e5b7e13b4ddb12b495f6947061e5777edd27ce0b4f1`. Verify the downloaded revision digest before constructing the snapshot. Reapply `cacheWrite: 3` to the four Kimi chat models; retain the matching catalog source override.
- Retain the fork read-abort fix and its stream-local error ownership. The upstream delta does not modify that implementation.
- Leave `.pi/skills/p2-ui.md` unchanged. Its five upstream Settings guidance lines require separate owner approval.

## Verification

Fresh install, offline build, canonical checks and targeted tests must cover this resulting tree. Earlier 1.5.1 passes are not evidence for 1.5.2. Remote receipts and independent review are retained in Harbor task `t-pi-151-update-1110`; this log does not assert that those gates have passed.
