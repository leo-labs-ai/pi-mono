# Idle compaction and declaration checkpoints

This is a fork-only runtime contract for `pi-mono-fork`. It does not add these APIs to the separately installed vanilla `pi`. The change does not enable an idle timer, activate an extension, or change installed launchers.

## Admission and cancellation

Both `AgentSession` and extension `ExtensionContext` expose:

```ts
compactIfIdle(options: CompactIfIdleOptions): Promise<CompactionResult | undefined>

interface CompactIfIdleOptions {
  minTokens: number;
  signal: AbortSignal;
  customInstructions?: string;
}
```

`minTokens` must be finite and non-negative; invalid values reject with `RangeError`. Admission requires a known, finite current `getContextUsage().tokens` value **strictly greater than** `minTokens`. Equality, missing usage, and unknown usage do not qualify. A prior token reading is not a substitute for current usage.

The runtime checks admission and reserves compaction before yielding. It returns `undefined` without starting compaction when the signal is already aborted or the session has competing work. This includes active runs, streaming, compaction or branch summarization, retries, queued messages, input preflight, settlement handlers or deferred actions, and running or pending bash work. It neither aborts competing work nor waits for it to finish.

After admission, the promise resolves with `CompactionResult` on success. Cancellation and execution failures reject; `undefined` means rejected admission, not cancelled execution. Aborting the supplied signal cancels this compaction only. Cancellation is checked after asynchronous hooks and before checkpoint persistence; it does not undo a checkpoint already written.

## Extension-owned timing, native execution

The extension owns the idle duration, timer, rearming policy, and cancellation controller. It must invalidate its timer and cancel its admitted attempt when activity or session lifecycle changes make that attempt obsolete. Core supplies the atomic admission check, not a scheduling policy. A separate `isIdle()` check followed by unconditional `compact()` is not an equivalent reservation.

An admitted attempt uses the native manual compaction path:

1. Core emits `compaction_start` with `reason: "manual"` and prepares the compaction boundary.
2. `session_before_compact` receives the preparation, branch entries, custom instructions, cancellation signal, `reason: "manual"`, and `willRetry: false`.
3. A hook can return `{ cancel: true }` or provide a `compaction` result. Otherwise core runs its existing default summary generator, shared with automatic compaction.
4. Core persists the checkpoint, rebuilds the projected context, emits `session_compact`, and finishes with `compaction_end`.

Use this supported hook/summary flow rather than replacing session internals, constructing a second conversation-summary pipeline, or synthesizing a user prompt to request compaction. Admission does not guarantee a usable compaction boundary or a successful summary; callers must handle rejection.

## Checkpoint format and replay

`CompactionEntry` gains an optional field:

```ts
systemMessageHistory?: SystemMessage[];
```

New checkpoints capture ordered system declarations from the active session projection: the original declaration head followed by subsequent patches. They do not copy user messages, assistant messages, or tool results into this field. Reading the active projection, rather than scanning the raw branch, avoids duplicating declarations already represented by earlier checkpoints.

The existing `systemMessage` remains a consolidated snapshot of the effective prompt and tools for legacy readers. Current readers replay `systemMessageHistory` before the compaction summary when the field is present. If it is absent, they fall back to `[systemMessage]`, or no declaration when neither field exists. An explicit empty history is authoritative, not a request for the legacy fallback.

Preserving declaration history avoids flattening the original declaration head into a new consolidated prefix. It **does not preserve removed conversation in model context**: the checkpoint summary and retained tail still replace the compacted portion. It also **does not guarantee cache hits**. Provider serialization, supported declaration patches, cache lifetime, routing, and the changed conversation determine actual reuse.
