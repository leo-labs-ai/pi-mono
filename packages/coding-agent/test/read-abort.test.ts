import type * as fsPromises from "fs/promises";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { setImmediate } from "timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createReadToolDefinition } from "../src/core/tools/read.ts";

const hooks = vi.hoisted(() => ({
	controller: undefined as AbortController | undefined,
	phase: "" as "" | "open" | "stat" | "stream",
	closed: false,
}));

vi.mock("../src/utils/mime.ts", () => ({ detectSupportedImageMimeTypeFromFile: async () => undefined }));

vi.mock("fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof fsPromises>();
	return {
		...actual,
		open: async (...args: Parameters<typeof fsPromises.open>) => {
			const handle = await actual.open(...args);
			const stat = handle.stat.bind(handle);
			const close = handle.close.bind(handle);
			const createReadStream = handle.createReadStream.bind(handle);
			vi.spyOn(handle, "stat").mockImplementation(async (...statArgs) => {
				const result = await stat(...statArgs);
				if (hooks.phase === "stat") hooks.controller?.abort();
				return result;
			});
			handle.close = async () => {
				await close();
				hooks.closed = true;
			};
			handle.createReadStream = (...streamArgs) => {
				const stream = createReadStream(...streamArgs);
				if (hooks.phase === "stream") hooks.controller?.abort();
				return stream;
			};
			if (hooks.phase === "open") hooks.controller?.abort();
			return handle;
		},
	};
});

describe("local read cancellation", () => {
	let directory: string | undefined;
	afterEach(async () => {
		hooks.controller = undefined;
		hooks.phase = "";
		if (directory) await rm(directory, { recursive: true, force: true });
	});

	it.each(["open", "stat", "stream"] as const)("owns abort errors during %s and closes the file", async (phase) => {
		directory = await mkdtemp(join(tmpdir(), "pi-read-abort-"));
		const path = join(directory, "text.txt");
		await writeFile(path, "line\n".repeat(30_000));
		hooks.controller = new AbortController();
		hooks.phase = phase;
		hooks.closed = false;
		const tool = createReadToolDefinition(directory);
		await expect(
			tool.execute("read", { path }, hooks.controller.signal, undefined, undefined as never),
		).rejects.toThrow("Operation aborted");
		// Drain stream destruction and the detached execute task after its early abort rejection.
		for (let turn = 0; turn < 100 && !hooks.closed; turn++) await setImmediate();
		await setImmediate();
		expect(hooks.closed).toBe(true);
	});

	it("propagates non-abort stream errors", async () => {
		directory = await mkdtemp(join(tmpdir(), "pi-read-abort-"));
		const tool = createReadToolDefinition(directory);
		await expect(tool.execute("read", { path: directory }, undefined, undefined, undefined as never)).rejects.toThrow(
			"EISDIR",
		);
	});
});
