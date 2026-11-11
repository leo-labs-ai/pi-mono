# Fork upstream sync 2026-11-10 — 1.5.0 → 1.5.1

Worktree: `lue-t-pi-151-update-1110`. Method: a Git-native, non-rewriting merge of upstream tag `v1.5.1`.

## B / L / U

| Input | SHA | Meaning |
|---|---|---|
| B | `f9a26365568127461c47a07a37dcb42c140a3ac5` | Last integrated upstream, tag `v1.5.0` |
| L | `94b0b09fe58d9ef2f8ca2be1523b0a5ac499d5df` | Fork head when this lane started |
| U | `dd30101cfc5b0609411dd80b6f93adbc14db14cf` | Selected upstream tag `v1.5.1` |

The preceding integration merge is `7c3c839590af357d790f56727bda4d6092044fc7`. The selected base is in the fork's ancestry. This merge initially reported 90 conflicted paths. There are no remaining unmerged index entries after resolution.

## Classification

| Class | Resolution |
|---|---|
| adopt | Upstream 1.5.1 source, tests and dependency changes, including `lovely-mermaid` 0.3.3 and the Chord v2 root migration |
| adapt: package identity | Retain `@leo-labs-ai/pi-{ai,agent-core,tui,telemetry,durable,env,coding-agent,evals}` names, imports, dependency keys and exact 1.5.1 pins. New p2 workspace imports and host package keys use these names too |
| preserve: upstream identities | Chord, codemode, mcp, schema, design-tokens and elanor packages retain their upstream scope. Extension-loader aliases still resolve both public host scopes to the same runtime |
| adapt: version tooling | `sync-versions.js` traverses upstream's apps as well as packages, but versions and repins only fork-owned packages. Its existing deterministic fixture now tests fork-owned identity |
| adapt: catalog | Start from upstream's pin, then refresh it with the official pin updater because the upstream pin lacks Fable 5.2 entries required by 1.5.1 tests. Verify its SHA256, then apply the fork's Kimi K3 `cacheWrite: 3` override to moonshotai, moonshotai-cn and kimi-coding entries |
| preserve: automation | Keep fork `ci.yml`, `test:build-gate`, fork release machinery and private-registry scopes. Keep upstream's release-age exclusion in `.npmrc` |
| reject: publishing | Do not add upstream `preview-packages.yml` or `p2-cloud-bundle.yml`; these depend on upstream publishing infrastructure |
| adapt: locks | Refresh root metadata using `npm install --package-lock-only --ignore-scripts --no-audit --no-fund`, then regenerate coding-agent install locks with the repository generator |
| preserve: changelogs | Existing `merge=ours` package-changelog policy remains. Record the sync in `FORK-CHANGELOG.md`, not in released upstream package sections |

## Behavioural conflict decisions

1. **Chord v2 replaces v1.** Follow upstream's promotion of `src/next` to the package root and deletion of old v1 tests and issue-triage files. The former fork-only manager-test timeout is obsolete. The preceding conflict log explicitly said to follow that upcoming deletion. This is an upstream replacement, not an attempt to fix a failing test by removing it.
2. **Cache warming follows upstream's refactor.** The old fork cache-warmer delta was package identity only. Adopt the upstream implementation in `packages/ai/src/cache-warming.ts`; this file has no fork diff against the selected tag.
3. **Compaction keeps fork semantics.** Keep cache-safe transcript replay, grounding prompts, model-hidden custom messages, the session thinking level, and the no-summary-specific-output-cap rule while adopting upstream compaction changes. The prior inventory contains historical claims that are no longer current; the immediately preceding fork tree is the preservation baseline.
4. **Coding-agent conflict resolution combines both sides.** Keep `formatNameList`, `formatCaseSensitiveToolGuidance` and `formatUnresolvedActiveToolsDiagnostic`, while adopting upstream `getNextCycleIndex`, path canonicalization, markdown transformers and mermaid changes. Preserve existing gateway flags, provider-qualified model resolution, tool-search rules, deferred-tool handling and loader host aliases. These are preservation decisions, not new features.
5. **P2 host imports use fork identities.** Internal dependency names, TypeScript paths, plugin-host package keys and layout tests agree. No second upstream identity was added to the p2 host. Public extension-loader aliases are a separate, retained contract.
6. **Audit missing local-delta paths.** The B-to-L path list has ten paths absent from the result. Two workflows were already absent at L. Five Chord v2 files moved from `next` to their root counterparts; their B-to-L changes were scope-only and remain in the new paths. Two issue-triage files had scope-only changes and follow upstream deletion. The last path is the obsolete manager test described above. This path audit found no additional lost fork feature.

## Catalog provenance

Initial upstream pin SHA256: `175c0d73533fad08fdd1554932a4993c37564d2a2ea084cbcc2126772fbf906f`. That catalog predates Fable 5.2, although 1.5.1's provider definitions and tests include it. `node scripts/update-model-catalog-pin.mjs` refreshed the immutable pin to `sha256-d1cdce8a84fa8b63211a8cda9b2a176fca8155ba2182795284ab31b6631c0914`. Its downloaded bytes matched that digest. The checked-in snapshot contains the refreshed catalog plus four Kimi cache-write overrides; the upstream digest describes the downloaded input, not the modified snapshot. Generated provider data remains ignored and is never staged.

## Verification history before final gates

- The deterministic `sync-versions` fixture passed all three tests in an empty environment.
- Root lock metadata refresh and coding-agent install-lock generation completed.
- `git diff --check` reports whitespace in four upstream documentation files. Each staged blob is byte-identical to `v1.5.1`; leave that unrelated upstream formatting unchanged. Details are recorded in the lane evidence `whitespace.log`.
- Remote `npm ci --ignore-scripts` and `npm run build:offline` passed in run `run_b961abe3780515389aa5d2a3142897c9`. `npm run check` then exposed the stale catalog's missing Fable 5.2 types.
- Repaired run `run_5d9d52c71927fbf9a3407d59f407867b` passed installation, offline build, root Biome and p2's full canonical check. Manifest fallback omitted Git metadata, so the root aggregate stopped at its changelog check. That check passed in the real local worktree; all remaining root components, including both TypeScript checks and browser bundling, passed remotely. This split verification is not an aggregate-command pass.
- The repaired build-gate found ten missing-fd failures and two timing failures. An attempted prerequisite repair could not use sudo on the donor's nosuid mount. Bash implementation and its new timeout test are unchanged from upstream. A properly provisioned, worker-bounded run is required; no assertions or time limits were weakened.
- P2 plugin-layout exposed a missing `react-dom` entry in its test's web host list and a scope-sensitive tsconfig comparison. The host already provides `react-dom`; the test now includes it. The mapping assertion compares fork-owned packages under their fork identities while leaving upstream-owned packages unchanged. Root's dual-scope aliases and p2's canonical fork mappings remain untouched. The real plugin build must verify this fix.
- The next remote payload includes genuine shallow Git metadata and an exact staged-tree hash check. A user-space fd binary avoids sudo, and Vitest's supported worker cap avoids oversubscribing a four-CPU donor.
- First Crabbox run `run_0a6d73fb51c8f33bc010416651139df5` failed in sync finalization, before any gate ran (exit 6). Its lease was stopped. The diagnostic full-sync attempt `run_7e27293495e89e48e4ea502cad75a928` failed identically. Source inspection found a silent >=200-deletions guard; the merge removes 641 old paths without rename detection. A run with `CRABBOX_ALLOW_MASS_DELETIONS=1` acknowledged those expected upstream moves in the disposable workspace and passed sync. All three leases stopped.
- Luke approved the exact upstream instruction patch in async answer sequence 1: include the updates to `AGENTS.md` and new `.pi/skills/p2-ui.md`. The staged patch matches the proposed patch byte for byte; shared instructions remain untouched.

## Independent-review corrections

The p2 identity review found two missed source aliases and stale host-package examples. The p2 source resolver now reads both workspace scopes, and the root TypeScript config maps the fork's telemetry render subpath to source. Plugin documentation uses the fork's host identities while retaining upstream-owned codemode and schema names. A deterministic resolution test reproduced five fork imports falling through to `dist/`; all nine fork, upstream and p2 alias cases pass after the correction. This adds no second host-package identity.

Live installation and final gate results belong in the lane report at `harbor/state/pi-151-update-1110/report.md`; this file does not claim a push, merge, promotion or successful gates.
