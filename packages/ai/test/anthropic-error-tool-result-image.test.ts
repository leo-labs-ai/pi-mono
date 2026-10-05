import { describe, expect, it } from "vitest";
import { getModel, streamSimple } from "../src/compat.ts";
import type { AssistantMessage, Context } from "../src/types.ts";

interface ToolResultBlock {
	type: string;
	is_error?: boolean;
	content?: string | Array<{ type: string; text?: string }>;
}

class PayloadCaptured extends Error {}

function context(isError: boolean): Context {
	const assistant: AssistantMessage = {
		role: "assistant",
		content: [{ type: "toolCall", id: "toolu_1", name: "codemode", arguments: {} }],
		provider: "anthropic",
		api: "anthropic-messages",
		model: "claude-sonnet-4-6",
		timestamp: Date.now(),
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
	};
	return {
		messages: [
			{ role: "user", content: "go", timestamp: Date.now() },
			assistant,
			{
				role: "toolResult",
				toolCallId: "toolu_1",
				toolName: "codemode",
				content: [
					{ type: "text", text: "script failed" },
					{ type: "image", data: "AAAA", mimeType: "image/jpeg" },
				],
				isError,
				timestamp: Date.now(),
			},
		],
	};
}

async function toolResult(isError: boolean): Promise<ToolResultBlock> {
	let payload: { messages: Array<{ content: ToolResultBlock[] | string }> } | undefined;
	const s = streamSimple(getModel("anthropic", "claude-sonnet-4-6"), context(isError), {
		apiKey: "fake-key",
		onPayload: (p) => {
			payload = p as typeof payload;
			throw new PayloadCaptured("captured");
		},
	});
	await s.result();
	const content = payload?.messages.at(-1)?.content;
	if (!Array.isArray(content)) throw new Error("expected tool_result content");
	return content.find((b) => b.type === "tool_result") as ToolResultBlock;
}

describe("Anthropic errored tool_result with image", () => {
	it("sends only text blocks when is_error is true", async () => {
		const block = await toolResult(true);
		expect(block.is_error).toBe(true);
		const content = block.content;
		const text = typeof content === "string" ? content : (content ?? []).map((c) => c.text ?? "").join("\n");
		if (Array.isArray(content)) expect(content.every((c) => c.type === "text")).toBe(true);
		expect(text).toContain("script failed");
		expect(text).toContain("1 image omitted");
	});

	it("keeps images for successful tool results", async () => {
		const block = await toolResult(false);
		expect(Array.isArray(block.content) && block.content.some((c) => c.type === "image")).toBe(true);
	});
});
