import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model } from "@leo-labs-ai/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { BUILTIN_SLASH_COMMANDS } from "../src/core/slash-commands.ts";
import {
	describeUltrafastStatus,
	getUltrafastState,
	isUltrafastActive,
	parseUltrafastArgument,
} from "../src/core/ultrafast.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

type ModelLike = Pick<Model<Api>, "id" | "api">;

const sol: ModelLike = { id: "openai/gpt-6.1-sol-mini", api: "openai-responses" };
const astra: ModelLike = { id: "gpt-6-astra", api: "openai-codex-responses" };
const unsupportedId: ModelLike = { id: "gpt-5.5", api: "openai-responses" };
const virtual: ModelLike = { id: "auto", api: "pi-virtual" };
const unsupportedApi: ModelLike = { id: "gpt-6.1-sol", api: "anthropic-messages" };

type UltrafastCommandContext = {
	settingsManager: SettingsManager;
	session: { model: ModelLike | undefined; routedModel?: { model: ModelLike } };
	footer: { invalidate: () => void };
	ui: { requestRender: () => void };
	showStatus: (message: string) => void;
	showWarning: (message: string) => void;
};

type InteractiveModePrototype = {
	handleUltrafastCommand(this: UltrafastCommandContext, argument: string): void;
};

const prototype = InteractiveMode.prototype as unknown as InteractiveModePrototype;

function createContext(model: ModelLike | undefined, ultrafast?: boolean) {
	const settingsManager = SettingsManager.inMemory(ultrafast === undefined ? {} : { ultrafast });
	const showStatus = vi.fn();
	const showWarning = vi.fn();
	const context: UltrafastCommandContext = {
		settingsManager,
		session: { model },
		footer: { invalidate: vi.fn() },
		ui: { requestRender: vi.fn() },
		showStatus,
		showWarning,
	};
	return { context, settingsManager, showStatus, showWarning };
}

describe("parseUltrafastArgument", () => {
	it("maps arguments to actions", () => {
		expect(parseUltrafastArgument("")).toBe("toggle");
		expect(parseUltrafastArgument("  ")).toBe("toggle");
		expect(parseUltrafastArgument(" on")).toBe("on");
		expect(parseUltrafastArgument("OFF")).toBe("off");
		expect(parseUltrafastArgument("status")).toBe("status");
		expect(parseUltrafastArgument("fast")).toBeUndefined();
	});
});

describe("ultrafast model support", () => {
	it("is active only for supported models", () => {
		expect(isUltrafastActive(true, sol)).toBe(true);
		expect(isUltrafastActive(true, astra)).toBe(true);
		expect(isUltrafastActive(true, unsupportedId)).toBe(false);
		expect(isUltrafastActive(true, unsupportedApi)).toBe(false);
		expect(isUltrafastActive(false, sol)).toBe(false);
		expect(isUltrafastActive(true, undefined)).toBe(false);
	});

	it("classifies the state of the selection", () => {
		expect(getUltrafastState(true, unsupportedId, undefined)).toBe("ignored");
		expect(getUltrafastState(true, sol, undefined)).toBe("active");
		expect(getUltrafastState(false, unsupportedId, undefined)).toBe("off");
		expect(getUltrafastState(true, undefined, undefined)).toBe("off");
	});

	it("treats a virtual selection as pending until routed, then uses the latest route", () => {
		expect(getUltrafastState(true, virtual, undefined)).toBe("pending");
		expect(getUltrafastState(true, virtual, sol)).toBe("routed-active");
		expect(getUltrafastState(true, virtual, unsupportedId)).toBe("routed-ignored");
		expect(getUltrafastState(false, virtual, sol)).toBe("off");
	});

	it("describes status", () => {
		expect(describeUltrafastStatus(false, sol)).toBe("Ultrafast is off");
		expect(describeUltrafastStatus(true, sol)).toContain("active for openai/gpt-6.1-sol-mini");
		expect(describeUltrafastStatus(true, unsupportedId)).toContain("gpt-5.5 does not support it");
		expect(describeUltrafastStatus(true, virtual)).toContain("support is known after the first routed response");
		expect(describeUltrafastStatus(true, virtual, sol)).toContain(
			"latest route (openai/gpt-6.1-sol-mini) supports it",
		);
		expect(describeUltrafastStatus(true, virtual, unsupportedId)).toContain(
			"latest route (gpt-5.5) does not support it",
		);
	});
});

describe("ultrafast setting", () => {
	it("defaults to off and persists changes", () => {
		const settings = SettingsManager.inMemory();
		expect(settings.getUltrafast()).toBe(false);
		settings.setUltrafast(true);
		expect(settings.getUltrafast()).toBe(true);
		settings.setUltrafast(false);
		expect(settings.getUltrafast()).toBe(false);
	});

	it("reads the stored value", () => {
		expect(SettingsManager.inMemory({ ultrafast: true }).getUltrafast()).toBe(true);
	});

	describe("on disk", () => {
		let tempDir: string;
		let cwd: string;
		let agentDir: string;

		beforeEach(() => {
			tempDir = mkdtempSync(join(tmpdir(), "pi-ultrafast-settings-"));
			cwd = join(tempDir, "project");
			agentDir = join(tempDir, "agent");
			mkdirSync(cwd, { recursive: true });
			mkdirSync(agentDir, { recursive: true });
		});

		afterEach(() => {
			rmSync(tempDir, { recursive: true, force: true });
		});

		it("persists to settings.json and survives a fresh load", async () => {
			const writer = SettingsManager.create(cwd, agentDir);
			expect(writer.getUltrafast()).toBe(false);
			writer.setUltrafast(true);
			await writer.flush();

			expect(JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf-8"))).toMatchObject({ ultrafast: true });
			expect(SettingsManager.create(cwd, agentDir).getUltrafast()).toBe(true);

			writer.setUltrafast(false);
			await writer.flush();
			expect(SettingsManager.create(cwd, agentDir).getUltrafast()).toBe(false);
		});

		it.each([true, false])("writes to the project file when it owns ultrafast=%s", async (projectValue) => {
			mkdirSync(join(cwd, ".pi"), { recursive: true });
			writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ ultrafast: projectValue }));
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ ultrafast: !projectValue }));
			const manager = SettingsManager.create(cwd, agentDir);
			expect(manager.getUltrafast()).toBe(projectValue);

			const context = { ...createContext(sol).context, settingsManager: manager };
			prototype.handleUltrafastCommand.call(context, projectValue ? "off" : "on");
			await manager.flush();

			expect(manager.getUltrafast()).toBe(!projectValue);
			expect(JSON.parse(readFileSync(join(cwd, ".pi", "settings.json"), "utf-8")).ultrafast).toBe(!projectValue);
			// The global file keeps its original, opposite value.
			expect(JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf-8")).ultrafast).toBe(!projectValue);
			expect(SettingsManager.create(cwd, agentDir).getUltrafast()).toBe(!projectValue);
		});

		it("persists a /ultrafast toggle and picks it up on reload", async () => {
			const manager = SettingsManager.create(cwd, agentDir);
			const context = { ...createContext(sol).context, settingsManager: manager };
			prototype.handleUltrafastCommand.call(context, "on");
			await manager.flush();

			const other = SettingsManager.create(cwd, agentDir);
			expect(other.getUltrafast()).toBe(true);
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ ultrafast: false }));
			await other.reload();
			expect(other.getUltrafast()).toBe(false);
		});
	});
});

describe("InteractiveMode /ultrafast", () => {
	it("is registered as a built-in command", () => {
		const command = BUILTIN_SLASH_COMMANDS.find((entry) => entry.name === "ultrafast");
		expect(command?.argumentHint).toBe("[on|off|status]");
	});

	it("toggles with no argument", () => {
		const { context, settingsManager, showStatus } = createContext(sol);
		prototype.handleUltrafastCommand.call(context, "");
		expect(settingsManager.getUltrafast()).toBe(true);
		expect(showStatus).toHaveBeenLastCalledWith(expect.stringContaining("Ultrafast is on"));
		prototype.handleUltrafastCommand.call(context, "");
		expect(settingsManager.getUltrafast()).toBe(false);
		expect(showStatus).toHaveBeenLastCalledWith("Ultrafast is off");
	});

	it("sets on and off explicitly", () => {
		const { context, settingsManager } = createContext(sol);
		prototype.handleUltrafastCommand.call(context, " on");
		prototype.handleUltrafastCommand.call(context, " on");
		expect(settingsManager.getUltrafast()).toBe(true);
		prototype.handleUltrafastCommand.call(context, " off");
		expect(settingsManager.getUltrafast()).toBe(false);
	});

	it("status does not change the setting", () => {
		const { context, settingsManager, showStatus } = createContext(sol, true);
		prototype.handleUltrafastCommand.call(context, " status");
		expect(settingsManager.getUltrafast()).toBe(true);
		expect(showStatus).toHaveBeenCalledWith(expect.stringContaining("active for"));
	});

	it("warns on unsupported models but keeps the preference", () => {
		const { context, settingsManager, showStatus, showWarning } = createContext(unsupportedId);
		prototype.handleUltrafastCommand.call(context, "on");
		expect(settingsManager.getUltrafast()).toBe(true);
		expect(showWarning).toHaveBeenCalledWith(expect.stringContaining("does not support it"));
		expect(showStatus).not.toHaveBeenCalled();
		// Switching back to a supported model makes the stored preference usable again.
		context.session.model = sol;
		prototype.handleUltrafastCommand.call(context, "status");
		expect(showStatus).toHaveBeenCalledWith(expect.stringContaining("active for"));
	});

	it("does not call a virtual selection ignored, and reports the latest route", () => {
		const { context, showStatus, showWarning } = createContext(virtual);
		prototype.handleUltrafastCommand.call(context, "on");
		expect(showStatus).toHaveBeenLastCalledWith(expect.stringContaining("support is known after"));
		context.session.routedModel = { model: sol };
		prototype.handleUltrafastCommand.call(context, "status");
		expect(showStatus).toHaveBeenLastCalledWith(expect.stringContaining("latest route"));
		expect(showWarning).not.toHaveBeenCalled();
		context.session.routedModel = { model: unsupportedId };
		prototype.handleUltrafastCommand.call(context, "status");
		expect(showWarning).toHaveBeenCalledWith(expect.stringContaining("latest route (gpt-5.5) does not support it"));
	});

	it("rejects unknown arguments without changing the setting", () => {
		const { context, settingsManager, showWarning } = createContext(sol);
		prototype.handleUltrafastCommand.call(context, " maybe");
		expect(settingsManager.getUltrafast()).toBe(false);
		expect(showWarning).toHaveBeenCalledWith("Usage: /ultrafast [on|off|status]");
	});
});
