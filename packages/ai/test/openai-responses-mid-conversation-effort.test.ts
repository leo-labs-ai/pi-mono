import { afterEach, describe, expect, it, vi } from "vitest";
import { closeOpenAICodexWebSocketSessions, stream as streamCodex } from "../src/api/openai-codex-responses.ts";
import { stream as streamResponses } from "../src/api/openai-responses.ts";
import type { AssistantMessage, Context, Model } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

type Effort = "low" | "medium" | "high" | "xhigh";
type ResponsesApi = "openai-responses" | "openai-codex-responses";

interface CapturedPayload {
	input: Array<{ type?: string; role?: string; reasoning?: { effort?: string } }>;
	reasoning?: { effort?: string };
}

afterEach(() => {
	vi.unstubAllGlobals();
	closeOpenAICodexWebSocketSessions();
});

function gpt6(
	api: ResponsesApi,
	compat: { supportsMidConvoEffort?: boolean; supportsWebSocketTransport?: boolean } = {
		supportsMidConvoEffort: true,
	},
	id = "gpt-6-luna-200k",
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
async function conversation(model: Model<ResponsesApi>, efforts: Effort[], context = newContext()) {
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

function newContext(): Context {
	return { systemPrompt: "You are terse.", messages: [] };
}

const serialize = (value: unknown) => JSON.stringify(value);

/** Each request must replay the previous one byte-for-byte so the cached prefix survives. */
function expectStablePrefixes(payloads: CapturedPayload[]): void {
	for (let index = 1; index < payloads.length; index++) {
		const previous = payloads[index - 1].input;
		expect(serialize(payloads[index].input.slice(0, previous.length))).toBe(serialize(previous));
	}
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
		expectStablePrefixes(payloads);
		// The update sits after the prompt it applies to, never next to another update.
		const last = payloads[2].input.at(-1);
		expect(last?.type).toBe("configuration_update");
		expect(payloads[2].input.at(-2)?.role).toBe("user");
	});

	it("leaves models without the opt-in on request-level effort", async () => {
		for (const model of [gpt6(api, {}), gpt6(api, { supportsMidConvoEffort: false })]) {
			const { payloads, replies } = await conversation(model, ["xhigh", "high"]);
			expect(payloads.map((payload) => payload.reasoning?.effort)).toEqual(["xhigh", "high"]);
			expect(payloads.flatMap(updates)).toEqual([]);
			expect(replies.map((reply) => reply.providerThinkingLevel)).toEqual([undefined, undefined]);
		}
	});

	it("takes the baseline from a replayed response, not an aborted one", async () => {
		const model = gpt6(api);
		const context = newContext();
		context.messages.push({ role: "user", content: "prompt 0", timestamp: 0 });
		const { reply } = await turn(model, context, "xhigh");
		context.messages.push({ ...reply, stopReason: "aborted" });

		const { payload, reply: retry } = await turn(model, context, "high");

		expect(payload.reasoning?.effort).toBe("high");
		expect(updates(payload)).toEqual([]);
		expect(retry.providerThinkingLevel).toBe("high");
	});

	it("keeps an update in place when its response converts to no input items", async () => {
		const model = gpt6(api);
		const context = newContext();
		const payloads: CapturedPayload[] = [];
		for (const [index, effort] of (["xhigh", "high", "high"] as const).entries()) {
			context.messages.push({ role: "user", content: `prompt ${index}`, timestamp: index });
			const { payload, reply } = await turn(model, context, effort);
			payloads.push(payload);
			// The high response carried only an unsigned thinking block, which replays as nothing.
			context.messages.push(index === 1 ? { ...reply, content: [{ type: "thinking", thinking: "..." }] } : reply);
		}

		expect(payloads.map(updates)).toEqual([[], ["high"], ["high"]]);
		expectStablePrefixes(payloads);
		const roles = payloads[2].input.map((item) => item.type ?? item.role);
		expect(roles.slice(-3)).toEqual(["user", "configuration_update", "user"]);
	});
});

describe("openai-codex-responses WebSocket continuation", () => {
	it("sends only [user, configuration_update] after an effort change", async () => {
		const sent: Array<CapturedPayload & { previous_response_id?: string }> = [];
		let responseId = 0;

		class MockWebSocket {
			static OPEN = 1;
			readyState = MockWebSocket.OPEN;
			private listeners = new Map<string, Set<(event: unknown) => void>>();

			constructor() {
				queueMicrotask(() => this.dispatch("open", {}));
			}

			addEventListener(type: string, listener: (event: unknown) => void): void {
				const listeners = this.listeners.get(type) ?? new Set();
				listeners.add(listener);
				this.listeners.set(type, listeners);
			}

			removeEventListener(type: string, listener: (event: unknown) => void): void {
				this.listeners.get(type)?.delete(listener);
			}

			send(data: string): void {
				sent.push(JSON.parse(data));
				const id = ++responseId;
				const item = {
					type: "message",
					id: `msg_${id}`,
					role: "assistant",
					status: "completed",
					content: [{ type: "output_text", text: `answer ${id}`, annotations: [] }],
				};
				queueMicrotask(() => {
					for (const event of [
						{ type: "response.output_item.added", item: { ...item, status: "in_progress", content: [] } },
						{ type: "response.content_part.added", part: { type: "output_text", text: "" } },
						{ type: "response.output_text.delta", delta: `answer ${id}` },
						{ type: "response.output_item.done", item },
						{
							type: "response.completed",
							response: {
								id: `resp_${id}`,
								status: "completed",
								usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
							},
						},
					]) {
						this.dispatch("message", { data: JSON.stringify(event) });
					}
				});
			}

			close(): void {
				this.readyState = 3;
			}

			private dispatch(type: string, event: unknown): void {
				for (const listener of this.listeners.get(type) ?? []) listener(event);
			}
		}

		vi.stubGlobal("WebSocket", MockWebSocket);
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("unexpected fetch", { status: 500 })),
		);

		const model = gpt6("openai-codex-responses", { supportsMidConvoEffort: true, supportsWebSocketTransport: true });
		const context = newContext();
		for (const [index, effort] of (["xhigh", "high"] as const).entries()) {
			context.messages.push({ role: "user", content: `prompt ${index}`, timestamp: index });
			const reply = await streamCodex(model as Model<"openai-codex-responses">, normalizeContext(context), {
				apiKey: "test-key",
				sessionId: "effort-ws",
				transport: "websocket-cached",
				reasoningEffort: effort,
			}).result();
			expect(reply.stopReason).toBe("stop");
			context.messages.push(reply);
		}

		expect(sent.map((body) => body.reasoning?.effort)).toEqual(["xhigh", "xhigh"]);
		expect(sent[1].previous_response_id).toBe("resp_1");
		expect(sent[1].input.map((item) => item.type ?? item.role)).toEqual(["user", "configuration_update"]);
		expect(updates(sent[1])).toEqual(["high"]);
	});
});
