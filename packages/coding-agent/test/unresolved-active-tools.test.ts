/**
 * Startup contract for issue #438.
 *
 * The default active request includes Read/Edit/Write/Grep. Core registers
 * read/edit/write/grep. An isolated loader (temp agent dir, noExtensions) must
 * not pick up whatever global profile is installed. The session still starts
 * with the tools that did resolve. The startup warning names the misses and
 * the registered lowercase spellings. It does not mention a post-start update.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { getModel } from "@lue-labs/pi-ai/compat";
import { Container } from "@lue-labs/pi-tui";
import { afterEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import type { AgentSession } from "../src/core/agent-session.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { createAgentSession, type InlineExtension } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { nativeToolAliasesFactory } from "./native-tool-aliases-factory.ts";

const EXTENSION_FREE_ACTIVE_TOOLS = ["Bash", "BashOutput", "KillShell", "Agent", "Task", "Glob"];
const CASE_GUIDANCE =
	"Registered tool names are case-sensitive. Request the available lowercase names read, edit, write, and grep, or register uppercase aliases via an extension.";
const cliPath = resolve(__dirname, "../src/cli.ts");
const sourceResolverPath = resolve(__dirname, "../src/experimental/source-resolver.ts");

describe("unresolved default active tools", () => {
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
	}): Promise<{ session: AgentSession; extensionPaths: string[] }> {
		const tempDir = join(tmpdir(), `pi-438-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		tempDirs.push(tempDir);
		const agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
		const settingsManager = SettingsManager.inMemory();
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

	it("names the unregistered default spellings and leaves prompt and schemas unchanged", async () => {
		const { session, extensionPaths } = await createIsolatedSession();
		expect(extensionPaths).toEqual([]);
		const prompt = session.systemPrompt;
		const active = session.getActiveToolNames();
		const schemas = session.agent.state.tools.map((tool) => ({
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters,
		}));

		expect(active).toEqual(EXTENSION_FREE_ACTIVE_TOOLS);
		expect(sortedToolNames(session)).toEqual(
			expect.arrayContaining(["read", "edit", "write", "grep", "Bash", "Glob"]),
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

		session.setActiveToolsByName([
			"Read",
			"Bash",
			"BashOutput",
			"KillShell",
			"Edit",
			"Write",
			"Agent",
			"Task",
			"Grep",
			"Glob",
			"Nope",
		]);
		expect(session.getActiveToolNames()).toEqual(active);
		expect(session.systemPrompt).toBe(prompt);
		expect(session.getStartupDiagnostics()).toEqual(diagnostics);
	});

	it("stays quiet when an extension registers the uppercase aliases", async () => {
		const { session, extensionPaths } = await createIsolatedSession({
			extensionFactories: [nativeToolAliasesFactory],
		});
		expect(extensionPaths).toEqual(["<inline:1>"]);

		expect(session.getActiveToolNames()).toEqual([
			"Read",
			"Bash",
			"BashOutput",
			"KillShell",
			"Edit",
			"Write",
			"Agent",
			"Task",
			"Grep",
			"Glob",
		]);
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
		const { session } = await createIsolatedSession();
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

	it("prints the startup warning on the CLI stderr operators see", async () => {
		const tempDir = join(tmpdir(), `pi-438-cli-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		tempDirs.push(tempDir);
		const agentDir = join(tempDir, "agent");
		const projectDir = join(tempDir, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(projectDir, { recursive: true });

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
		expect(result.stderr).toContain(
			`Warning: Requested active tools not registered: Read, Edit, Write, Grep. ${CASE_GUIDANCE}`,
		);
		expect(result.stderr).not.toContain("native-tool-overrides");
		expect(result.stdout).not.toContain("not registered");
		expect(result.stdout).not.toContain("case-sensitive");
	}, 40_000);
});
