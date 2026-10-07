import { describe, expect, it } from "vitest";
import { adjustMaxTokensForThinking, clampMaxTokensToContext, MIN_ANSWER_TOKENS } from "../src/api/simple-options.ts";
import type { Model, TranscriptContext } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

function createModel(contextWindow: number, maxTokens: number): Model<"anthropic-messages"> {
	return {
		id: "claude-fable-5-1-200k",
		name: "Claude Fable 5.1 200k",
		api: "anthropic-messages",
		provider: "clawrouter",
		baseUrl: "http://127.0.0.1:8798",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow,
		maxTokens,
	};
}

function contextOfChars(chars: number): TranscriptContext {
	return normalizeContext({ messages: [{ role: "user", content: "x".repeat(chars), timestamp: Date.now() }] });
}

describe("clampMaxTokensToContext", () => {
	it("clamps the output cap to the room left under the context window", () => {
		// 8000 chars ~ 2000 tokens; 10000 - 2000 - 4096 safety = 3904 (existing behavior).
		expect(clampMaxTokensToContext(createModel(10000, 8000), contextOfChars(8000), 8000)).toBe(3904);
	});

	it("never emits a degenerate one-token cap when the estimate leaves no answer room", () => {
		// Seen 2026-09-30 (clawrouter/claude-fable-5-1-200k at ~196k of 200k): every request,
		// including the compaction summary, went out with max_tokens=1 and came back as a
		// 1-token "length" stop, so overflow recovery could never succeed.
		const model = createModel(200000, 128000);
		const nearlyFull = contextOfChars(4 * (200000 - 4096 - 100));
		const clamped = clampMaxTokensToContext(model, nearlyFull, 8000);
		expect(clamped).toBeGreaterThanOrEqual(MIN_ANSWER_TOKENS);
	});

	it("bounds the full model cap to the remaining window instead of passing it through", () => {
		// 3000 tokens of room: sending 128000 would overflow input + max_tokens every time.
		const model = createModel(200000, 128000);
		const tight = contextOfChars(4 * (200000 - 3000));
		expect(clampMaxTokensToContext(model, tight, 128000)).toBe(3000 - 256);
	});

	it("bounds explicit caller caps such as branch summaries (4096)", () => {
		const model = createModel(200000, 128000);
		const tight = contextOfChars(4 * (200000 - 3000));
		expect(clampMaxTokensToContext(model, tight, 4096)).toBe(3000 - 256);
	});

	it("bounds a thinking-budget add-back (output cap + budget) to the same room", () => {
		const model = createModel(200000, 128000);
		const tight = contextOfChars(4 * (200000 - 3000));
		const adjusted = adjustMaxTokensForThinking(2744, model.maxTokens, "medium");
		expect(adjusted.maxTokens).toBeGreaterThan(8000);
		expect(clampMaxTokensToContext(model, tight, adjusted.maxTokens)).toBe(3000 - 256);
	});

	it("falls back to the minimum answer size when the window has no room left", () => {
		const model = createModel(200000, 128000);
		const overWindow = contextOfChars(4 * 250000);
		expect(clampMaxTokensToContext(model, overWindow, 128000)).toBe(MIN_ANSWER_TOKENS);
		expect(clampMaxTokensToContext(model, overWindow, 500)).toBe(500);
	});
});
