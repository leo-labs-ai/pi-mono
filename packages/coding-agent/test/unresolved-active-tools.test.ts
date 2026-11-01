/** Startup warnings observe configured exact tool requests without changing selection. */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { getModel } from "@leo-labs-ai/pi-ai/compat";
import { Container } from "@leo-labs-ai/pi-tui";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import type { AgentSession } from "../src/core/agent-session.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { createAgentSession, type InlineExtension } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
const uppercaseAliases: InlineExtension = (pi) => {
	for (const name of ["Read", "Edit", "Write", "Grep"]) {
		pi.registerTool({
			name, label: name, description: `Test alias ${name}`, parameters: Type.Object({}),
			execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
		});
	}
};

const DEFAULT_TOOLS = ["read", "bash", "edit", "write"];
const CONFIGURED_TOOLS = ["Read", "Edit", "Write", "Grep", "read"];
const CASE_GUIDANCE =
	"Registered tool names are case-sensitive. Request the available lowercase names read, edit, write, and grep, or register uppercase aliases via an extension.";
const cliPath = resolve(__dirname, "../src/cli.ts");
const sourceResolverPath = resolve(__dirname, "../src/experimental/source-resolver.ts");

describe("unresolved initial active tools", () => {
	const tempDirs: string[] = [];
	const sessions: AgentSession[] = [];

	afterEach(() => {
		for (const session of sessions.splice(0)) session.dispose();
		for (const dir of tempDirs.splice(0)) {
			if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
		}
	});

	async function createIsolatedSession(options?: {
		extensionFactories?: InlineExtension[];
		tools?: string[];
		defaultTools?: string[];
		excludeTools?: string[];
	}): Promise<{ session: AgentSession; extensionPaths: string[] }> {
		const tempDir = join(tmpdir(), `pi-438-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		tempDirs.push(tempDir);
		const agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
		const settingsManager = SettingsManager.inMemory({ defaultTools: options?.defaultTools });
		const resourceLoader = new DefaultResourceLoader({
			cwd: tempDir,
			agentDir,
			settingsManager,
			extensionFactories: options?.extensionFactories,
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
		});
		await resourceLoader.reload();
		const extensionPaths = resourceLoader.getExtensions().extensions.map((extension) => extension.path);
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			settingsManager,
			sessionManager: SessionManager.inMemory(tempDir),
			resourceLoader,
			tools: options?.tools,
			excludeTools: options?.excludeTools,
		});
		sessions.push(session);
		expect(session.model).toMatchObject({ provider: "anthropic", id: "claude-sonnet-4-5" });
		return { session, extensionPaths };
	}

	function sortedToolNames(session: AgentSession): string[] {
		return session
			.getAllTools()
			.map((tool) => tool.name)
			.sort((left, right) => {
				if (left < right) return -1;
				if (left > right) return 1;
				return 0;
			});
	}

	it("keeps the current default startup quiet", async () => {
		const { session } = await createIsolatedSession();
		expect(session.getActiveToolNames()).toEqual(DEFAULT_TOOLS);
		expect(session.getStartupDiagnostics()).toEqual([]);
	});

	it("keeps wildcard selectors quiet", async () => {
		const { session } = await createIsolatedSession({ tools: ["r*"] });
		expect(session.getActiveToolNames()).toEqual(["read"]);
		expect(session.getStartupDiagnostics()).toEqual([]);
	});

	it("diagnoses resolved additions but not removals or exclusions", async () => {
		const { session } = await createIsolatedSession({ tools: ["+Nope", "-read"] });
		expect(session.getStartupDiagnostics()[0]?.message).toMatch(/^Requested active tool not registered: Nope\./);
		expect(session.getActiveToolNames()).toEqual(["bash", "edit", "write"]);
		const excluded = await createIsolatedSession({ defaultTools: ["Nope", "read"], excludeTools: ["Nope"] });
		expect(excluded.session.getStartupDiagnostics()).toEqual([]);
	});

	it("does not confuse hidden declarations with unregistered tools", async () => {
		const hidden: InlineExtension = (pi) => {
			pi.registerTool({
				name: "hidden_tool", label: "Hidden", description: "Registered hidden tool", parameters: Type.Object({}),
				execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
				prepareLoadout: () => ({ hiddenDeclarations: ["hidden_tool"] }),
			});
		};
		const { session } = await createIsolatedSession({ tools: ["hidden_tool"], extensionFactories: [hidden] });
		expect(session.getAllTools().map((tool) => tool.name)).toContain("hidden_tool");
		expect(session.getStartupDiagnostics()).toEqual([]);
	});

	it("names the unregistered default spellings and leaves prompt and schemas unchanged", async () => {
		const { session, extensionPaths } = await createIsolatedSession({ defaultTools: CONFIGURED_TOOLS });
		expect(extensionPaths).toEqual([]);
		const prompt = session.systemPrompt;
		const active = session.getActiveToolNames();
		const schemas = session.agent.state.tools.map((tool) => ({
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters,
		}));

		expect(active).toEqual(["read"]);
		expect(sortedToolNames(session)).toEqual(
			expect.arrayContaining(["read", "edit", "write", "grep"]),
		);
		expect(sortedToolNames(session)).not.toContain("Read");

		const diagnostics = session.getStartupDiagnostics();
		expect(diagnostics).toHaveLength(1);
		expect(diagnostics[0]?.type).toBe("warning");
		const message = diagnostics[0]?.message ?? "";
		const availablePrefix = `Requested active tools not registered: Read, Edit, Write, Grep. ${CASE_GUIDANCE} Available tools: `;
		expect(message.startsWith(availablePrefix)).toBe(true);
		expect(message.endsWith(".")).toBe(true);
		expect(message.slice(availablePrefix.length, -1).split(", ")).toEqual(sortedToolNames(session));
		expect(message).not.toContain("native-tool-overrides");
		expect(prompt).not.toContain("not registered");
		expect(prompt).not.toContain("case-sensitive");
		expect(prompt).not.toContain("uppercase aliases");

		expect(session.getStartupDiagnostics()).toEqual(diagnostics);
		expect(session.systemPrompt).toBe(prompt);
		expect(
			session.agent.state.tools.map((tool) => ({
				name: tool.name,
				description: tool.description,
				parameters: tool.parameters,
			})),
		).toEqual(schemas);

		session.setActiveToolsByName([...CONFIGURED_TOOLS, "Nope"]);
		expect(session.getActiveToolNames()).toEqual(active);
		expect(session.systemPrompt).toBe(prompt);
		expect(session.getStartupDiagnostics()).toEqual(diagnostics);
	});

	it("stays quiet when an extension registers the uppercase aliases", async () => {
		const { session, extensionPaths } = await createIsolatedSession({
			extensionFactories: [uppercaseAliases],
			defaultTools: CONFIGURED_TOOLS,
		});
		expect(extensionPaths).toEqual(["<inline:1>"]);

		expect(session.getActiveToolNames()).toEqual(CONFIGURED_TOOLS);
		expect(session.getStartupDiagnostics()).toEqual([]);
		expect(session.systemPrompt).not.toContain("not registered");
	});

	it("names an arbitrary missing tool at startup without the case-alias guidance", async () => {
		const { session } = await createIsolatedSession({ tools: ["Nope", "read"] });
		const diagnostics = session.getStartupDiagnostics();
		expect(diagnostics).toHaveLength(1);
		const message = diagnostics[0]?.message ?? "";
		expect(message.startsWith("Requested active tool not registered: Nope. Available tools: ")).toBe(true);
		expect(message).not.toContain("case-sensitive");
		expect(message).not.toContain("native-tool-overrides");
		expect(message).not.toContain("uppercase alias");
		expect(session.getActiveToolNames()).toEqual(["read"]);
		expect(session.systemPrompt).not.toContain("not registered");

		session.setActiveToolsByName(["AlsoMissing", "read"]);
		expect(session.getStartupDiagnostics()).toEqual(diagnostics);
		expect(session.getActiveToolNames()).toEqual(["read"]);
	});

	it("renders the same startup warning on the interactive transcript", async () => {
		const { session } = await createIsolatedSession({ defaultTools: CONFIGURED_TOOLS });
		const message = session.getStartupDiagnostics()[0]?.message ?? "";
		initTheme("dark");
		const chatContainer = new Container();
		const context = {
			chatContainer,
			ui: { requestRender: () => {} },
			showWarning: (InteractiveMode.prototype as unknown as { showWarning(message: string): void }).showWarning,
		};
		context.showWarning.call(context, message);
		const rendered = chatContainer.children
			.flatMap((child) => child.render(80))
			.join("\n")
			.replace(/\u001b\[[0-9;]*m/g, "")
			.replace(/\s+/g, " ");
		expect(rendered).toContain(
			`Warning: Requested active tools not registered: Read, Edit, Write, Grep. ${CASE_GUIDANCE}`,
		);
		expect(rendered).not.toContain("native-tool-overrides");
	});

	it.each([true, false])("CLI stderr reports only configured missing requests (configured=%s)", async (configured) => {
		const tempDir = join(tmpdir(), `pi-438-cli-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		tempDirs.push(tempDir);
		const agentDir = join(tempDir, "agent");
		const projectDir = join(tempDir, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(projectDir, { recursive: true });
		if (configured) writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultTools: CONFIGURED_TOOLS }));

		const result = await new Promise<{
			stdout: string;
			stderr: string;
			code: number | null;
			signal: NodeJS.Signals | null;
		}>((resolvePromise, reject) => {
			const child = spawn(
				process.execPath,
				["--import", sourceResolverPath, cliPath, "--print", "--no-extensions", "--offline"],
				{
					cwd: projectDir,
					env: {
						...process.env,
						[ENV_AGENT_DIR]: agentDir,
						PI_OFFLINE: "1",
					},
					stdio: ["ignore", "pipe", "pipe"],
				},
			);
			let stdout = "";
			let stderr = "";
			child.stdout.on("data", (chunk) => {
				stdout += chunk.toString();
			});
			child.stderr.on("data", (chunk) => {
				stderr += chunk.toString();
			});
			const timeout = setTimeout(() => child.kill("SIGKILL"), 30_000);
			child.on("error", (error) => {
				clearTimeout(timeout);
				reject(error);
			});
			child.on("close", (code, signal) => {
				clearTimeout(timeout);
				resolvePromise({ stdout, stderr, code, signal });
			});
		});

		expect(result.signal).toBeNull();
		expect(result.code).toBe(0);
		if (configured) {
			expect(result.stderr).toContain(
				`Warning: Requested active tools not registered: Read, Edit, Write, Grep. ${CASE_GUIDANCE}`,
			);
		} else {
			expect(result.stderr).not.toContain("not registered");
		}
		expect(result.stderr).not.toContain("native-tool-overrides");
		expect(result.stdout).not.toContain("not registered");
		expect(result.stdout).not.toContain("case-sensitive");
	}, 40_000);
});
