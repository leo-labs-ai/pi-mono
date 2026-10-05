import { describe, expect, it } from "vitest";
import { stream as streamCodex } from "../src/api/openai-codex-responses.ts";
import { stream as streamResponses } from "../src/api/openai-responses.ts";
import type { AssistantMessage, Context, Model } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

type Effort = "low" | "medium" | "high" | "xhigh";
type ResponsesApi = "openai-responses" | "openai-codex-responses";

interface CapturedPayload {
	input: Array<{ type?: string; role?: string; reasoning?: { effort?: string } }>;
	reasoning?: { effort?: string };
}

function gpt6(
	api: ResponsesApi,
	id = "gpt-6-luna-200k",
	compat?: { supportsMidConvoEffort?: boolean },
): Model<ResponsesApi> {
	return {
		id,
		name: id,
		api,
		provider: "clawrouter",
		baseUrl: "http://127.0.0.1:9/v1",
		reasoning: true,
		thinkingLevelMap: { minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "xhigh" },
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 32000,
		compat: { sendChatgptAccountId: false, supportsWebSocketTransport: false, ...compat },
	};
}

/** Sends one request, captures its payload, and returns the assistant message to append to the transcript. */
async function turn(
	model: Model<ResponsesApi>,
	context: Context,
	effort: Effort,
): Promise<{ payload: CapturedPayload; reply: AssistantMessage }> {
	let payload: CapturedPayload | undefined;
	const options = {
		apiKey: "test-key",
		cacheRetention: "none" as const,
		reasoningEffort: effort,
		onPayload: (value: unknown) => {
			payload = structuredClone(value) as CapturedPayload;
			throw new Error("payload captured");
		},
	};
	const result =
		model.api === "openai-codex-responses"
			? streamCodex(model as Model<"openai-codex-responses">, normalizeContext(context), options)
			: streamResponses(model as Model<"openai-responses">, normalizeContext(context), options);
	const message = await result.result();
	if (!payload) throw new Error(message.errorMessage ?? "payload not captured");
	const reply: AssistantMessage = {
		...message,
		content: [{ type: "text", text: `answer ${context.messages.length}` }],
		stopReason: "stop",
		errorMessage: undefined,
	};
	return { payload, reply };
}

/** Runs one user prompt per effort level, appending each reply, and returns every payload. */
async function conversation(model: Model<ResponsesApi>, efforts: Effort[]) {
	const context: Context = { systemPrompt: "You are terse.", messages: [] };
	const payloads: CapturedPayload[] = [];
	const replies: AssistantMessage[] = [];
	for (const [index, effort] of efforts.entries()) {
		context.messages.push({ role: "user", content: `prompt ${index}`, timestamp: index });
		const { payload, reply } = await turn(model, context, effort);
		payloads.push(payload);
		replies.push(reply);
		context.messages.push(reply);
	}
	return { payloads, replies };
}

const updates = (payload: CapturedPayload) =>
	payload.input.filter((item) => item.type === "configuration_update").map((item) => item.reasoning?.effort);

describe.each<ResponsesApi>(["openai-responses", "openai-codex-responses"])("%s mid-conversation effort", (api) => {
	it("keeps request-level effort and the input prefix when the level changes", async () => {
		const { payloads, replies } = await conversation(gpt6(api), ["xhigh", "xhigh", "high", "high", "xhigh"]);

		expect(payloads.map((payload) => payload.reasoning?.effort)).toEqual([
			"xhigh",
			"xhigh",
			"xhigh",
			"xhigh",
			"xhigh",
		]);
		expect(replies.map((reply) => reply.providerThinkingLevel)).toEqual(["xhigh", "xhigh", "high", "high", "xhigh"]);
		expect(payloads.map(updates)).toEqual([[], [], ["high"], ["high"], ["high", "xhigh"]]);
		// Each request replays the previous one byte-for-byte, so the cached prefix survives.
		for (let index = 1; index < payloads.length; index++) {
			const previous = payloads[index - 1].input;
			expect(payloads[index].input.slice(0, previous.length)).toEqual(previous);
		}
		// The update sits after the prompt it applies to, never next to another update.
		const last = payloads[2].input.at(-1);
		expect(last?.type).toBe("configuration_update");
		expect(payloads[2].input.at(-2)?.role).toBe("user");
	});

	it("leaves non-GPT-6, Pro, and opted-out models on request-level effort", async () => {
		for (const model of [
			gpt6(api, "gpt-5.5"),
			gpt6(api, "gpt-6-astra-pro"),
			gpt6(api, "gpt-6-luna", { supportsMidConvoEffort: false }),
		]) {
			const { payloads, replies } = await conversation(model, ["xhigh", "high"]);
			expect(payloads.map((payload) => payload.reasoning?.effort)).toEqual(["xhigh", "high"]);
			expect(payloads.flatMap(updates)).toEqual([]);
			expect(replies.map((reply) => reply.providerThinkingLevel)).toEqual([undefined, undefined]);
		}
	});
});
