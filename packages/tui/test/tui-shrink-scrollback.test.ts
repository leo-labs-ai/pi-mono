import assert from "node:assert";
import { describe, it } from "node:test";
import { type Component, CURSOR_MARKER } from "../src/tui.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

const HEIGHT = 6;

class Lines implements Component {
	lines: string[] = [];

	// Return a copy: the renderer strips CURSOR_MARKER from the array it receives.
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

/** 30 transcript lines, a status row and a prompt row. Viewport top is 26 at height 6. */
function transcript(status = "Status: running"): string[] {
	return [...Array.from({ length: 30 }, (_, i) => `Msg ${i}`), status, "> prompt"];
}

async function setup(initial: string[], rows = HEIGHT) {
	const terminal = new LoggingVirtualTerminal(40, rows);
	const tui = new TuiMainScreen(terminal);
	const component = new Lines();
	tui.addChild(component);
	component.lines = initial;
	tui.start();
	await terminal.waitForRender();
	const update = async (lines: string[]): Promise<void> => {
		component.lines = lines;
		tui.requestRender();
		await terminal.waitForRender();
	};
	return { terminal, tui, update };
}

function tail(lines: string[], rows = HEIGHT): string[] {
	return lines.slice(-rows);
}

function assertNoClear(writes: string): void {
	assert.ok(!writes.includes("\x1b[3J"), "must not clear scrollback");
	assert.ok(!writes.includes("\x1b[2J"), "must not clear the screen");
}

// Regression: earendil-works/pi#1130 (tool collapse clears native scrollback).
describe("TUI shrink with off-screen change", () => {
	it("repaints in place when an off-screen line is removed and the footer changes", async () => {
		const initial = transcript();
		const { terminal, tui, update } = await setup(initial);
		const redraws = tui.fullRedraws;
		const scrollbackBefore = terminal.getScrollBuffer().slice(0, 26);
		terminal.clearWrites();

		const next = transcript("Status: done");
		next.splice(3, 1);
		await update(next);

		assert.strictEqual(tui.fullRedraws, redraws, "must not clear and replay");
		assertNoClear(terminal.getWrites());
		assert.ok(!terminal.getWrites().includes("Msg 0"), "must not replay history");
		assert.deepStrictEqual(terminal.getViewport(), tail(next));
		assert.deepStrictEqual(
			terminal.getScrollBuffer().slice(0, 26),
			scrollbackBefore,
			"existing scrollback must stay in place",
		);
		tui.stop();
	});

	it("writes nothing visible for a pure off-screen deletion", async () => {
		const initial = transcript();
		const { terminal, tui, update } = await setup(initial);
		const redraws = tui.fullRedraws;
		terminal.clearWrites();

		const next = [...initial];
		next.splice(3, 1);
		await update(next);

		assert.strictEqual(tui.fullRedraws, redraws);
		assert.ok(!terminal.getWrites().includes("\x1b[2K"), "no row needs repainting");
		assert.deepStrictEqual(terminal.getViewport(), tail(next));
		tui.stop();
	});

	it("keeps logical viewport and cursor correct for later appends, edits and shrinks", async () => {
		const initial = transcript();
		const { terminal, tui, update } = await setup(initial);
		const redraws = tui.fullRedraws;

		let current = transcript("Status: done");
		current.splice(3, 1);
		await update(current);

		// Append: new rows must scroll in below the rebased bottom.
		current = [...current.slice(0, -2), "Msg 30", "Msg 31", "Status: done", "> prompt"];
		await update(current);
		assert.deepStrictEqual(terminal.getViewport(), tail(current));

		// Visible edit.
		current = [...current];
		current[current.length - 2] = "Status: idle";
		await update(current);
		assert.deepStrictEqual(terminal.getViewport(), tail(current));

		// Second off-screen deletion plus another visible edit.
		current = [...current];
		current.splice(5, 1);
		current[current.length - 2] = "Status: again";
		await update(current);
		assert.deepStrictEqual(terminal.getViewport(), tail(current));

		// Visible-only shrink goes through the existing path. The working area keeps its height,
		// so two blank rows remain below the content.
		current = [...current.slice(0, -3), "> prompt"];
		await update(current);
		assert.deepStrictEqual(terminal.getViewport(), ["Msg 28", "Msg 29", "Msg 30", "> prompt", "", ""]);

		// Append again after everything.
		current = [...current.slice(0, -1), "Msg tail", "> prompt"];
		await update(current);
		assert.deepStrictEqual(terminal.getViewport(), ["Msg 28", "Msg 29", "Msg 30", "Msg tail", "> prompt", ""]);

		assert.strictEqual(tui.fullRedraws, redraws, "no step should need a full redraw");
		tui.stop();
	});

	it("places the hardware cursor on the rebased prompt row", async () => {
		const initial = transcript();
		initial[initial.length - 1] = `> pr${CURSOR_MARKER}ompt`;
		const { terminal, tui, update } = await setup(initial);

		const next = transcript("Status: done");
		next[next.length - 1] = `> pr${CURSOR_MARKER}ompt`;
		next.splice(3, 1);
		await update(next);
		assert.deepStrictEqual(terminal.getCursorPosition(), { x: 4, y: HEIGHT - 1 });

		// A later append relies on hardwareCursorRow being rebased correctly.
		const appended = [...next.slice(0, -1), "Msg 30", `> pr${CURSOR_MARKER}ompt`];
		await update(appended);
		assert.deepStrictEqual(terminal.getCursorPosition(), { x: 4, y: HEIGHT - 1 });
		assert.deepStrictEqual(terminal.getViewport(), tail(appended.map((line) => line.replace(CURSOR_MARKER, ""))));
		assert.strictEqual(tui.fullRedraws, 1);
		tui.stop();
	});

	it("repaints a shrink that crosses the viewport boundary without stale rows", async () => {
		const initial = transcript();
		const { terminal, tui, update } = await setup(initial);
		const redraws = tui.fullRedraws;

		// Remove one off-screen line and one visible line, and edit the footer.
		const next = transcript("Status: done");
		next.splice(28, 1);
		next.splice(3, 1);
		await update(next);

		assert.strictEqual(tui.fullRedraws, redraws);
		assert.deepStrictEqual(terminal.getViewport(), tail(next));
		assert.ok(!terminal.getViewport().includes("Msg 28"));
		tui.stop();
	});

	// Real Pi leaves one blank working-area row below the prompt after a visible-only shrink
	// (for example the status row disappearing).
	it("repaints in place with one trailing blank row and keeps it blank across repeated updates", async () => {
		const initial = transcript();
		const { terminal, tui, update } = await setup(initial);

		// Visible-only shrink: viewportTop stays 26, so one blank row remains below the content.
		let current = [...initial.slice(0, -2), "> prompt"];
		await update(current);
		assert.deepStrictEqual(terminal.getViewport(), [...tail(current, HEIGHT - 1), ""]);
		const redraws = tui.fullRedraws;
		const scrollbackBefore = terminal.getScrollBuffer().slice(0, 26);
		terminal.clearWrites();

		// Off-screen removal plus a visible edit.
		current = [...current];
		current.splice(3, 1);
		current[current.length - 1] = "> prompt (edited)";
		await update(current);
		assert.strictEqual(tui.fullRedraws, redraws, "must not clear and replay");
		assertNoClear(terminal.getWrites());
		assert.ok(!terminal.getWrites().includes("Msg 0"), "must not replay history");
		assert.deepStrictEqual(terminal.getViewport(), [...tail(current, HEIGHT - 1), ""]);
		assert.deepStrictEqual(terminal.getScrollBuffer().slice(0, 25), scrollbackBefore.slice(0, 25));

		// Second off-screen removal, still with the blank row.
		current = [...current];
		current.splice(5, 1);
		current[current.length - 2] = "Msg 29 (edited)";
		await update(current);
		assert.deepStrictEqual(terminal.getViewport(), [...tail(current, HEIGHT - 1), ""]);

		// Pure visible update.
		current = [...current];
		current[current.length - 1] = "> prompt (again)";
		await update(current);
		assert.deepStrictEqual(terminal.getViewport(), [...tail(current, HEIGHT - 1), ""]);

		// Grow into the blank row, then past it so content scrolls.
		current = [...current.slice(0, -1), "Msg grow 1", "> prompt"];
		await update(current);
		assert.deepStrictEqual(terminal.getViewport(), tail(current));
		current = [...current.slice(0, -1), "Msg grow 2", "Msg grow 3", "> prompt"];
		await update(current);
		assert.deepStrictEqual(terminal.getViewport(), tail(current));

		// Off-screen shrink again on the now-full screen.
		current = [...current];
		current.splice(2, 1);
		current[current.length - 1] = "> prompt (final)";
		await update(current);
		assert.deepStrictEqual(terminal.getViewport(), tail(current));

		assert.strictEqual(tui.fullRedraws, redraws, "no step should need a full redraw");
		tui.stop();
	});

	it("keeps the hardware cursor on the prompt with a trailing blank row", async () => {
		const withCursor = (lines: string[]): string[] => {
			const out = [...lines];
			out[out.length - 1] = `> pr${CURSOR_MARKER}ompt`;
			return out;
		};
		const strip = (lines: string[]): string[] => lines.map((line) => line.replace(CURSOR_MARKER, ""));
		const initial = withCursor(transcript());
		const { terminal, tui, update } = await setup(initial);

		let current = withCursor([...transcript().slice(0, -2), "> prompt"]);
		await update(current);
		assert.deepStrictEqual(terminal.getCursorPosition(), { x: 4, y: HEIGHT - 2 });
		const redraws = tui.fullRedraws;

		current = withCursor([...current]);
		current.splice(3, 1);
		current[current.length - 2] = "Msg 29 (edited)";
		await update(current);
		assert.deepStrictEqual(terminal.getCursorPosition(), { x: 4, y: HEIGHT - 2 });
		assert.deepStrictEqual(terminal.getViewport(), [...tail(strip(current), HEIGHT - 1), ""]);

		current = withCursor([...current.slice(0, -1), "Msg grow", "> prompt"]);
		await update(current);
		assert.deepStrictEqual(terminal.getCursorPosition(), { x: 4, y: HEIGHT - 1 });
		assert.deepStrictEqual(terminal.getViewport(), tail(strip(current)));
		assert.strictEqual(tui.fullRedraws, redraws);
		tui.stop();
	});

	it("falls back to a full redraw for a deep shrink", async () => {
		const initial = transcript();
		const { terminal, tui, update } = await setup(initial);
		const redraws = tui.fullRedraws;

		// Removes more lines than the screen height, like compaction or /clear.
		const next = ["Summary", ...initial.slice(-3)];
		await update(next);

		assert.ok(tui.fullRedraws > redraws);
		assert.deepStrictEqual(terminal.getViewport(), [...next, "", ""]);
		tui.stop();
	});

	it("falls back to a full redraw when more lines vanish than sit above the viewport", async () => {
		const initial = Array.from({ length: 10 }, (_, i) => `Msg ${i}`);
		const { terminal, tui, update } = await setup(initial);
		const redraws = tui.fullRedraws;

		// viewportTop is 4; removing 5 lines would put the logical viewport above row 0.
		const next = ["Changed", ...initial.slice(6)];
		await update(next);

		assert.ok(tui.fullRedraws > redraws);
		assert.deepStrictEqual(terminal.getViewport(), [...next, "", "", "", ""].slice(0, HEIGHT));
		tui.stop();
	});

	it("falls back to a full redraw when clearOnShrink is enabled", async () => {
		const initial = transcript();
		const { terminal, tui, update } = await setup(initial);
		tui.setClearOnShrink(true);
		const redraws = tui.fullRedraws;

		const next = transcript("Status: done");
		next.splice(3, 1);
		await update(next);

		assert.ok(tui.fullRedraws > redraws);
		assert.deepStrictEqual(terminal.getViewport(), tail(next));
		tui.stop();
	});

	it("falls back to a full redraw when inline images are present", async () => {
		const initial = transcript();
		initial[10] = "\x1b_Ga=T,f=100,i=77;AAAA\x1b\\";
		const { terminal, tui, update } = await setup(initial);
		const redraws = tui.fullRedraws;

		const next = transcript("Status: done");
		next[10] = initial[10];
		next.splice(3, 1);
		await update(next);

		assert.ok(tui.fullRedraws > redraws);
		assert.deepStrictEqual(terminal.getViewport(), tail(next));
		tui.stop();
	});
});
