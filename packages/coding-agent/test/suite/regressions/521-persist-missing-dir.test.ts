import {
	appendFileSync,
	existsSync,
	constants as fsConstants,
	type Mode,
	mkdirSync,
	mkdtempSync,
	type OpenMode,
	type PathLike,
	readFileSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, type MockInstance, vi } from "vitest";
import { type SessionEntry, SessionManager } from "../../../src/core/session-manager.ts";

const fsInterleave = vi.hoisted(() => ({
	existsSync: null as null | ((actual: typeof import("node:fs"), path: PathLike) => boolean),
	openSync: null as
		| null
		| ((actual: typeof import("node:fs"), path: PathLike, flags: OpenMode, mode?: Mode) => number),
}));

vi.mock("fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		existsSync: (path: PathLike) =>
			fsInterleave.existsSync ? fsInterleave.existsSync(actual, path) : actual.existsSync(path),
		openSync: (path: PathLike, flags: OpenMode, mode?: Mode) =>
			fsInterleave.openSync
				? fsInterleave.openSync(actual, path, flags, mode)
				: passThroughOpen(actual, path, flags, mode),
	};
});

const assistant = {
	role: "assistant" as const,
	content: [{ type: "text" as const, text: "hi" }],
	api: "anthropic-messages" as const,
	provider: "anthropic",
	model: "test",
	usage: {
		input: 1,
		output: 1,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 2,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	stopReason: "stop" as const,
	timestamp: 2,
};

describe("regression #521: recreate a missing session directory between appends", () => {
	let tempDir: string | undefined;

	afterEach(() => {
		fsInterleave.existsSync = null;
		fsInterleave.openSync = null;
		vi.restoreAllMocks();
		if (tempDir) rmSync(tempDir, { recursive: true, force: true });
		tempDir = undefined;
	});

	function persistedSession(): SessionManager {
		tempDir = mkdtempSync(join(tmpdir(), "pi-521-"));
		const cwd = join(tempDir, "project");
		const sessionDir = join(tempDir, "sessions");
		mkdirSync(cwd, { recursive: true });
		return SessionManager.create(cwd, sessionDir);
	}

	function silenceWarn(): MockInstance<(...args: unknown[]) => void> {
		return vi.spyOn(console, "warn").mockImplementation(() => {});
	}

	function expectBoundedWarning(warn: MockInstance<(...args: unknown[]) => void>, sessionId: string): void {
		expect(warn).toHaveBeenCalledTimes(1);
		expect(warn).toHaveBeenCalledWith(`Warning: recreated missing session directory for session ${sessionId}`);
	}

	it("appends after the parent directory of a flushed session file is removed", () => {
		const session = persistedSession();
		session.appendMessage({ role: "user", content: "hello", timestamp: 1 });
		session.appendMessage(assistant);
		const assistantId = session.getLeafId();
		const sessionFile = session.getSessionFile();
		expect(sessionFile).toBeDefined();
		expect(existsSync(sessionFile!)).toBe(true);

		rmSync(session.getSessionDir(), { recursive: true, force: true });
		expect(existsSync(session.getSessionDir())).toBe(false);

		const warn = silenceWarn();
		expect(() => session.appendCustomEntry("probe", { ok: true })).not.toThrow();

		expect(existsSync(session.getSessionDir())).toBe(true);
		expect(existsSync(sessionFile!)).toBe(true);
		const text = readFileSync(sessionFile!, "utf8");
		expect(text).toContain(`"id":"${session.getSessionId()}"`);
		expect(text).toContain('"customType":"probe"');
		expectBoundedWarning(warn, session.getSessionId());

		const entries = expectReloadedChain(sessionFile!, session.getSessionDir(), session.getSessionId());
		expect(entries.some((entry) => entry.type === "custom" && entry.parentId === assistantId)).toBe(true);

		appendFileSync(
			sessionFile!,
			`${JSON.stringify({
				type: "custom",
				customType: "disk-only",
				id: "disk-only",
				parentId: assistantId,
				timestamp: "2020-01-01T00:00:00.000Z",
			})}\n`,
		);
		expect(() => session.appendCustomEntry("after", { ok: true })).not.toThrow();
		const after = readFileSync(sessionFile!, "utf8");
		expect(after).toContain('"id":"disk-only"');
		expect(after).toContain('"customType":"after"');
		expect(warn).toHaveBeenCalledTimes(1);
	});

	it("creates the session file when the directory disappears before the first flush", () => {
		const session = persistedSession();
		session.appendMessage({ role: "user", content: "hello", timestamp: 1 });
		const sessionFile = session.getSessionFile();
		expect(sessionFile).toBeDefined();
		expect(existsSync(sessionFile!)).toBe(false);

		rmSync(session.getSessionDir(), { recursive: true, force: true });
		const warn = silenceWarn();
		expect(() => session.appendMessage(assistant)).not.toThrow();

		expect(existsSync(sessionFile!)).toBe(true);
		const text = readFileSync(sessionFile!, "utf8");
		expect(text).toContain('"role":"user"');
		expect(text).toContain('"role":"assistant"');
		expectBoundedWarning(warn, session.getSessionId());

		const entries = expectReloadedChain(sessionFile!, session.getSessionDir(), session.getSessionId());
		expect(entries.map((entry) => (entry.type === "message" ? entry.message.role : entry.type))).toEqual([
			"user",
			"assistant",
		]);
	});

	it("keeps a restored file when it appears before the recovery write", () => {
		const session = persistedSession();
		session.appendMessage({ role: "user", content: "hello", timestamp: 1 });
		session.appendMessage(assistant);
		const assistantId = session.getLeafId();
		const sessionFile = session.getSessionFile()!;
		const marker = `${JSON.stringify({
			type: "custom",
			customType: "durable-only",
			data: { marker: "keep-restored-bytes" },
			id: "durable-only-marker",
			parentId: assistantId,
			timestamp: "2020-01-01T00:00:00.000Z",
		})}\n`;
		appendFileSync(sessionFile, marker);
		const original = readFileSync(sessionFile, "utf8");
		expect(original).toContain("durable-only-marker");

		rmSync(session.getSessionDir(), { recursive: true, force: true });
		plantOnCreate(sessionFile, original);
		const warn = silenceWarn();

		expect(() => session.appendCustomEntry("probe", { ok: true })).not.toThrow();
		stopInterleave();

		const text = readFileSync(sessionFile, "utf8");
		expect(text.startsWith(original)).toBe(true);
		expect(text).toContain('"customType":"probe"');
		expectBoundedWarning(warn, session.getSessionId());

		const entries = expectReloadedChain(sessionFile, session.getSessionDir(), session.getSessionId());
		expect(entries.some((entry) => entry.id === "durable-only-marker")).toBe(true);
		expect(entries.filter((entry) => entry.parentId === assistantId).length).toBeGreaterThanOrEqual(2);
	});

	it("reloads a connected session when a restored file disappears before append", () => {
		const session = persistedSession();
		session.appendMessage({ role: "user", content: "hello-restored", timestamp: 1 });
		session.appendMessage(assistant);
		const assistantId = session.getLeafId();
		const sessionFile = session.getSessionFile()!;
		const original = readFileSync(sessionFile, "utf8");

		rmSync(session.getSessionDir(), { recursive: true, force: true });
		reportMissingFileAsPresent(sessionFile);
		const interleave = plantOnCreate(sessionFile, original, { removeBeforeAppend: true });
		const warn = silenceWarn();

		expect(() => session.appendCustomEntry("probe", { ok: true })).not.toThrow();
		expect(interleave.planted).toBe(true);
		expect(interleave.removedBeforeAppend).toBe(true);
		stopInterleave();

		const text = readFileSync(sessionFile, "utf8");
		const lines = text.trim().split("\n");
		expect(lines.length).toBeGreaterThan(1);
		expect(JSON.parse(lines[0]).type).toBe("session");
		expect(JSON.parse(lines[0]).id).toBe(session.getSessionId());
		expect(text).toContain("hello-restored");
		expect(text).toContain('"customType":"probe"');
		expectBoundedWarning(warn, session.getSessionId());

		const entries = expectReloadedChain(sessionFile, session.getSessionDir(), session.getSessionId());
		const user = entries.find((entry) => entry.type === "message" && entry.message.role === "user");
		const probe = entries.find((entry) => entry.type === "custom");
		expect(user?.parentId).toBeNull();
		expect(entries.find((entry) => entry.id === assistantId)?.parentId).toBe(user?.id);
		expect(probe?.parentId).toBe(assistantId);
	});

	it("leaves a restored file untouched when its session header does not match", () => {
		const session = persistedSession();
		session.appendMessage({ role: "user", content: "hello", timestamp: 1 });
		session.appendMessage(assistant);
		const sessionFile = session.getSessionFile()!;
		const foreign = `${JSON.stringify({
			type: "session",
			version: 3,
			id: "foreign-session-id",
			timestamp: "2020-01-01T00:00:00.000Z",
			cwd: "/tmp/elsewhere",
		})}\n${JSON.stringify({
			type: "custom",
			customType: "keep",
			id: "foreign-preserved",
			parentId: null,
			timestamp: "2020-01-01T00:00:00.000Z",
		})}\n`;

		rmSync(session.getSessionDir(), { recursive: true, force: true });
		plantOnCreate(sessionFile, foreign);
		const warn = silenceWarn();

		expect(() => session.appendCustomEntry("probe", { ok: true })).toThrow(/restored file header does not match/);
		stopInterleave();

		expect(readFileSync(sessionFile, "utf8")).toBe(foreign);
		expectBoundedWarning(warn, session.getSessionId());
		expect(JSON.stringify(warn.mock.calls)).not.toContain(tempDir!);
		expect(JSON.stringify(warn.mock.calls)).not.toContain(sessionFile);
	});
});

function expectReloadedChain(sessionFile: string, sessionDir: string, sessionId: string): SessionEntry[] {
	stopInterleave();
	const reloaded = SessionManager.open(sessionFile, sessionDir);
	expect(reloaded.getSessionId()).toBe(sessionId);
	const entries = reloaded.getEntries();
	const ids = new Set(entries.map((entry) => entry.id));
	expect(entries.filter((entry) => entry.parentId === null)).toHaveLength(1);
	for (const entry of entries) {
		if (entry.parentId !== null) expect(ids.has(entry.parentId)).toBe(true);
	}
	return entries;
}

function stopInterleave(): void {
	fsInterleave.existsSync = null;
	fsInterleave.openSync = null;
}

function reportMissingFileAsPresent(sessionFile: string): void {
	fsInterleave.existsSync = (actual, path) => {
		if (path === sessionFile && !actual.existsSync(path)) return true;
		return actual.existsSync(path);
	};
}

/** Plant `bytes` immediately before the recovery create so a truncating "w" open destroys them and "wx" does not. */
function plantOnCreate(
	sessionFile: string,
	bytes: string,
	options?: { removeBeforeAppend?: boolean },
): { planted: boolean; removedBeforeAppend: boolean } {
	const observed = { planted: false, removedBeforeAppend: false };
	let armedRemoval = false;
	fsInterleave.openSync = (actual, path, flags, mode) => {
		if (path === sessionFile && !observed.planted && (flags === "w" || flags === "wx")) {
			observed.planted = true;
			const fd = actual.openSync(path, "w");
			try {
				actual.writeFileSync(fd, bytes);
			} finally {
				actual.closeSync(fd);
			}
			armedRemoval = options?.removeBeforeAppend === true;
		} else if (path === sessionFile && armedRemoval && isNonCreatingAppend(flags)) {
			armedRemoval = false;
			observed.removedBeforeAppend = true;
			actual.rmSync(path, { force: true });
		}
		return passThroughOpen(actual, path, flags, mode);
	};
	return observed;
}

function isNonCreatingAppend(flags: OpenMode): boolean {
	if (typeof flags === "number") {
		return (flags & fsConstants.O_APPEND) !== 0 && (flags & fsConstants.O_CREAT) === 0;
	}
	return flags === "a" || flags === "a+";
}

function passThroughOpen(actual: typeof import("node:fs"), path: PathLike, flags: OpenMode, mode?: Mode): number {
	return mode === undefined ? actual.openSync(path, flags) : actual.openSync(path, flags, mode);
}
