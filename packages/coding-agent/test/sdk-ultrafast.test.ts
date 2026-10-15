import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type Api,
	type AssistantMessage,
	createAssistantMessageEventStream,
	type Model,
	type SimpleStreamOptions,
} from "@leo-labs-ai/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";

describe("createAgentSession ultrafast service tier", () => {
	let tempDir: string;
	let cwd: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-sdk-ultrafast-"));
		cwd = join(tempDir, "project");
		agentDir = join(tempDir, "agent");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	function createModel(id: string, api: Api): Model<Api> {
		return {
			id,
			name: id,
			api,
			provider: "capture-provider",
			baseUrl: "https://capture.invalid/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 4096,
		};
	}

	function createDoneMessage(model: Model<Api>): AssistantMessage {
		return {
			role: "assistant",
			content: [{ type: "text", text: "ok" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};
	}

	/** Open a real session whose provider records the options of every request. */
	async function openSession(model: Model<Api>, ultrafast: boolean | undefined) {
		const settingsManager = SettingsManager.inMemory(ultrafast === undefined ? {} : { ultrafast });
		const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager });
		await resourceLoader.reload();

		const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
		await authStorage.modify(model.provider, async () => ({ type: "api_key", key: "test-api-key" }));
		const modelRegistry = await createModelRegistry(authStorage, join(agentDir, "models.json"));
		const captured: Array<SimpleStreamOptions | undefined> = [];
		modelRegistry.registerProvider(model.provider, {
			api: model.api,
			streamSimple: (requestModel, _context, providerOptions) => {
				captured.push(providerOptions);
				const stream = createAssistantMessageEventStream();
				stream.end(createDoneMessage(requestModel));
				return stream;
			},
		});

		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model,
			modelRuntime: getModelRuntime(modelRegistry),
			settingsManager,
			sessionManager: SessionManager.inMemory(cwd),
			resourceLoader,
		});
		return {
			session,
			settingsManager,
			captured,
			dispose: () => {
				session.dispose();
				modelRegistry.unregisterProvider(model.provider);
			},
		};
	}

	/** Send one prompt through a real session and return the options the provider received. */
	async function promptAndCapture(
		model: Model<Api>,
		ultrafast: boolean | undefined,
	): Promise<SimpleStreamOptions | undefined> {
		const fixture = await openSession(model, ultrafast);
		try {
			await fixture.session.prompt("hello");
			return fixture.captured[0];
		} finally {
			fixture.dispose();
		}
	}

	it("sends serviceTier ultrafast for a supported Responses model when enabled", async () => {
		const options = await promptAndCapture(createModel("openai/gpt-6.1-sol-mini", "openai-responses"), true);
		expect(options?.serviceTier).toBe("ultrafast");
	});

	it("sends serviceTier ultrafast for a supported Codex Responses model when enabled", async () => {
		const options = await promptAndCapture(createModel("gpt-6-astra", "openai-codex-responses"), true);
		expect(options?.serviceTier).toBe("ultrafast");
	});

	it("omits serviceTier when disabled", async () => {
		const options = await promptAndCapture(createModel("gpt-6.1-sol", "openai-responses"), false);
		expect(options).toBeDefined();
		expect(options?.serviceTier).toBeUndefined();
	});

	it("omits serviceTier by default", async () => {
		const options = await promptAndCapture(createModel("gpt-6.1-sol", "openai-responses"), undefined);
		expect(options).toBeDefined();
		expect(options?.serviceTier).toBeUndefined();
	});

	it("omits serviceTier on an unsupported model id even when enabled", async () => {
		const options = await promptAndCapture(createModel("gpt-5.5", "openai-responses"), true);
		expect(options).toBeDefined();
		expect(options?.serviceTier).toBeUndefined();
	});

	it("omits serviceTier on an unsupported API even when enabled", async () => {
		const options = await promptAndCapture(createModel("gpt-6.1-sol", "anthropic-messages"), true);
		expect(options).toBeDefined();
		expect(options?.serviceTier).toBeUndefined();
	});

	it("applies a setting change between prompts on the same session", async () => {
		const fixture = await openSession(createModel("gpt-6.1-sol", "openai-responses"), false);
		try {
			await fixture.session.prompt("first");
			fixture.settingsManager.setUltrafast(true);
			await fixture.session.prompt("second");
			fixture.settingsManager.setUltrafast(false);
			await fixture.session.prompt("third");

			expect(fixture.captured).toHaveLength(3);
			expect(fixture.captured.map((options) => options?.serviceTier)).toEqual([undefined, "ultrafast", undefined]);
		} finally {
			fixture.dispose();
		}
	});
});
