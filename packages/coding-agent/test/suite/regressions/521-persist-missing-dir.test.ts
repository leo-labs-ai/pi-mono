import type * as fs from "node:fs";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "../../../src/core/session-manager.ts";

const interleave = vi.hoisted(() => ({
	beforeOpen: null as null | ((actual: typeof fs, path: fs.PathLike, flags: fs.OpenMode) => void),
	beforeWrite: null as null | ((actual: typeof fs, file: fs.PathOrFileDescriptor) => void),
}));

vi.mock("fs", async (importOriginal) => {
	const actual = await importOriginal<typeof fs>();
	return {
		...actual,
		openSync: (...args: Parameters<typeof fs.openSync>) => {
			interleave.beforeOpen?.(actual, args[0], args[1]);
			return actual.openSync(...args);
		},
		writeFileSync: (...args: Parameters<typeof fs.writeFileSync>) => {
			interleave.beforeWrite?.(actual, args[0]);
			return actual.writeFileSync(...args);
		},
	};
});

describe("regression #521: bounded recovery of missing session persistence", () => {
	let tempDir: string | undefined;

	afterEach(() => {
		interleave.beforeOpen = null;
		interleave.beforeWrite = null;
		vi.restoreAllMocks();
		if (tempDir) rmSync(tempDir, { recursive: true, force: true });
		tempDir = undefined;
	});

	function createSession(): SessionManager {
		tempDir = mkdtempSync(join(tmpdir(), "pi-521-"));
		const cwd = join(tempDir, "project");
		mkdirSync(cwd);
		return SessionManager.create(cwd, join(tempDir, "sessions"));
	}

	function conversation(): SessionManager {
		const session = createSession();
		session.appendMessage({ role: "user", content: "keep this prompt", timestamp: 1 });
		expect(session.isPersisted()).toBe(true);
		return session;
	}

	function expectConnected(session: SessionManager): void {
		interleave.beforeOpen = null;
		interleave.beforeWrite = null;
		const reloaded = SessionManager.open(session.getSessionFile()!, session.getSessionDir());
		expect(reloaded.getSessionId()).toBe(session.getSessionId());
		expect(reloaded.getEntries()).toEqual(session.getEntries());
		const ids = new Set(reloaded.getEntries().map((entry) => entry.id));
		for (const entry of reloaded.getEntries()) {
			if (entry.parentId !== null) expect(ids.has(entry.parentId)).toBe(true);
		}
	}

	function restoreBeforeExclusiveCreate(session: SessionManager, bytes: string): void {
		interleave.beforeOpen = (actual, path, flags) => {
			if (path !== session.getSessionFile() || flags !== "wx") return;
			interleave.beforeOpen = null;
			actual.writeFileSync(path, bytes);
		};
	}

	it("recovers all resident entries after directory loss and warns without leaking paths", () => {
		const session = conversation();
		const root = session.getLeafId()!;
		session.appendCustomEntry("before", { keep: true });
		session.branch(root);
		session.appendCustomEntry("other-branch", { keep: true });
		rmSync(session.getSessionDir(), { recursive: true });
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		session.appendCustomEntry("after", { keep: true });
		expectConnected(session);
		expect(warn).toHaveBeenCalledExactlyOnceWith(
			`Warning: recreated missing session directory for session ${session.getSessionId()}`,
		);
		expect(JSON.stringify(warn.mock.calls)).not.toContain(tempDir!);
		session.appendCustomEntry("later", {});
		expectConnected(session);
		expect(warn).toHaveBeenCalledTimes(1);
	});

	it("ordinary appends retain disk-only entries rather than rewriting resident history", () => {
		const session = conversation();
		const marker = JSON.stringify({
			type: "custom",
			customType: "disk-only",
			id: "disk-only",
			parentId: session.getLeafId(),
			timestamp: "2026-01-01T00:00:00.000Z",
		});
		appendFileSync(session.getSessionFile()!, `${marker}\n`);
		const before = readFileSync(session.getSessionFile()!, "utf8");
		session.appendCustomEntry("ordinary", {});
		expect(readFileSync(session.getSessionFile()!, "utf8").startsWith(before)).toBe(true);
	});

	it("propagates a non-missing-path error without entering recovery", () => {
		const session = conversation();
		const before = readFileSync(session.getSessionFile()!, "utf8");
		interleave.beforeOpen = () => {
			throw Object.assign(new Error("permission fixture"), { code: "EACCES" });
		};
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		expect(() => session.appendCustomEntry("denied", {})).toThrow("permission fixture");
		expect(readFileSync(session.getSessionFile()!, "utf8")).toBe(before);
		expect(warn).not.toHaveBeenCalled();
	});

	it("preserves main's first-user-message flush after directory loss", () => {
		const session = createSession();
		session.appendCustomEntry("setup", {});
		expect(existsSync(session.getSessionFile()!)).toBe(false);
		rmSync(session.getSessionDir(), { recursive: true });
		vi.spyOn(console, "warn").mockImplementation(() => {});
		session.appendMessage({ role: "user", content: "first prompt", timestamp: 1 });
		expectConnected(session);
	});

	it("recovers a missing file without requiring its directory to disappear", () => {
		const session = conversation();
		rmSync(session.getSessionFile()!);
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		session.appendCustomEntry("after-file-loss", {});
		expectConnected(session);
		expect(warn).not.toHaveBeenCalled();
	});

	it.each(["older-same-id", "complete-same-id", "foreign"])(
		"refuses %s restoration collisions and keeps later appends from corrupting the backup",
		(kind) => {
			const session = conversation();
			const older = readFileSync(session.getSessionFile()!, "utf8");
			session.appendCustomEntry("resident-parent", {});
			const complete = readFileSync(session.getSessionFile()!, "utf8");
			const restored = kind === "older-same-id" ? older : kind === "complete-same-id" ? complete : "foreign bytes\n";
			rmSync(session.getSessionDir(), { recursive: true });
			restoreBeforeExclusiveCreate(session, restored);
			vi.spyOn(console, "warn").mockImplementation(() => {});
			expect(() => session.appendCustomEntry("refused", {})).toThrow(/EEXIST/);
			expect(readFileSync(session.getSessionFile()!, "utf8")).toBe(restored);
			expect(() => session.appendCustomEntry("also-refused", {})).toThrow(/EEXIST/);
			expect(readFileSync(session.getSessionFile()!, "utf8")).toBe(restored);
			// Once the conflicting file is removed, every resident entry is recovered,
			// including parents from the failed calls rather than a disconnected tail.
			rmSync(session.getSessionFile()!);
			session.appendCustomEntry("recovered", {});
			expectConnected(session);
		},
	);

	it("keeps refusing a collision for an opened transcript without conversation messages", () => {
		const original = createSession();
		writeFileSync(original.getSessionFile()!, `${JSON.stringify(original.getHeader())}\n`);
		const session = SessionManager.open(original.getSessionFile()!, original.getSessionDir());
		const backup = readFileSync(session.getSessionFile()!, "utf8");
		rmSync(session.getSessionFile()!);
		restoreBeforeExclusiveCreate(session, backup);
		expect(() => session.appendCustomEntry("refused", {})).toThrow(/EEXIST/);
		expect(() => session.appendCustomEntry("also-refused", {})).toThrow(/EEXIST/);
		expect(readFileSync(session.getSessionFile()!, "utf8")).toBe(backup);
	});

	it("detects unlink after opening the append descriptor and before writing", () => {
		const session = conversation();
		interleave.beforeWrite = (actual, file) => {
			if (typeof file !== "number") return;
			interleave.beforeWrite = null;
			actual.rmSync(session.getSessionFile()!);
		};
		session.appendCustomEntry("racing-append", {});
		expectConnected(session);
	});

	it("refuses replacement during an append without modifying the replacement", () => {
		const session = conversation();
		interleave.beforeWrite = (actual, file) => {
			if (typeof file !== "number") return;
			interleave.beforeWrite = null;
			actual.rmSync(session.getSessionFile()!);
			actual.writeFileSync(session.getSessionFile()!, "replacement\n");
		};
		expect(() => session.appendCustomEntry("racing-append", {})).toThrow(/EEXIST/);
		expect(() => session.appendCustomEntry("later-append", {})).toThrow(/EEXIST/);
		expect(readFileSync(session.getSessionFile()!, "utf8")).toBe("replacement\n");
	});

	it("bounds recovery when the exclusive replacement is also unlinked", () => {
		const session = conversation();
		rmSync(session.getSessionFile()!);
		let writes = 0;
		interleave.beforeWrite = (actual, file) => {
			if (typeof file !== "number" || writes++ !== 0) return;
			actual.rmSync(session.getSessionFile()!);
		};
		expect(() => session.appendCustomEntry("lost-recovery", {})).toThrow(/disappeared during persistence/);
		expect(existsSync(session.getSessionFile()!)).toBe(false);
		interleave.beforeWrite = null;
		session.appendCustomEntry("recovered", {});
		expectConnected(session);
	});
});
