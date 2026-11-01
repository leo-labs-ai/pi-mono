# OpenClaw + pi-harness debugging notes

Hard-won lessons from running `pi-mono-fork` as the agent runtime behind OpenClaw
via the `pi-harness` plugin (`OpenClaw/extensions/pi-harness/`). Read this before
debugging "Cora won't respond" or "pi is hitting the wrong provider" inside any
OpenClaw deployment that uses pi-fork.

Companion files:
- `OpenClaw/extensions/pi-harness/managed-runtime.ts` — writes
  `pi-harness-agent/settings.json` and `models.json` per pi spawn.
- `OpenClaw/extensions/pi-harness/session-binding.ts` — argv builder for the
  spawned `pi --mode rpc` process.
- `bermont-kube/k3s/apps/core-wholesale/base/openclaw-configmap.yaml` —
  production model/provider routing for Cora.

---

## The model-namespace ambiguity trap

**Symptom.** OpenClaw gateway returns `insufficient_quota` for both primary and
fallback, with messages like `You're out of extra usage. Add more at
claude.ai/settings/usage`. This sounds like a Claude Max plan cap but is
actually the `console.anthropic.com` API-key billing wall. Claude bridge OAuth
is healthy; direct bridge `/v1/messages` calls succeed.

**Cause.** The OpenClaw configmap used a `pi-fork/*` model prefix to mark the
pi-harness runtime:

```jsonc
{
  "primary": "pi-fork/claude-sonnet-4-6",
  "models": {
    "pi-fork/claude-sonnet-4-6": { "agentRuntime": { "id": "pi-fork" } }
  }
}
```

`session-binding.ts` intentionally strips its own `pi-fork` provider when
spawning pi:

```ts
if (opts.modelId && opts.provider && opts.provider !== "pi-fork") {
  modelArgs.push("--provider", opts.provider, "--model", opts.modelId);
} else if (opts.modelId) {
  modelArgs.push("--model", opts.modelId);   // pi-fork branch → loses provider
}
```

Pi then resolves bare `--model claude-sonnet-4-6`. The registry has **two**
candidates:

- built-in `anthropic/claude-sonnet-4-6` — `baseUrl` hardcoded to
  `https://api.anthropic.com` in `packages/ai/src/providers/anthropic.ts`
  (the SDK's `ANTHROPIC_BASE_URL` env is overridden per-model)
- custom `claude-bridge/claude-sonnet-4-6` — `baseUrl: http://127.0.0.1:9100`
  from `pi-harness-agent/models.json`

Ambiguous bare-id match → pi defaults to the built-in `anthropic` provider →
hits `api.anthropic.com` directly using `ANTHROPIC_API_KEY` → console billing
wall, even though the OAuth bridge is fine.

`enabledModels: ["claude-bridge/*"]` in settings does **not** save you here —
it scopes the UI picker, not the CLI `--model` flag's resolver path.

**Fix.** Register the `pi-fork` agentRuntime against the real provider
namespace, not an invented prefix:

```jsonc
{
  "primary": "claude-bridge/claude-sonnet-4-6",
  "fallbacks": ["claude-bridge/claude-opus-4-7"],
  "models": {
    "claude-bridge/claude-sonnet-4-6": { "agentRuntime": { "id": "pi-fork" } },
    "claude-bridge/claude-opus-4-7":   { "agentRuntime": { "id": "pi-fork" } },
    "claude-bridge/claude-haiku-4-5":  { "agentRuntime": { "id": "pi-fork" } }
  }
}
```

Now session-binding's first branch fires: `pi --provider claude-bridge --model
claude-sonnet-4-6`. Unambiguous resolution; traffic routes through the bridge
as intended.

**Rule of thumb.** When wiring a custom `agentRuntime` into OpenClaw, register
it against the underlying provider's namespace (`claude-bridge/`,
`openai-codex/`, `anthropic/`, ...). Never invent a runtime-named prefix
(`pi-fork/`, `acpx/`, ...) — it produces ambiguous bare-id resolution inside pi.

Reference fix: bermont-kube PR
[#60](https://github.com/bermont-digital/bermont-kube/pull/60).

---

## Diagnostic: bridge `/status` counter is ground truth

When the gateway returns a Claude-shaped error, you can't tell from the error
alone whether pi went through the bridge or not. Both paths hit
`api.anthropic.com` upstream and return Anthropic-formatted `req_…` IDs.

The Claude bridge exposes a request counter that is the only ground truth:

```bash
POD=$(kubectl -n core-wholesale get pods -l app.kubernetes.io/name=openclaw \
  -o jsonpath='{.items[0].metadata.name}')

kubectl -n core-wholesale exec $POD -c openclaw -- sh -c '
  echo "BEFORE:"; curl -sS http://127.0.0.1:9100/status
  curl -sS -X POST http://127.0.0.1:18789/v1/chat/completions \
    -H "Authorization: Bearer $OPENCLAW_GATEWAY_TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"model\":\"openclaw\",\"messages\":[{\"role\":\"user\",\"content\":\"ping\"}],\"max_tokens\":10}"
  echo; echo "AFTER:"; curl -sS http://127.0.0.1:9100/status
'
```

| Counter delta | Meaning |
|---|---|
| `+1` and chat succeeds | bridge OK, pi routed correctly. |
| `+1` and chat fails with `upstreamErrors`/`bridgeErrors` ticking too | bridge reached but upstream / OAuth issue — read `/status.lastUpstreamError` and `kubectl logs -c claude-bridge`. |
| **`+0` and chat fails** | **pi bypassed the bridge.** Almost always the model-namespace ambiguity above. Verify with `ps -ef \| grep "pi --mode"` — if the spawn line lacks `--provider claude-bridge`, that's it. |
| `+0` and chat succeeds | pi served from cache or never made an upstream call. Rare; ignore unless reproducible. |

**Caveats.** The trick only diagnoses "made an HTTP call to api.anthropic.com
through which path". It tells you nothing about errors that happen before pi
issues a request (model registry empty, settings.json malformed, RPC handshake
failed). For those, check `kubectl logs -c openclaw --tail 200 | grep -iE
"pi-harness|spawn|settings"`.

---

## Quick triage: "Cora isn't replying" / "OpenClaw chat broken"

Run top-to-bottom. Stop at the first answer.

1. **Pod up?**
   `kubectl -n core-wholesale get pods -l app.kubernetes.io/name=openclaw`
   Both containers (`openclaw`, `claude-bridge`) should be `Running 2/2`.

2. **Gateway alive?**
   ```
   kubectl -n core-wholesale exec deploy/openclaw -c openclaw -- \
     curl -sS http://127.0.0.1:18789/health
   ```

3. **Bridge alive?**
   ```
   kubectl -n core-wholesale exec deploy/openclaw -c openclaw -- \
     curl -sS http://127.0.0.1:9100/health
   curl -sS http://127.0.0.1:9100/status     # auth: static, requests: N
   ```

4. **Bridge OAuth working?** Hit it directly:
   ```
   curl -sS -X POST http://127.0.0.1:9100/v1/messages \
     -H "anthropic-version: 2023-06-01" \
     -H "x-api-key: sk-ant-oat-bridge-local" \
     -H "Content-Type: application/json" \
     -d '{"model":"claude-sonnet-4-6","max_tokens":20,"messages":[{"role":"user","content":"ok"}]}'
   ```
   Replies with content → OAuth bucket fine. 4xx with billing wording → real
   Claude Max cap, refill or wait for reset.

5. **Gateway round-trip with bridge counter delta.** Use the snippet in the
   "Diagnostic" section above. `+0` with failure → step 6.

6. **Confirm pi spawn argv** is fully qualified:
   ```
   kubectl -n core-wholesale exec deploy/openclaw -c openclaw -- \
     ps -ef | grep "pi --mode" | grep -v grep
   ```
   Expected: `pi --provider claude-bridge --model claude-sonnet-4-6 --mode rpc`.
   If `--provider` is missing → model-namespace ambiguity. Fix in the
   openclaw configmap per the section above.

7. **Verify pi-harness settings/models** on the PVC:
   ```
   kubectl -n core-wholesale exec deploy/openclaw -c openclaw -- sh -c '
     cat /home/node/.openclaw/state/pi-harness-agent/settings.json;
     echo ---;
     cat /home/node/.openclaw/state/pi-harness-agent/models.json'
   ```
   `defaultProvider` should be `claude-bridge`, `enabledModels` should include
   `claude-bridge/*`, and `models.json` should list every model id the
   configmap routes to pi-harness — opus-4-7, sonnet-4-6, haiku-4-5 minimum.
   Missing models is the #2 cause after the namespace bug.

8. **Look at openclaw failover decisions:**
   ```
   kubectl -n core-wholesale logs deploy/openclaw -c openclaw --since=10m \
     | grep -iE "failover|billing|insufficient_quota|FailoverError"
   ```

---

## Other recurring gotchas

- `install-pi-harness-plugin.sh` **short-circuits** when the staged version
  equals the version already on the PVC. Any edit to
  `OpenClaw/extensions/pi-harness/*.ts` requires a `package.json` version bump
  to actually deploy. See bermont-kube history (Cora rollout PR #28).

- The pi-harness `DEFAULT_PI_HARNESS_MODELS` constant in `managed-runtime.ts`
  only ships `claude-opus-4-7`. Inside containers without
  `~/.pi/agent/models.json`, that single-model default is all pi sees — every
  other Claude variant will silently fall back to the built-in `anthropic`
  provider and trip the namespace ambiguity. Mirror Luke's local file (4
  claude-bridge models) when expanding.

- `kubectl apply -f` on a Flux-managed ConfigMap is rejected silently (SSA
  field-manager conflict). Use
  `kubectl apply --server-side --force-conflicts` to take the field over for
  the unblock window, then PR the same change to the Flux source so the next
  reconcile re-affirms it.

- The Claude bridge log line `Context-1M models: claude-opus-4-7` is
  cosmetic — the bridge happily proxies any model id; that line just tags
  which ones get a 1M-context preset.

---

## Quick links

- Plugin source: `OpenClaw/extensions/pi-harness/`
- Model resolver: `pi-mono-fork/packages/coding-agent/src/core/model-resolver.ts`
- Built-in anthropic provider (hardcoded baseUrl):
  `pi-mono-fork/packages/ai/src/providers/anthropic.ts`
- Production routing source of truth:
  `infra/bermont-kube/k3s/apps/core-wholesale/base/openclaw-configmap.yaml`
- Cora WhatsApp ops notes: `work/core-wholesale/AGENTS.md` (search "Cora").
