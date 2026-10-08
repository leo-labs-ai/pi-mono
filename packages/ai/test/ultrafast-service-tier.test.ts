import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdDecompressSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	closeOpenAICodexWebSocketSessions,
	resetOpenAICodexWebSocketDebugStats,
	stream as streamOpenAICodexResponses,
	streamSimple as streamSimpleOpenAICodexResponses,
} from "../src/api/openai-codex-responses.ts";
import {
	stream as streamOpenAIResponses,
	streamSimple as streamSimpleOpenAIResponses,
} from "../src/api/openai-responses.ts";
import { getUltrafastCostRates, supportsUltrafast } from "../src/models.ts";
import type { Model } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;

afterEach(() => {
	vi.unstubAllGlobals();
	if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
	closeOpenAICodexWebSocketSessions();
	resetOpenAICodexWebSocketDebugStats();
	vi.restoreAllMocks();
});

const context = normalizeContext({
	systemPrompt: "sys",
	messages: [{ role: "user", content: "hi", timestamp: 1 }],
});

// Standard rates are deliberately different from Ultrafast so a wrong tier is visible.
const STANDARD_COST = { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 };

function responsesModel(id: string): Model<"openai-responses"> {
	return {
		id,
		name: id,
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://api.openai.com/v1",
		reasoning: true,
		input: ["text"],
		cost: STANDARD_COST,
		contextWindow: 400000,
		maxTokens: 128000,
	};
}

function codexModel(id: string): Model<"openai-codex-responses"> {
	return {
		...responsesModel(id),
		api: "openai-codex-responses",
		provider: "openai-codex",
		baseUrl: "https://chatgpt.com/backend-api",
	};
}

function completedEvent(serviceTier: string) {
	return {
		type: "response.completed",
		response: {
			status: "completed",
			service_tier: serviceTier,
			usage: {
				input_tokens: 1_000_000,
				output_tokens: 1_000_000,
				total_tokens: 2_000_000,
				input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
			},
		},
	};
}

function sse(events: unknown[]): string {
	return `${events.map((event) => `data: ${JSON.stringify(event)}`).join("\n\n")}\n\n`;
}

function mockToken(): string {
	const payload = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } }),
		"utf8",
	).toString("base64");
	return `aaa.${payload}.bbb`;
}

function decodeBody(body: RequestInit["body"] | undefined): Record<string, unknown> {
	if (typeof body === "string") return JSON.parse(body) as Record<string, unknown>;
	if (body instanceof Uint8Array) return JSON.parse(Buffer.from(zstdDecompressSync(body)).toString("utf8"));
	throw new Error("unexpected body");
}

describe("supportsUltrafast", () => {
	it.each([
		["gpt-6.1-sol", "openai-responses", true],
		["openai/gpt-6.1-sol", "openai-responses", true],
		["vendor/ns/gpt-6.1-sol-2026-10-08", "openai-codex-responses", true],
		["gpt-6-astra", "openai-responses", true],
		["gpt-6-astra-preview", "openai-codex-responses", true],
		["gpt-6-sol", "openai-responses", false],
		["gpt-5.5", "openai-responses", false],
		["gpt-6.1-sol", "openai-completions", false],
	] as const)("%s on %s -> %s", (id, api, expected) => {
		expect(supportsUltrafast({ id, api })).toBe(expected);
	});

	it("only prices gpt-6.1-sol", () => {
		expect(getUltrafastCostRates({ id: "x/gpt-6.1-sol", api: "openai-responses" })).toEqual({
			input: 12,
			output: 60,
		});
		expect(getUltrafastCostRates({ id: "gpt-6-astra", api: "openai-responses" })).toBeUndefined();
	});
});

describe("openai-responses ultrafast", () => {
	it("sends service_tier ultrafast and prices at $12/$60 despite a default echo", async () => {
		let payload: Record<string, unknown> | undefined;
		vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
			payload = decodeBody(init?.body);
			return new Response(sse([completedEvent("default")]), {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			});
		});

		const result = await streamOpenAIResponses(responsesModel("acme/gpt-6.1-sol"), context, {
			apiKey: "sk-test-key",
			serviceTier: "ultrafast",
		}).result();

		expect(payload?.service_tier).toBe("ultrafast");
		expect(result.usage.cost.input).toBeCloseTo(12, 12);
		expect(result.usage.cost.output).toBeCloseTo(60, 12);
		expect(result.usage.cost.total).toBeCloseTo(72, 12);
	});

	it("does not invent an astra price", async () => {
		vi.spyOn(globalThis, "fetch").mockImplementation(
			async () =>
				new Response(sse([completedEvent("ultrafast")]), {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				}),
		);

		const result = await streamOpenAIResponses(responsesModel("gpt-6-astra"), context, {
			apiKey: "sk-test-key",
			serviceTier: "ultrafast",
		}).result();

		expect(result.usage.cost.input).toBeCloseTo(2, 12);
		expect(result.usage.cost.output).toBeCloseTo(10, 12);
	});
});

describe("ultrafast cache cost estimates", () => {
	it("preserves standard cache costs without applying an invented long-context multiplier", async () => {
		const event = completedEvent("ultrafast");
		event.response.usage.input_tokens_details = { cached_tokens: 200_000, cache_write_tokens: 100_000 };
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(sse([event]), {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			}),
		);
		const model = responsesModel("clawrouter/gpt-6.1-sol-200k");
		model.cost = {
			...STANDARD_COST,
			tiers: [{ inputTokensAbove: 272_000, input: 4, output: 15, cacheRead: 0.2, cacheWrite: 5 }],
		};
		const result = await streamOpenAIResponses(model, context, {
			apiKey: "sk-test-key",
			serviceTier: "ultrafast",
		}).result();
		expect(result.stopReason).toBe("stop");
		expect(result.usage.cost.input).toBeCloseTo(8.4, 12);
		expect(result.usage.cost.output).toBe(60);
		expect(result.usage.cost.cacheRead).toBeCloseTo(0.04, 12);
		expect(result.usage.cost.cacheWrite).toBe(0.5);
		expect(result.usage.cost.total).toBeCloseTo(68.94, 12);
	});
});

describe("streamSimple serviceTier forwarding", () => {
	it("forwards serviceTier for openai-responses", async () => {
		let payload: Record<string, unknown> | undefined;
		vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
			payload = decodeBody(init?.body);
			return new Response(sse([completedEvent("default")]), {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			});
		});

		const result = await streamSimpleOpenAIResponses(responsesModel("gpt-6.1-sol"), context, {
			apiKey: "sk-test-key",
			serviceTier: "ultrafast",
		}).result();

		expect(payload?.service_tier).toBe("ultrafast");
		expect(result.usage.cost.total).toBeCloseTo(72, 12);
	});

	it("omits service_tier when not requested", async () => {
		let payload: Record<string, unknown> | undefined;
		vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
			payload = decodeBody(init?.body);
			return new Response(sse([completedEvent("default")]), {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			});
		});

		await streamSimpleOpenAIResponses(responsesModel("gpt-6.1-sol"), context, { apiKey: "sk-test-key" }).result();

		expect(payload && "service_tier" in payload && payload.service_tier !== undefined).toBe(false);
	});

	it("forwards serviceTier for openai-codex-responses", async () => {
		process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "pi-ultrafast-"));
		let body: Record<string, unknown> | undefined;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL, init?: RequestInit) => {
				const url = typeof input === "string" ? input : input.toString();
				if (url === "https://api.github.com/repos/openai/codex/releases/latest") {
					return new Response(JSON.stringify({ tag_name: "rust-v0.0.0" }), { status: 200 });
				}
				if (url.startsWith("https://raw.githubusercontent.com/openai/codex/")) {
					return new Response("PROMPT", { status: 200, headers: { etag: '"etag"' } });
				}
				if (url === "https://chatgpt.com/backend-api/codex/responses") {
					body = decodeBody(init?.body);
					return new Response(sse([completedEvent("default")]), {
						status: 200,
						headers: { "content-type": "text/event-stream" },
					});
				}
				return new Response("not found", { status: 404 });
			}),
		);

		const result = await streamSimpleOpenAICodexResponses(codexModel("openai/gpt-6.1-sol"), context, {
			apiKey: mockToken(),
			serviceTier: "ultrafast",
			transport: "sse",
		}).result();

		expect(body?.service_tier).toBe("ultrafast");
		expect(result.usage.cost.total).toBeCloseTo(72, 12);
	});
});

describe("openai-codex-responses ultrafast", () => {
	it("sends service_tier ultrafast over SSE and prices at $12/$60 when Codex echoes default", async () => {
		process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "pi-ultrafast-"));
		let body: Record<string, unknown> | undefined;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL, init?: RequestInit) => {
				const url = typeof input === "string" ? input : input.toString();
				if (url === "https://api.github.com/repos/openai/codex/releases/latest") {
					return new Response(JSON.stringify({ tag_name: "rust-v0.0.0" }), { status: 200 });
				}
				if (url.startsWith("https://raw.githubusercontent.com/openai/codex/")) {
					return new Response("PROMPT", { status: 200, headers: { etag: '"etag"' } });
				}
				if (url === "https://chatgpt.com/backend-api/codex/responses") {
					body = decodeBody(init?.body);
					return new Response(sse([completedEvent("default")]), {
						status: 200,
						headers: { "content-type": "text/event-stream" },
					});
				}
				return new Response("not found", { status: 404 });
			}),
		);

		const result = await streamOpenAICodexResponses(codexModel("gpt-6.1-sol"), context, {
			apiKey: mockToken(),
			serviceTier: "ultrafast",
			transport: "sse",
		}).result();

		expect(body?.service_tier).toBe("ultrafast");
		expect(result.usage.cost.input).toBeCloseTo(12, 12);
		expect(result.usage.cost.output).toBeCloseTo(60, 12);
	});

	it("sends service_tier ultrafast on the WebSocket response.create event", async () => {
		process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "pi-ultrafast-"));
		const sent: Array<Record<string, unknown>> = [];

		class MockWebSocket {
			private listeners = new Map<string, Set<(event: unknown) => void>>();
			constructor() {
				queueMicrotask(() => this.dispatch("open", {}));
			}
			addEventListener(type: string, listener: (event: unknown) => void): void {
				let set = this.listeners.get(type);
				if (!set) {
					set = new Set();
					this.listeners.set(type, set);
				}
				set.add(listener);
			}
			removeEventListener(type: string, listener: (event: unknown) => void): void {
				this.listeners.get(type)?.delete(listener);
			}
			send(data: string): void {
				sent.push(JSON.parse(data));
				queueMicrotask(() =>
					this.dispatch("message", {
						data: JSON.stringify({ ...completedEvent("default"), type: "response.done" }),
					}),
				);
			}
			close(): void {}
			private dispatch(type: string, event: unknown): void {
				for (const listener of this.listeners.get(type) ?? []) listener(event);
			}
		}
		vi.stubGlobal("WebSocket", MockWebSocket);
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("unexpected fetch", { status: 500 })),
		);

		const result = await streamOpenAICodexResponses(codexModel("gpt-6.1-sol"), context, {
			apiKey: mockToken(),
			serviceTier: "ultrafast",
			sessionId: "ultrafast-ws",
			transport: "websocket",
		}).result();

		expect(sent).toHaveLength(1);
		expect(sent[0]?.type).toBe("response.create");
		expect(sent[0]?.service_tier).toBe("ultrafast");
		expect(result.usage.cost.input).toBeCloseTo(12, 12);
		expect(result.usage.cost.output).toBeCloseTo(60, 12);
	});
});
