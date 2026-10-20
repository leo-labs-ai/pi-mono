import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel, streamSimple, type Model } from "@leo-labs-ai/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createBashTool } from "../src/core/tools/bash.ts";

class PayloadCaptured extends Error {}

interface CapturedAnthropicPayload {
	tools?: Array<{ name: string }>;
	messages: Array<{
		role: string;
		content: Array<{ type: string; tool?: { type: string; name?: string } }>;
	}>;
}

describe("AgentSession dynamic tool registration", () => {
	let tempDir: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-dynamic-tool-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("exposes session state before custom bash spawn hooks and supports opting out", async () => {
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const sessionManager = SessionManager.create(tempDir, join(agentDir, "sessions"), { id: "bash-env-test" });
		let sessionEnv: NodeJS.ProcessEnv | undefined;
		let optedOutEnv: NodeJS.ProcessEnv | undefined;
		const resourceLoader = new DefaultResourceLoader({
			cwd: tempDir,
			agentDir,
			settingsManager,
			extensionFactories: [
				(pi) => {
					pi.registerTool(
						createBashTool(tempDir, {
							spawnHook: (ctx) => {
								sessionEnv = ctx.env;
								return ctx;
							},
						}),
					);
					pi.registerTool({
						...createBashTool(tempDir, {
							exposeSessionEnvironment: false,
							spawnHook: (ctx) => {
								optedOutEnv = ctx.env;
								return ctx;
							},
						}),
						name: "bash_without_session_env",
						label: "bash without session env",
					});
				},
			],
		});
		await resourceLoader.reload();

		const model = getModel("anthropic", "claude-sonnet-4-5")!;
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			model,
			thinkingLevel: "high",
			settingsManager,
			sessionManager,
			resourceLoader,
		});

		const bashTool = session.agent.state.tools.find((tool) => tool.name === "bash")!;
		expect(session.systemPrompt).toContain(
			"You can inspect PI_* environment variables for current model and session details.",
		);
		await bashTool.execute("bash-env", { command: "printf ok" });
		expect(sessionEnv).toMatchObject({
			PI_SESSION_ID: session.sessionId,
			PI_SESSION_FILE: session.sessionFile,
			PI_PROVIDER: model.provider,
			PI_MODEL: model.id,
			PI_REASONING_LEVEL: session.thinkingLevel,
		});

		const optedOutBashTool = session.agent.state.tools.find((tool) => tool.name === "bash_without_session_env")!;
		await optedOutBashTool.execute("bash-no-env", { command: "printf ok" });
		expect(optedOutEnv).not.toHaveProperty("PI_SESSION_ID");
		expect(optedOutEnv).not.toHaveProperty("PI_SESSION_FILE");
		expect(optedOutEnv).not.toHaveProperty("PI_PROVIDER");
		expect(optedOutEnv).not.toHaveProperty("PI_MODEL");
		expect(optedOutEnv).not.toHaveProperty("PI_REASONING_LEVEL");

		session.dispose();
	});

	it("refreshes tool registry when tools are registered after initialization", async () => {
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const sessionManager = SessionManager.inMemory();

		const resourceLoader = new DefaultResourceLoader({
			cwd: tempDir,
			agentDir,
			settingsManager,
			extensionFactories: [
				(pi) => {
					pi.on("session_start", () => {
						pi.registerTool({
							name: "dynamic_tool",
							label: "Dynamic Tool",
							description: "Tool registered from session_start",
							promptSnippet: "Run dynamic test behavior",
							promptGuidelines: ["Use dynamic_tool when the user asks for dynamic behavior tests."],
							parameters: Type.Object({}),
							execute: async () => ({
								content: [{ type: "text", text: "ok" }],
								details: {},
							}),
						});
					});
				},
			],
		});
		await resourceLoader.reload();

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			settingsManager,
			sessionManager,
			resourceLoader,
		});

		expect(session.getAllTools().map((tool) => tool.name)).not.toContain("dynamic_tool");

		await session.bindExtensions({});

		const allTools = session.getAllTools();
		const dynamicTool = allTools.find((tool) => tool.name === "dynamic_tool");
		const readTool = allTools.find((tool) => tool.name === "read");

		expect(allTools.map((tool) => tool.name)).toContain("dynamic_tool");
		expect(dynamicTool?.promptGuidelines).toEqual([
			"Use dynamic_tool when the user asks for dynamic behavior tests.",
		]);
		expect(dynamicTool?.sourceInfo).toMatchObject({
			path: "<inline:1>",
			source: "inline",
			scope: "temporary",
			origin: "top-level",
		});
		expect(readTool?.sourceInfo).toMatchObject({
			path: "builtin:read",
			source: "builtin",
			scope: "temporary",
			origin: "top-level",
		});
		expect(session.getActiveToolNames()).toContain("dynamic_tool");
		expect(session.systemPrompt).toContain("- dynamic_tool: Run dynamic test behavior");
		expect(session.systemPrompt).toContain("- Use dynamic_tool when the user asks for dynamic behavior tests.");

		session.dispose();
	});

	it("returns source metadata for SDK custom tools", async () => {
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const sessionManager = SessionManager.inMemory();
		const resourceLoader = new DefaultResourceLoader({
			cwd: tempDir,
			agentDir,
			settingsManager,
		});
		await resourceLoader.reload();

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			settingsManager,
			sessionManager,
			resourceLoader,
			customTools: [
				{
					name: "sdk_tool",
					label: "SDK Tool",
					description: "Tool registered through createAgentSession",
					parameters: Type.Object({}),
					execute: async () => ({
						content: [{ type: "text", text: "ok" }],
						details: {},
					}),
				},
			],
		});

		const sdkTool = session.getAllTools().find((tool) => tool.name === "sdk_tool");
		expect(sdkTool?.sourceInfo).toMatchObject({
			path: "<sdk:sdk_tool>",
			source: "sdk",
			scope: "temporary",
			origin: "top-level",
		});
		expect(session.getActiveToolNames()).toContain("sdk_tool");

		session.dispose();
	});

	it("keeps custom tools active but omits them from available tools when promptSnippet is not provided", async () => {
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const sessionManager = SessionManager.inMemory();

		const resourceLoader = new DefaultResourceLoader({
			cwd: tempDir,
			agentDir,
			settingsManager,
			extensionFactories: [
				(pi) => {
					pi.on("session_start", () => {
						pi.registerTool({
							name: "hidden_tool",
							label: "Hidden Tool",
							description: "Description should not appear in available tools",
							parameters: Type.Object({}),
							execute: async () => ({
								content: [{ type: "text", text: "ok" }],
								details: {},
							}),
						});
					});
				},
			],
		});
		await resourceLoader.reload();

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			settingsManager,
			sessionManager,
			resourceLoader,
		});

		await session.bindExtensions({});

		expect(session.getAllTools().map((tool) => tool.name)).toContain("hidden_tool");
		expect(session.getActiveToolNames()).toContain("hidden_tool");
		expect(session.systemPrompt).not.toContain("hidden_tool");
		expect(session.systemPrompt).not.toContain("Description should not appear in available tools");

		session.dispose();
	});

	it("preserves a dynamic tool checkpoint across reload and sends a valid Anthropic removal", async () => {
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		settingsManager.applyOverrides({ compaction: { keepRecentTokens: 1 } });
		const sessionManager = SessionManager.inMemory();
		const model = getModel("anthropic", "claude-sonnet-4-5");
		if (!model || model.api !== "anthropic-messages") throw new Error("expected Anthropic model");
		const anthropicModel: Model<"anthropic-messages"> = {
			...model,
			compat: {
				...model.compat,
				supportsMidConvoSystemMessages: true,
				supportsMidConvoToolChanges: true,
			},
		};
		const now = Date.now();
		sessionManager.appendMessage({ role: "system", content: "starting prompt", timestamp: now - 4_000 });
		sessionManager.appendMessage({ role: "user", content: "message to compact", timestamp: now - 3_000 });
		sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "response to compact" }],
			api: anthropicModel.api,
			provider: anthropicModel.provider,
			model: anthropicModel.id,
			usage: {
				input: 100,
				output: 10,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 110,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: now - 2_000,
		});
		sessionManager.appendMessage({ role: "user", content: "retained request", timestamp: now - 1_000 });

		const resourceLoader = new DefaultResourceLoader({
			cwd: tempDir,
			agentDir,
			settingsManager,
			extensionFactories: [
				(pi) => {
					pi.registerTool({
						name: "init_experiment",
						label: "Init Experiment",
						description: "Initialize an experiment session",
						parameters: Type.Object({}),
						execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
					});
					pi.on("session_start", (event) => {
						const activeTools = new Set(pi.getActiveTools().map((tool) => tool.name));
						if (event.reason === "reload") activeTools.delete("init_experiment");
						else activeTools.add("init_experiment");
						pi.setActiveTools([...activeTools]);
					});
					pi.on("session_before_compact", (event) => ({
						compaction: {
							summary: "compaction summary",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
						},
					}));
				},
			],
		});
		await resourceLoader.reload();

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			model: anthropicModel,
			settingsManager,
			sessionManager,
			resourceLoader,
		});
		try {
			await session.bindExtensions({ onError: () => {} });
			expect(session.getActiveToolNames()).toContain("init_experiment");

			await session.compact();
			const compaction = sessionManager.getBranch().filter((entry) => entry.type === "compaction").at(-1);
			if (compaction?.type !== "compaction") throw new Error("expected compaction entry");
			expect(compaction.systemMessage?.toolsAdded?.map((tool) => tool.name)).toContain("init_experiment");

			await session.reload();
			expect(session.getActiveToolNames()).not.toContain("init_experiment");
			session.agent.streamFunction = streamSimple;
			session.agent.getApiKey = () => "test-key";
			let capturedPayload: CapturedAnthropicPayload | undefined;
			session.agent.onPayload = (payload) => {
				capturedPayload = payload as CapturedAnthropicPayload;
				throw new PayloadCaptured();
			};

			await session.prompt("continue after reload");

			if (!capturedPayload) throw new Error("expected Anthropic payload capture");
			expect(capturedPayload.tools?.map((tool) => tool.name)).toContain("init_experiment");
			const removals = capturedPayload.messages.flatMap((message) =>
				message.content.flatMap((block) =>
					block.type === "tool_removal" && block.tool?.name ? [block.tool.name] : [],
				),
			);
			expect(removals).toEqual(["init_experiment"]);
		} finally {
			session.dispose();
		}
	});
});
