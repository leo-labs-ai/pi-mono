import assert from "node:assert";
import { describe, it } from "node:test";
import type { LayoutGraph } from "../src/components/layout-graph.ts";
import { LayoutRenderer } from "../src/components/layout-renderer.ts";

// Raw ANSI escape sequences expected by matchesKey / Key.*.
const KEY = {
	up: "\x1b[A",
	down: "\x1b[B",
	right: "\x1b[C",
	left: "\x1b[D",
	enter: "\r",
	tab: "\t",
	space: " ",
	esc: "\x1b",
	ctrlC: "\x03",
};

// ----- fixtures --------------------------------------------------------------

function radioGraph(): LayoutGraph {
	return {
		version: "0.1",
		root: {
			type: "card",
			children: [
				{ type: "text", value: "Which retry strategy?" },
				{
					type: "radio_group",
					id: "strategy",
					options: [
						{ value: "exp", label: "Exponential backoff", description: "2^n" },
						{ value: "fixed", label: "Fixed interval", description: "every 5s" },
						{ value: "none", label: "No retry", description: "fail fast" },
					],
				},
			],
		},
	};
}

function checkboxGraph(): LayoutGraph {
	return {
		version: "0.1",
		root: {
			type: "card",
			children: [
				{ type: "text", value: "Pick targets" },
				{
					type: "checkbox_group",
					id: "targets",
					options: [
						{ value: "mac", label: "macOS" },
						{ value: "linux", label: "Linux" },
						{ value: "win", label: "Windows" },
					],
				},
			],
		},
	};
}

function tabsGraph(): LayoutGraph {
	return {
		version: "0.1",
		root: {
			type: "tabs",
			tabs: [
				{
					header: "Lang",
					content: {
						type: "card",
						children: [
							{ type: "text", value: "Language?" },
							{
								type: "radio_group",
								id: "lang",
								options: [
									{ value: "ts", label: "TS" },
									{ value: "rs", label: "Rust" },
								],
							},
						],
					},
				},
				{
					header: "Targets",
					content: {
						type: "card",
						children: [
							{ type: "text", value: "Targets?" },
							{
								type: "checkbox_group",
								id: "targets",
								options: [
									{ value: "mac", label: "macOS" },
									{ value: "linux", label: "Linux" },
								],
							},
						],
					},
				},
			],
		},
	};
}

// ----- tests -----------------------------------------------------------------

describe("LayoutRenderer / render", () => {
	it("renders a single radio group with the recommended option pre-selected", () => {
		const r = new LayoutRenderer(radioGraph(), { onSubmit: () => {} });
		const out = r.render(80).join("\n");
		assert.match(out, /Which retry strategy\?/);
		assert.match(out, /\(•\) Exponential backoff/);
		assert.match(out, /\( \) Fixed interval/);
		assert.match(out, /\( \) No retry/);
		assert.match(out, /→ \(•\)/, "focused cursor should appear on the first option");
	});

	it("renders an unselected checkbox group by default", () => {
		const r = new LayoutRenderer(checkboxGraph(), { onSubmit: () => {} });
		const out = r.render(80).join("\n");
		assert.match(out, /\[ \] macOS/);
		assert.match(out, /\[ \] Linux/);
		assert.match(out, /\[ \] Windows/);
	});

	it("renders a tab header strip with the active tab highlighted", () => {
		const r = new LayoutRenderer(tabsGraph(), { onSubmit: () => {} });
		const out = r.render(80);
		assert.match(out[0], /\[ Lang \]/, "active tab uses bracketed header");
		assert.match(out[0], /\s+Targets\s+/, "inactive tab is plain");
	});

	it("renders nested tabs visibly instead of dropping their content", () => {
		const graph: LayoutGraph = {
			version: "0.1",
			root: {
				type: "card",
				children: [
					{
						type: "tabs",
						tabs: [
							{ header: "One", content: { type: "text", value: "First nested panel" } },
							{ header: "Two", content: { type: "text", value: "Second nested panel" } },
						],
					},
				],
			},
		};
		const r = new LayoutRenderer(graph, { onSubmit: () => {} });
		const out = r.render(80).join("\n");
		assert.match(out, /One \| Two/);
		assert.match(out, /First nested panel/);
		assert.match(out, /Second nested panel/);
	});
});

describe("LayoutRenderer / input — radio", () => {
	it("Down moves cursor and selection follows", () => {
		const r = new LayoutRenderer(radioGraph(), { onSubmit: () => {} });
		assert.equal(r.getCursor("strategy"), 0);
		assert.deepEqual(r.snapshotResponse(), { strategy: "exp" });

		r.handleInput(KEY.down);
		assert.equal(r.getCursor("strategy"), 1);
		assert.deepEqual(r.snapshotResponse(), { strategy: "fixed" });

		r.handleInput(KEY.down);
		r.handleInput(KEY.down);
		assert.equal(r.getCursor("strategy"), 0, "wraps");
		assert.deepEqual(r.snapshotResponse(), { strategy: "exp" });
	});

	it("Enter fires onSubmit with current selection", () => {
		let submitted: unknown = null;
		const r = new LayoutRenderer(radioGraph(), {
			onSubmit: (resp) => {
				submitted = resp;
			},
		});
		r.handleInput(KEY.down);
		r.handleInput(KEY.enter);
		assert.deepEqual(submitted, { strategy: "fixed" });
	});

	it("ignores cursor navigation for malformed empty option groups", () => {
		const graph: LayoutGraph = {
			version: "0.1",
			root: { type: "radio_group", id: "empty", options: [] },
		};
		const r = new LayoutRenderer(graph, { onSubmit: () => {} });
		r.handleInput(KEY.down);
		assert.equal(r.getCursor("empty"), 0);
		assert.deepEqual(r.snapshotResponse(), { empty: undefined });
	});
});

describe("LayoutRenderer / input — checkbox", () => {
	it("Down moves cursor but does not toggle; Space toggles", () => {
		const r = new LayoutRenderer(checkboxGraph(), { onSubmit: () => {} });
		assert.deepEqual(r.snapshotResponse(), { targets: [] });

		r.handleInput(KEY.down); // cursor → 1 (Linux)
		assert.deepEqual(r.snapshotResponse(), { targets: [] }, "Down does not select");

		r.handleInput(KEY.space); // toggle Linux on
		assert.deepEqual(r.snapshotResponse(), { targets: ["linux"] });

		r.handleInput(KEY.down); // cursor → 2 (Windows)
		r.handleInput(KEY.space); // toggle Windows on
		assert.deepEqual(r.snapshotResponse(), { targets: ["linux", "win"] });

		r.handleInput(KEY.up); // cursor → 1 (Linux)
		r.handleInput(KEY.space); // toggle Linux off
		assert.deepEqual(r.snapshotResponse(), { targets: ["win"] });
	});
});

describe("LayoutRenderer / input — tabs", () => {
	it("Right/Left switch active tab and reset focus", () => {
		const r = new LayoutRenderer(tabsGraph(), { onSubmit: () => {} });
		assert.equal(r.getActiveTabIndex(), 0);
		assert.equal(r.getFocusedGroupId(), "lang");

		r.handleInput(KEY.right);
		assert.equal(r.getActiveTabIndex(), 1);
		assert.equal(r.getFocusedGroupId(), "targets");

		r.handleInput(KEY.left);
		assert.equal(r.getActiveTabIndex(), 0);
		assert.equal(r.getFocusedGroupId(), "lang");
	});

	it("Enter collects selections from every tab", () => {
		let submitted: unknown = null;
		const r = new LayoutRenderer(tabsGraph(), {
			onSubmit: (resp) => {
				submitted = resp;
			},
		});
		// Tab 0: lang stays "ts" (default)
		r.handleInput(KEY.right); // → tab 1 (targets)
		r.handleInput(KEY.space); // toggle macOS
		r.handleInput(KEY.down);
		r.handleInput(KEY.space); // toggle Linux
		r.handleInput(KEY.enter);
		assert.deepEqual(submitted, { lang: "ts", targets: ["mac", "linux"] });
	});
});

describe("LayoutRenderer / input — focus + cancel", () => {
	it("Tab cycles focus through groups in the current view", () => {
		// Build a graph with two groups in the same view.
		const graph: LayoutGraph = {
			version: "0.1",
			root: {
				type: "col",
				children: [
					{
						type: "radio_group",
						id: "a",
						options: [
							{ value: "1", label: "one" },
							{ value: "2", label: "two" },
						],
					},
					{
						type: "checkbox_group",
						id: "b",
						options: [
							{ value: "x", label: "X" },
							{ value: "y", label: "Y" },
						],
					},
				],
			},
		};
		const r = new LayoutRenderer(graph, { onSubmit: () => {} });
		assert.equal(r.getFocusedGroupId(), "a");
		r.handleInput(KEY.tab);
		assert.equal(r.getFocusedGroupId(), "b");
		r.handleInput(KEY.tab);
		assert.equal(r.getFocusedGroupId(), "a", "wraps");
	});

	it("Escape fires onCancel; Ctrl-C does too", () => {
		let cancels = 0;
		const r = new LayoutRenderer(radioGraph(), {
			onSubmit: () => assert.fail("should not submit"),
			onCancel: () => {
				cancels += 1;
			},
		});
		r.handleInput(KEY.esc);
		r.handleInput(KEY.ctrlC);
		assert.equal(cancels, 2);
	});
});

// #588: graph-supplied values and duplicate group IDs.
describe("LayoutRenderer / initial values", () => {
	function submitOf(graph: LayoutGraph): unknown {
		let submitted: unknown = null;
		const r = new LayoutRenderer(graph, {
			onSubmit: (resp) => {
				submitted = resp;
			},
		});
		r.handleInput(KEY.enter);
		return submitted;
	}

	it("keeps a pre-populated radio value and puts the cursor on it", () => {
		const graph = radioGraph();
		if (graph.root.type !== "card" || graph.root.children[1].type !== "radio_group") assert.fail("fixture shape");
		graph.root.children[1].value = "none";
		const r = new LayoutRenderer(graph, { onSubmit: () => {} });
		assert.equal(r.getCursor("strategy"), 2);
		assert.deepEqual(submitOf(graph), { strategy: "none" });
	});

	it("keeps pre-populated checkbox values and drops unknown ones", () => {
		const graph = checkboxGraph();
		if (graph.root.type !== "card" || graph.root.children[1].type !== "checkbox_group") assert.fail("fixture shape");
		graph.root.children[1].value = ["linux", "bogus", "win"];
		assert.deepEqual(submitOf(graph), { targets: ["linux", "win"] });
	});

	it("falls back to the first radio option when the value is unknown", () => {
		const graph = radioGraph();
		if (graph.root.type !== "card" || graph.root.children[1].type !== "radio_group") assert.fail("fixture shape");
		graph.root.children[1].value = "bogus";
		assert.deepEqual(submitOf(graph), { strategy: "exp" });
	});

	it("rejects duplicate group IDs", () => {
		const group = { type: "radio_group" as const, id: "dup", options: [{ value: "a", label: "A" }] };
		const graph: LayoutGraph = { version: "0.1", root: { type: "col", children: [group, { ...group }] } };
		assert.throws(() => new LayoutRenderer(graph, { onSubmit: () => {} }), /duplicate group id "dup"/);
	});
});
