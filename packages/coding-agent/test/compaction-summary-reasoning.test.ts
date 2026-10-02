import type { AgentMessage } from "@lue-labs/pi-agent-core";
import {
	type AssistantMessage,
	type Message,
	type Model,
	normalizeContext,
	type TranscriptContext,
} from "@lue-labs/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type CompactionPreparation,
	compact,
	completeSummarization,
	generateSummary,
	generateSummaryWithUsage,
} from "../src/core/compaction/index.ts";

const { completeSimpleMock } = vi.hoisted(() => ({
	completeSimpleMock: vi.fn(),
}));

vi.mock("@lue-labs/pi-ai/compat", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@lue-labs/pi-ai/compat")>();
	return {
		...actual,
		completeSimple: completeSimpleMock,
	};
});

function createModel(
	reasoning: boolean,
	maxTokens = 8192,
	compat?: Model<"anthropic-messages">["compat"],
): Model<"anthropic-messages"> {
	return {
		id: reasoning ? "reasoning-model" : "non-reasoning-model",
		name: reasoning ? "Reasoning Model" : "Non-reasoning Model",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://api.anthropic.com",
		reasoning,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens,
		...(compat ? { compat } : {}),
	};
}

const mockSummaryResponse: AssistantMessage = {
	role: "assistant",
	content: [{ type: "text", text: "## Goal\nTest summary" }],
	api: "anthropic-messages",
	provider: "anthropic",
	model: "claude-sonnet-4-5",
	usage: {
		input: 10,
		output: 10,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 20,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	stopReason: "stop",
	timestamp: Date.now(),
};

const mockToolCallResponse: AssistantMessage = {
	...mockSummaryResponse,
	content: [{ type: "toolCall", id: "tool-call-1", name: "read", arguments: { path: "README.md" } }],
	stopReason: "toolUse",
};

const messages: AgentMessage[] = [{ role: "user", content: "Summarize this.", timestamp: Date.now() }];

function getTextFromSummaryPromptCall(callIndex: number): string {
	const context = completeSimpleMock.mock.calls[callIndex][1] as { messages: Array<{ content: unknown }> };
	const lastMessage = context.messages.at(-1);
	if (!lastMessage) return "";
	const content = lastMessage.content;
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map((block) => (block && typeof block === "object" && "text" in block ? String(block.text) : ""))
			.join("\n");
	}
	return "";
}

function countOccurrences(text: string, needle: string): number {
	return text.split(needle).length - 1;
}

/** The live model-facing transcript a cache-safe summary request replays. */
const liveTranscript: Message[] = [
	{ role: "system", content: "Live system prompt", toolsAdded: [], timestamp: 0 },
	{ role: "user", content: [{ type: "text", text: "LIVE_USER_TURN" }], timestamp: 1 },
];

describe("generateSummary reasoning options", () => {
	beforeEach(() => {
		completeSimpleMock.mockReset();
		completeSimpleMock.mockResolvedValue(mockSummaryResponse);
	});

	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("uses the provided thinking level for reasoning-capable models", async () => {
		const result = await generateSummaryWithUsage(
			messages,
			createModel(true),
			2000,
			"test-key",
			undefined,
			undefined,
			undefined,
			undefined,
			"medium",
		);

		expect(result.text).toBe("## Goal\nTest summary");
		expect(result.usage).toEqual(mockSummaryResponse.usage);

		expect(completeSimpleMock).toHaveBeenCalledTimes(1);
		expect(completeSimpleMock.mock.calls[0][2]).toMatchObject({
			reasoning: "medium",
			apiKey: "test-key",
		});
	});

	it("preserves the string result from generateSummary", async () => {
		await expect(generateSummary(messages, createModel(false), 2000, "test-key")).resolves.toBe(
			"## Goal\nTest summary",
		);
	});

	it("uses fresh routing sessions without prompt caching", async () => {
		await generateSummary(messages, createModel(false), 2000, "test-key");
		await generateSummary(messages, createModel(false), 2000, "test-key");

		const requestOptions = completeSimpleMock.mock.calls.map((call) => call[2]);
		expect(requestOptions).toHaveLength(2);
		expect(requestOptions.every((options) => options?.cacheRetention === "none")).toBe(true);

		const sessionIds = requestOptions.map((options) => options?.sessionId);
		expect(sessionIds[0]).not.toBe(sessionIds[1]);
	});

	it("honors caller-supplied routing session, retention, and tool choice", async () => {
		// A caller that sets cacheRetention has built a request whose prefix matches a live,
		// already-cached conversation. Overriding it to "none" would force a cold write of that
		// whole prefix and, because anthropic-messages.ts drops cacheSessionId when retention is
		// "none", would silently throw away sticky routing as well.
		await completeSummarization(createModel(false), normalizeContext({ systemPrompt: "Summarize", messages: [] }), {
			sessionId: "current-routing-session",
			cacheRetention: "long",
			toolChoice: "auto",
		});

		expect(completeSimpleMock.mock.calls[0][2]).toMatchObject({
			sessionId: "current-routing-session",
			cacheRetention: "long",
			toolChoice: "auto",
		});
	});

	it("still defaults to no caching when the caller omits retention", async () => {
		// Branch summarization and other standalone callers pass no retention. They serialize the
		// conversation into a text blob that shares no prefix with a live session, so a cache write
		// here could never be read back. They must keep the "none" default.
		await completeSummarization(createModel(false), normalizeContext({ systemPrompt: "Summarize", messages: [] }), {
			toolChoice: "auto",
		});

		expect(completeSimpleMock.mock.calls[0][2]).toMatchObject({ cacheRetention: "none" });
		expect(completeSimpleMock.mock.calls[0][2]?.sessionId).toEqual(expect.any(String));
	});

	it("reads the live cached prefix when compaction is cache-safe", async () => {
		// The fork builds cacheSafeContext so the summary request replays the live transcript
		// verbatim. That prefix is already cached by the main loop, so the request must keep
		// caching on to READ it, with the retention the loop resolved (no explicit value, so the
		// provider default), and keep the loop's routing session. Forcing "none" cold-writes the
		// whole context instead: the measured symptom was a 266,090-token write while the loop
		// sat at 98% cached.
		vi.stubEnv("PI_CACHE_RETENTION", "");
		await generateSummaryWithUsage(
			messages,
			createModel(false),
			2000,
			"test-key",
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			"live-session-id",
			{ messages: liveTranscript },
		);

		expect(completeSimpleMock.mock.calls[0][2]).toMatchObject({
			cacheRetention: "short",
			sessionId: "live-session-id",
		});
		// The transcript is replayed as-is and only the summary instruction is appended: no
		// serialized <conversation> copy, no standalone summarization system prompt in front.
		const requestMessages = (completeSimpleMock.mock.calls[0][1] as { messages: Message[] }).messages;
		expect(requestMessages.slice(0, liveTranscript.length)).toEqual(liveTranscript);
		expect(requestMessages).toHaveLength(liveTranscript.length + 1);
		expect(requestMessages.at(-1)?.role).toBe("user");
		const prompt = getTextFromSummaryPromptCall(0);
		expect(prompt).toContain("The conversation above is the active session context.");
		expect(prompt).not.toContain("<conversation>");
		expect(prompt).not.toContain("LIVE_USER_TURN");
	});

	it("matches the main loop's long retention when PI_CACHE_RETENTION=long", async () => {
		// The loop sends no explicit retention and lets the provider resolve PI_CACHE_RETENTION.
		// A cache-safe summary must land on that same entry, so it resolves the variable the same
		// way instead of hardcoding a TTL.
		await generateSummaryWithUsage(
			messages,
			createModel(false),
			2000,
			"test-key",
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			{ PI_CACHE_RETENTION: "long" },
			undefined,
			undefined,
			"live-session-id",
			{ messages: liveTranscript },
		);

		expect(completeSimpleMock.mock.calls[0][2]).toMatchObject({ cacheRetention: "long" });
	});

	it("keeps caching off for standalone compaction without a cache-safe context", async () => {
		// Without cacheSafeContext the prompt is a <conversation> text blob that matches no live
		// prefix, so caching would buy a write nobody reads. This is vanilla pi's shape.
		await generateSummaryWithUsage(messages, createModel(false), 2000, "test-key");

		expect(completeSimpleMock.mock.calls[0][2]).toMatchObject({ cacheRetention: "none" });
		expect(getTextFromSummaryPromptCall(0)).toContain("<conversation>");
	});

	it("preserves the previous summary without an empty history request for a split turn", async () => {
		const preparation: CompactionPreparation = {
			firstKeptEntryId: "entry-keep",
			messagesToSummarize: [],
			turnPrefixMessages: messages,
			isSplitTurn: true,
			tokensBefore: 100,
			previousSummary: "previous checkpoint",
			fileOps: { read: new Set(), written: new Set(), edited: new Set() },
			settings: { enabled: true, reserveTokens: 2000, keepRecentTokens: 20 },
		};

		const result = await compact(preparation, createModel(false), "test-key");

		expect(completeSimpleMock).toHaveBeenCalledTimes(1);
		expect(result.summary).toContain("previous checkpoint");
		const requestContext = completeSimpleMock.mock.calls[0][1] as TranscriptContext;
		const prompt = JSON.stringify(requestContext.messages);
		// Regression test for #9652: clear boundaries and continuation wording avoid the reasoning-extraction false positive.
		expect(prompt).toContain("# Conversation\\n[User]: Summarize this.");
		expect(prompt).toContain("# Instructions\\nThe messages above are earlier context from an ongoing conversation.");
	});

	it("rejects tool calls from conversation summaries", async () => {
		completeSimpleMock.mockResolvedValueOnce(mockToolCallResponse);

		await expect(generateSummaryWithUsage(messages, createModel(false), 2000, "test-key")).rejects.toThrow(
			"Summarization attempted to call a tool",
		);
	});

	it("rejects tool calls from split-turn summaries", async () => {
		completeSimpleMock.mockResolvedValueOnce(mockToolCallResponse);
		const preparation: CompactionPreparation = {
			firstKeptEntryId: "entry-keep",
			messagesToSummarize: [],
			turnPrefixMessages: messages,
			isSplitTurn: true,
			tokensBefore: 100,
			fileOps: { read: new Set(), written: new Set(), edited: new Set() },
			settings: { enabled: true, reserveTokens: 2000, keepRecentTokens: 20 },
		};

		await expect(compact(preparation, createModel(false), "test-key")).rejects.toThrow(
			"Turn prefix summarization attempted to call a tool",
		);
	});

	it("disables parent xhigh reasoning for compaction summaries", async () => {
		const preparation: CompactionPreparation = {
			firstKeptEntryId: "entry-keep",
			messagesToSummarize: messages,
			turnPrefixMessages: [],
			isSplitTurn: false,
			tokensBefore: 190000,
			fileOps: { read: new Set(), written: new Set(), edited: new Set() },
			settings: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 },
		};

		await compact(preparation, createModel(true), "test-key", undefined, undefined, undefined, "xhigh");

		expect(completeSimpleMock).toHaveBeenCalledTimes(1);
		expect(completeSimpleMock.mock.calls[0][2]).not.toHaveProperty("reasoning");
	});

	it("keeps split-turn compaction requests reasoning-free too", async () => {
		const preparation: CompactionPreparation = {
			firstKeptEntryId: "entry-keep",
			messagesToSummarize: messages,
			turnPrefixMessages: [{ ...mockSummaryResponse, content: [{ type: "text", text: "early turn work" }] }],
			isSplitTurn: true,
			tokensBefore: 190000,
			fileOps: { read: new Set(), written: new Set(), edited: new Set() },
			settings: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 },
		};

		await compact(preparation, createModel(true), "test-key", undefined, undefined, undefined, "xhigh");

		expect(completeSimpleMock).toHaveBeenCalledTimes(2);
		for (const call of completeSimpleMock.mock.calls) {
			expect(call[2]).not.toHaveProperty("reasoning");
		}
	});

	it("rejects a length-limited history summary", async () => {
		completeSimpleMock.mockResolvedValueOnce({
			...mockSummaryResponse,
			stopReason: "length",
			content: [{ type: "text", text: "partial" }],
		});

		await expect(generateSummaryWithUsage(messages, createModel(false), 2000, "test-key")).rejects.toThrow(
			"generation hit the token cap",
		);
	});

	it("rejects a length-limited split-turn summary", async () => {
		completeSimpleMock.mockResolvedValueOnce({
			...mockSummaryResponse,
			stopReason: "length",
			content: [{ type: "text", text: "partial" }],
		});
		const preparation: CompactionPreparation = {
			firstKeptEntryId: "entry-keep",
			messagesToSummarize: [],
			turnPrefixMessages: messages,
			isSplitTurn: true,
			tokensBefore: 100,
			fileOps: { read: new Set(), written: new Set(), edited: new Set() },
			settings: { enabled: true, reserveTokens: 2000, keepRecentTokens: 20 },
		};

		await expect(compact(preparation, createModel(false), "test-key")).rejects.toThrow(
			"generation hit the token cap",
		);
	});

	it("does not set reasoning when thinking is off", async () => {
		await generateSummary(
			messages,
			createModel(true),
			2000,
			"test-key",
			undefined,
			undefined,
			undefined,
			undefined,
			"off",
		);

		expect(completeSimpleMock).toHaveBeenCalledTimes(1);
		expect(completeSimpleMock.mock.calls[0][2]).toMatchObject({
			apiKey: "test-key",
		});
		expect(completeSimpleMock.mock.calls[0][2]).not.toHaveProperty("reasoning");
	});

	it("does not set reasoning for non-reasoning models", async () => {
		await generateSummary(
			messages,
			createModel(false),
			2000,
			"test-key",
			undefined,
			undefined,
			undefined,
			undefined,
			"medium",
		);

		expect(completeSimpleMock).toHaveBeenCalledTimes(1);
		expect(completeSimpleMock.mock.calls[0][2]).toMatchObject({
			apiKey: "test-key",
		});
		expect(completeSimpleMock.mock.calls[0][2]).not.toHaveProperty("reasoning");
	});

	it("leaves Anthropic refusal fallback handling to pi-ai model metadata", async () => {
		await generateSummary(
			messages,
			createModel(true, 8192, {
				allowedFallbackModels: [
					{
						provider: "anthropic",
						model: "claude-opus-4-8",
						cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
					},
				],
			}),
			2000,
			"test-key",
		);

		expect(completeSimpleMock).toHaveBeenCalledTimes(1);
		expect(completeSimpleMock.mock.calls[0][2]).not.toHaveProperty("refusalFallbacks");
	});

	it("does not set Anthropic refusal fallback for models without allowed fallback targets", async () => {
		await generateSummary(messages, createModel(true), 2000, "test-key");

		expect(completeSimpleMock).toHaveBeenCalledTimes(1);
		expect(completeSimpleMock.mock.calls[0][2]).not.toHaveProperty("refusalFallbacks");
	});

	it("clamps compaction summary maxTokens to the model output cap", async () => {
		const preparation: CompactionPreparation = {
			firstKeptEntryId: "entry-keep",
			messagesToSummarize: messages,
			turnPrefixMessages: messages,
			isSplitTurn: true,
			tokensBefore: 600000,
			fileOps: { read: new Set(), written: new Set(), edited: new Set() },
			settings: { enabled: true, reserveTokens: 500000, keepRecentTokens: 20000 },
		};

		const result = await compact(preparation, createModel(false, 128000), "test-key");

		expect(result.usage).toEqual({
			...mockSummaryResponse.usage,
			input: 20,
			output: 20,
			totalTokens: 40,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		});
		expect(completeSimpleMock.mock.calls.map((call) => call[2]?.maxTokens)).toEqual([128000, 128000]);
	});

	it("uses split-turn format for cache-safe turn-prefix summaries", async () => {
		const preparation: CompactionPreparation = {
			firstKeptEntryId: "entry-keep",
			messagesToSummarize: messages,
			turnPrefixMessages: [
				{ ...mockSummaryResponse, content: [{ type: "text", text: "UNIQUE_PREFIX_BODY_MARKER early turn work" }] },
			],
			isSplitTurn: true,
			tokensBefore: 100000,
			fileOps: { read: new Set(), written: new Set(), edited: new Set() },
			settings: { enabled: true, reserveTokens: 20000, keepRecentTokens: 20000 },
		};

		await compact(
			preparation,
			createModel(false),
			"test-key",
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			"live-session-id",
			{ messages: liveTranscript },
		);

		expect(completeSimpleMock).toHaveBeenCalledTimes(2);
		const turnPrefixPrompt = getTextFromSummaryPromptCall(1);
		// The cache-safe path must NOT re-serialize the turn prefix into the prompt: those
		// messages are already in cacheSafeContext.messages, and duplicating them is billed as a
		// never-read cache write on every compaction. It points at the boundary instead.
		expect(turnPrefixPrompt).not.toContain("# Conversation");
		expect(turnPrefixPrompt).toContain("<boundary>");
		expect(turnPrefixPrompt).toContain("UNIQUE_PREFIX_BODY_MARKER");
		expect(turnPrefixPrompt).toContain("## Original Request");
		expect(turnPrefixPrompt).toContain("## Early Progress");
		expect(turnPrefixPrompt).toContain("## Context for Suffix");
		expect(turnPrefixPrompt).not.toContain("## Goal");
		expect(turnPrefixPrompt).not.toContain("## Constraints & Preferences");
		expect(turnPrefixPrompt).not.toContain("## Progress");
		expect(turnPrefixPrompt).not.toContain("## Next Steps");
		// Both requests replay the same live prefix and keep the live routing session.
		for (const call of completeSimpleMock.mock.calls) {
			const requestMessages = (call[1] as { messages: Message[] }).messages;
			expect(requestMessages.slice(0, liveTranscript.length)).toEqual(liveTranscript);
			expect(call[2]).toMatchObject({ sessionId: "live-session-id" });
			expect(call[2]?.cacheRetention).not.toBe("none");
		}
	});

	it("keeps split-turn cache-safe compaction output from duplicating checkpoint headings", async () => {
		completeSimpleMock
			.mockResolvedValueOnce({
				...mockSummaryResponse,
				content: [{ type: "text", text: "## Goal\nShip compaction fix\n\n## Progress\n### Done\n- [x] Found bug" }],
			})
			.mockResolvedValueOnce({
				...mockSummaryResponse,
				content: [
					{
						type: "text",
						text: "## Original Request\nFix duplicate compaction output\n\n## Early Progress\n- Identified prompt contract\n\n## Context for Suffix\n- Suffix keeps verification work",
					},
				],
			});
		const preparation: CompactionPreparation = {
			firstKeptEntryId: "entry-keep",
			messagesToSummarize: messages,
			turnPrefixMessages: [{ ...mockSummaryResponse, content: [{ type: "text", text: "early turn work" }] }],
			isSplitTurn: true,
			tokensBefore: 100000,
			fileOps: { read: new Set(), written: new Set(), edited: new Set() },
			settings: { enabled: true, reserveTokens: 20000, keepRecentTokens: 20000 },
		};

		const result = await compact(
			preparation,
			createModel(false),
			"test-key",
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			"live-session-id",
			{ messages: liveTranscript },
		);

		expect(countOccurrences(result.summary, "## Goal")).toBe(1);
		expect(result.summary).toContain("**Turn Context (split turn):**");
		expect(countOccurrences(result.summary, "## Original Request")).toBe(1);
		expect(result.summary).toContain("## Early Progress");
		expect(result.summary).toContain("## Context for Suffix");
	});
});
