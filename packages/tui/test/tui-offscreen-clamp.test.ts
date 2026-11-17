// Pins main-screen behavior from leo-labs-ai/pi-mono#431: a later edit that stays
// entirely above the viewport is not painted, and a line wider than the viewport is
// truncated to one row. Assertions use the terminal buffer and the bytes written to it.
import assert from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { Component } from "../src/tui.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

class Lines implements Component {
	lines: string[] = [];

	// Copy: the renderer appends resets to the array it receives.
	render(): string[] {
		return [...this.lines];
	}

	invalidate(): void {}
}

class LoggingVirtualTerminal extends VirtualTerminal {
	private writes: string[] = [];

	override write(data: string): void {
		this.writes.push(data);
		super.write(data);
	}

	getWrites(): string {
		return this.writes.join("");
	}

	clearWrites(): void {
		this.writes = [];
	}
}

function numberedRows(count: number): string[] {
	return Array.from({ length: count }, (_, index) => `row-${String(index).padStart(2, "0")}`);
}

/** One column, so an ASCII line clamped to `width` keeps `width - 1` characters before it. */
const ELLIPSIS = "…";

function expectedClamp(text: string, width: number): string {
	return `${text.slice(0, width - 1)}${ELLIPSIS}`;
}

interface Screen {
	terminal: LoggingVirtualTerminal;
	update(lines: string[]): Promise<void>;
}

async function withScreen(
	width: number,
	height: number,
	lines: string[],
	run: (screen: Screen) => Promise<void>,
): Promise<void> {
	// Clamping writes a crash log. Keep it out of the shared temp directory.
	const logDir = mkdtempSync(join(tmpdir(), "pi-tui-clamp-"));
	const terminal = new LoggingVirtualTerminal(width, height);
	const tui = new TuiMainScreen(terminal, undefined, logDir);
	const component = new Lines();
	tui.addChild(component);
	component.lines = lines;
	try {
		tui.start();
		await terminal.waitForRender();
		await run({
			terminal,
			async update(next: string[]): Promise<void> {
				component.lines = next;
				terminal.clearWrites();
				tui.renderNow();
				await terminal.flush();
			},
		});
	} finally {
		tui.stop();
		rmSync(logDir, { recursive: true, force: true });
	}
}

describe("TUI offscreen skip and overwide clamp", () => {
	it("skips an edit that stays entirely above the viewport, including an overwide line", async () => {
		const lines = numberedRows(12);
		const width = 20;
		const height = 5;
		await withScreen(width, height, lines, async ({ terminal, update }) => {
			assert.deepStrictEqual(terminal.getViewport(), lines.slice(-height));
			assert.deepStrictEqual(terminal.getScrollBuffer(), lines);

			// Rows 0 and 6 are above the viewport (top is 7). Row 6 is the last such row.
			// One of them is wider than the screen, so a paint would also clamp or wrap it.
			const next = [...lines];
			next[0] = `gone-${"Q".repeat(60)}`;
			next[6] = `edge-${"R".repeat(60)}`;
			await update(next);

			assert.strictEqual(terminal.getWrites(), "", "off-screen lines must not be written");
			assert.deepStrictEqual(terminal.getViewport(), lines.slice(-height));
			assert.deepStrictEqual(
				terminal.getScrollBuffer(),
				lines,
				"scrollback still shows the lines from the last paint",
			);
		});
	});

	it("repaints only the visible rows when an off-screen edit is paired with an overwide visible line", async () => {
		const lines = numberedRows(12);
		const width = 20;
		await withScreen(width, 5, lines, async ({ terminal, update }) => {
			const next = [...lines];
			next[2] = `off-${"Q".repeat(40)}`;
			next[6] = `edge-${"R".repeat(40)}`;
			next[9] = "S".repeat(50);
			await update(next);

			assert.deepStrictEqual(terminal.getViewport(), [
				"row-07",
				"row-08",
				expectedClamp("S".repeat(50), width),
				"row-10",
				"row-11",
			]);
			assert.deepStrictEqual(terminal.getScrollBuffer().slice(0, 7), lines.slice(0, 7));
			const writes = terminal.getWrites();
			assert.ok(!writes.includes("off-"), "the off-screen line must not be written");
			assert.ok(!writes.includes("edge-"), "the last off-screen line must not be written");
			assert.ok(!writes.includes("Q".repeat(40)));
			assert.ok(!writes.includes("S".repeat(50)), "the visible line must not be written unclamped");
			assert.ok(!writes.includes("\x1b[2J"), "the screen must not be cleared");
			assert.ok(!writes.includes("\x1b[3J"), "scrollback must not be cleared");
		});
	});

	it("clamps a line wider than the viewport to one row instead of wrapping or overflowing it", async () => {
		const width = 10;
		const overwide = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
		const tail = overwide.slice(width);
		await withScreen(width, 5, ["above", "short", "below"], async ({ terminal, update }) => {
			assert.deepStrictEqual(terminal.getViewport(), ["above", "short", "below", "", ""]);

			await update(["above", overwide, "below"]);
			assert.deepStrictEqual(
				terminal.getViewport(),
				["above", expectedClamp(overwide, width), "below", "", ""],
				"wrapping would push 'below' down or fill the blank rows",
			);
			assert.ok(!terminal.getWrites().includes(overwide));
			assert.ok(!terminal.getWrites().includes(tail));

			// Eight ideographs are 16 columns. Four plus the ellipsis fit in this 10-column row.
			await update(["above", "界".repeat(8), "below"]);
			assert.deepStrictEqual(terminal.getViewport(), ["above", `界界界界${ELLIPSIS}`, "below", "", ""]);
			assert.ok(!terminal.getWrites().includes("界".repeat(5)), "a wide grapheme must not spill onto the next row");

			await update(["above", "0123456789", "below"]);
			assert.deepStrictEqual(terminal.getViewport(), ["above", "0123456789", "below", "", ""]);

			await update(["above", "0123456789X", "below"]);
			assert.deepStrictEqual(terminal.getViewport(), [
				"above",
				expectedClamp("0123456789X", width),
				"below",
				"",
				"",
			]);

			await update(["above", `\x1b[31m${"M".repeat(30)}\x1b[0m`, "below"]);
			assert.deepStrictEqual(terminal.getViewport(), [
				"above",
				expectedClamp("M".repeat(30), width),
				"below",
				"",
				"",
			]);
			assert.ok(!terminal.getWrites().includes("M".repeat(width)));
		});
	});

	it("clamps an overwide line that scrolls into scrollback instead of wrapping it into the viewport", async () => {
		const width = 10;
		const overwide = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
		await withScreen(width, 4, [overwide, "one", "two", "three", "four"], async ({ terminal }) => {
			assert.deepStrictEqual(terminal.getViewport(), ["one", "two", "three", "four"]);
			assert.deepStrictEqual(terminal.getScrollBuffer(), [
				expectedClamp(overwide, width),
				"one",
				"two",
				"three",
				"four",
			]);
			assert.ok(!terminal.getWrites().includes(overwide));
			assert.ok(!terminal.getWrites().includes(overwide.slice(width)));
		});
	});

	it("clamps the repainted row when a shrink starts above the viewport", async () => {
		const width = 16;
		const lines = ["off-0", "off-1", "off-2", "off-3", "off-4", "vis-0", "vis-1", "vis-2", "vis-3"];
		const overwide = "W".repeat(40);
		await withScreen(width, 4, lines, async ({ terminal, update }) => {
			assert.deepStrictEqual(terminal.getViewport(), ["vis-0", "vis-1", "vis-2", "vis-3"]);

			// Drop one scrolled-off row and replace a visible row with a line wider than the screen.
			const next = ["off-0", "off-2", "off-3", "off-4", "vis-0", overwide, "vis-2", "vis-3"];
			await update(next);

			assert.deepStrictEqual(terminal.getViewport(), ["vis-0", expectedClamp(overwide, width), "vis-2", "vis-3"]);
			// The deleted row stays in scrollback. Only the visible row is rewritten.
			assert.deepStrictEqual(terminal.getScrollBuffer(), [
				"off-0",
				"off-1",
				"off-2",
				"off-3",
				"off-4",
				"vis-0",
				expectedClamp(overwide, width),
				"vis-2",
				"vis-3",
			]);
			const writes = terminal.getWrites();
			assert.ok(!writes.includes(overwide), "the repainted row must not be written unclamped");
			assert.ok(!writes.includes("off-0"), "history above the viewport must not be replayed");
			assert.ok(!writes.includes("\x1b[2J"), "the screen must not be cleared");
			assert.ok(!writes.includes("\x1b[3J"), "scrollback must not be cleared");
		});
	});
});
