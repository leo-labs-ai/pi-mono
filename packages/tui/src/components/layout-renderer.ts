/**
 * LayoutRenderer — walks a LayoutGraph and produces an interactive Pi TUI
 * Component. The renderer's sole input is a typed LayoutGraph (produced by
 * the UI Harness); it owns input routing and emits a LayoutResponse via
 * `onSubmit` when the user confirms.
 *
 * See: rusty/docs/prd/generative-ui-proposal.md §5 / §6.
 *
 * MVP scope (the AskUserQuestion subset, end-to-end):
 *   - tabs                    — left/right to switch
 *   - card                    — title above indented children, no frame
 *   - col / row / stack       — vertical stacking (row==col in a TUI)
 *   - text                    — single-line text
 *   - radio_group             — cursor = selection (auto-selects on move)
 *   - checkbox_group          — cursor + space-to-toggle
 *
 * Other node types render a placeholder line so traversal is total without
 * inflating MVP surface area. Add a renderer + input handler per node as
 * the catalog grows — see §5.4 ("catalog is the API surface").
 *
 * Lifecycle: this component is born `active`. Caller is responsible for the
 * `pending` skeleton (before the graph arrives) and the `archived` summary
 * (after submit). See proposal §6.
 *
 * Keys (hardcoded for MVP; TODO: route through the keybinding system):
 *   ↑ / ↓        — move cursor within the focused group
 *   ← / →        — switch tab (only when root is `tabs`)
 *   Tab          — cycle focus through interactive groups in current tab
 *   Space        — toggle (checkbox) / re-select (radio)
 *   Enter        — submit
 *   Esc / Ctrl-C — cancel
 */

import { Key, matchesKey } from "../keys.ts";
import type { Component } from "../tui.ts";
import type { LayoutGraph, LayoutNode, LayoutResponse } from "./layout-graph.ts";

export interface LayoutRendererTheme {
	/** Applied to the cursor prefix in the focused group. */
	highlight: (text: string) => string;
	/** Applied to option descriptions. */
	dim: (text: string) => string;
	/** Applied to card titles and active tab headers. */
	accent: (text: string) => string;
}

const identityTheme: LayoutRendererTheme = {
	highlight: (s) => s,
	dim: (s) => s,
	accent: (s) => s,
};

export interface LayoutRendererOptions {
	onSubmit: (response: LayoutResponse) => void;
	onCancel?: () => void;
	theme?: LayoutRendererTheme;
}

type GroupNode = Extract<LayoutNode, { type: "radio_group" | "checkbox_group" }>;

interface GroupInfo {
	id: string;
	type: "radio_group" | "checkbox_group";
	optionCount: number;
	optionValues: string[];
	/** Initial selection from the graph's `value`, restricted to known options. */
	initialSelection: string[];
}

export class LayoutRenderer implements Component {
	private readonly graph: LayoutGraph;
	private readonly theme: LayoutRendererTheme;
	private readonly onSubmit: (response: LayoutResponse) => void;
	private readonly onCancel: (() => void) | undefined;

	// State
	private activeTabIndex = 0;
	private focusedGroupIndex = 0;
	private readonly cursorByGroup = new Map<string, number>();
	private readonly selectionByGroup = new Map<string, string[]>();

	constructor(graph: LayoutGraph, options: LayoutRendererOptions) {
		this.graph = graph;
		this.theme = options.theme ?? identityTheme;
		this.onSubmit = options.onSubmit;
		this.onCancel = options.onCancel;
		const seen = new Set<string>();
		for (const g of this.allGroups()) {
			if (seen.has(g.id)) throw new Error(`LayoutRenderer: duplicate group id "${g.id}"`);
			seen.add(g.id);
		}
		this.initializeState();
	}

	invalidate(): void {
		// No cached state to invalidate currently.
	}

	// =======================================================================
	// Test/debug introspection
	// =======================================================================

	/** Current cursor index inside `groupId`, or -1 if unknown. */
	getCursor(groupId: string): number {
		return this.cursorByGroup.get(groupId) ?? -1;
	}

	/** Snapshot of selections in the response envelope shape. */
	snapshotResponse(): LayoutResponse {
		return this.buildResponse();
	}

	/** Index of the currently active tab (0 if root isn't `tabs`). */
	getActiveTabIndex(): number {
		return this.activeTabIndex;
	}

	/** Id of the currently focused interactive group, or null if none. */
	getFocusedGroupId(): string | null {
		return this.focusedGroup()?.id ?? null;
	}

	// =======================================================================
	// Rendering
	// =======================================================================

	render(width: number): string[] {
		const lines: string[] = [];
		const root = this.graph.root;
		if (root.type === "tabs") {
			lines.push(this.renderTabHeader(root.tabs.map((t) => t.header)));
			lines.push("");
			const activeTab = root.tabs[this.activeTabIndex];
			if (activeTab) this.renderNode(activeTab.content, width, lines, 0);
		} else {
			this.renderNode(root, width, lines, 0);
		}
		return lines;
	}

	private renderTabHeader(headers: string[]): string {
		return headers.map((h, i) => (i === this.activeTabIndex ? this.theme.accent(`[ ${h} ]`) : `  ${h}  `)).join(" ");
	}

	private renderNode(node: LayoutNode, width: number, lines: string[], indent: number): void {
		const pad = " ".repeat(indent);
		switch (node.type) {
			case "text":
				lines.push(pad + node.value);
				return;

			case "markdown":
				// MVP: emit lines as-is. Full markdown rendering pending.
				for (const ln of node.value.split("\n")) lines.push(pad + ln);
				return;

			case "card": {
				if (node.title) lines.push(pad + this.theme.accent(node.title));
				for (const child of node.children) {
					this.renderNode(child, width, lines, indent + 2);
				}
				return;
			}

			case "col":
			case "row":
			case "stack": {
				const gap = node.gap ?? 0;
				for (let i = 0; i < node.children.length; i++) {
					if (i > 0) for (let g = 0; g < gap; g++) lines.push("");
					this.renderNode(node.children[i]!, width, lines, indent);
				}
				return;
			}

			case "radio_group": {
				this.renderRadioGroup(node, lines, indent);
				return;
			}

			case "checkbox_group": {
				this.renderCheckboxGroup(node, lines, indent);
				return;
			}

			case "tabs": {
				lines.push(pad + node.tabs.map((t) => t.header).join(" | "));
				for (const tab of node.tabs) {
					lines.push(pad + this.theme.accent(tab.header));
					this.renderNode(tab.content, width, lines, indent + 2);
				}
				return;
			}

			case "divider":
				lines.push(pad + "─".repeat(Math.max(0, width - indent)));
				return;

			// Unimplemented in MVP — render a placeholder so traversal is total.
			case "button":
			case "text_input":
			case "scroll":
			case "image":
				lines.push(pad + this.theme.dim(`[unsupported: ${node.type}]`));
				return;
		}
	}

	private renderRadioGroup(node: Extract<LayoutNode, { type: "radio_group" }>, lines: string[], indent: number): void {
		const pad = " ".repeat(indent);
		const cursor = this.cursorByGroup.get(node.id) ?? 0;
		const selected = this.selectionByGroup.get(node.id)?.[0];
		const isFocused = this.getFocusedGroupId() === node.id;
		for (let i = 0; i < node.options.length; i++) {
			const opt = node.options[i]!;
			const marker = selected === opt.value ? "(•)" : "( )";
			const prefix = isFocused && cursor === i ? this.theme.highlight("→ ") : "  ";
			let line = `${pad + prefix + marker} ${opt.label}`;
			if (opt.description) line += this.theme.dim(`  ${opt.description}`);
			lines.push(line);
		}
	}

	private renderCheckboxGroup(
		node: Extract<LayoutNode, { type: "checkbox_group" }>,
		lines: string[],
		indent: number,
	): void {
		const pad = " ".repeat(indent);
		const cursor = this.cursorByGroup.get(node.id) ?? 0;
		const selected = new Set(this.selectionByGroup.get(node.id) ?? []);
		const isFocused = this.getFocusedGroupId() === node.id;
		for (let i = 0; i < node.options.length; i++) {
			const opt = node.options[i]!;
			const marker = selected.has(opt.value) ? "[x]" : "[ ]";
			const prefix = isFocused && cursor === i ? this.theme.highlight("→ ") : "  ";
			let line = `${pad + prefix + marker} ${opt.label}`;
			if (opt.description) line += this.theme.dim(`  ${opt.description}`);
			lines.push(line);
		}
	}

	// =======================================================================
	// Input
	// =======================================================================

	handleInput(data: string): void {
		// Cancel
		if (matchesKey(data, Key.escape) || data === "\x03") {
			this.onCancel?.();
			return;
		}

		// Submit
		if (matchesKey(data, Key.enter)) {
			this.onSubmit(this.buildResponse());
			return;
		}

		// Tab switching (only valid when root is `tabs`)
		if (this.graph.root.type === "tabs") {
			const tabCount = this.graph.root.tabs.length;
			if (tabCount > 0 && matchesKey(data, Key.left)) {
				this.activeTabIndex = (this.activeTabIndex - 1 + tabCount) % tabCount;
				this.focusedGroupIndex = 0;
				return;
			}
			if (tabCount > 0 && matchesKey(data, Key.right)) {
				this.activeTabIndex = (this.activeTabIndex + 1) % tabCount;
				this.focusedGroupIndex = 0;
				return;
			}
		}

		// Focus cycling
		if (matchesKey(data, Key.tab)) {
			const groups = this.groupsForCurrentTab();
			if (groups.length > 0) {
				this.focusedGroupIndex = (this.focusedGroupIndex + 1) % groups.length;
			}
			return;
		}

		const focused = this.focusedGroup();
		if (!focused) return;

		// Within-group navigation
		if (focused.optionCount === 0) return;

		if (matchesKey(data, Key.up)) {
			const c = this.cursorByGroup.get(focused.id) ?? 0;
			const next = (c - 1 + focused.optionCount) % focused.optionCount;
			this.cursorByGroup.set(focused.id, next);
			if (focused.type === "radio_group") this.selectAtCursor(focused.id);
			return;
		}
		if (matchesKey(data, Key.down)) {
			const c = this.cursorByGroup.get(focused.id) ?? 0;
			const next = (c + 1) % focused.optionCount;
			this.cursorByGroup.set(focused.id, next);
			if (focused.type === "radio_group") this.selectAtCursor(focused.id);
			return;
		}
		if (matchesKey(data, Key.space)) {
			if (focused.type === "checkbox_group") this.toggleAtCursor(focused.id);
			else if (focused.type === "radio_group") this.selectAtCursor(focused.id);
			return;
		}
	}

	// =======================================================================
	// Selection helpers
	// =======================================================================

	private selectAtCursor(groupId: string): void {
		const group = this.findGroup(groupId);
		if (!group) return;
		const cursor = this.cursorByGroup.get(groupId) ?? 0;
		const opt = group.options[cursor];
		if (!opt) return;
		this.selectionByGroup.set(groupId, [opt.value]);
	}

	private toggleAtCursor(groupId: string): void {
		const group = this.findGroup(groupId);
		if (!group) return;
		const cursor = this.cursorByGroup.get(groupId) ?? 0;
		const opt = group.options[cursor];
		if (!opt) return;
		const current = this.selectionByGroup.get(groupId) ?? [];
		const i = current.indexOf(opt.value);
		const next = i >= 0 ? current.filter((v) => v !== opt.value) : [...current, opt.value];
		this.selectionByGroup.set(groupId, next);
	}

	private buildResponse(): LayoutResponse {
		const out: LayoutResponse = {};
		for (const [id, vals] of this.selectionByGroup) {
			const group = this.findGroup(id);
			if (!group) continue;
			if (group.type === "radio_group") {
				out[id] = vals[0];
			} else {
				out[id] = [...vals];
			}
		}
		return out;
	}

	// =======================================================================
	// Group discovery (graph walks)
	// =======================================================================

	private initializeState(): void {
		for (const g of this.allGroups()) {
			const initialCursor = g.initialSelection.length > 0 ? g.optionValues.indexOf(g.initialSelection[0]) : 0;
			this.cursorByGroup.set(g.id, initialCursor);
			// Radio cursor IS selection — without a graph value the first option is
			// selected (matches the "(Recommended)" convention from CC's AskUserQuestion).
			if (g.type === "radio_group" && g.initialSelection.length === 0 && g.optionValues.length > 0) {
				this.selectionByGroup.set(g.id, [g.optionValues[0]]);
			} else {
				this.selectionByGroup.set(g.id, [...g.initialSelection]);
			}
		}
		this.focusedGroupIndex = 0;
	}

	private focusedGroup(): GroupInfo | undefined {
		return this.groupsForCurrentTab()[this.focusedGroupIndex];
	}

	private groupsForCurrentTab(): GroupInfo[] {
		if (this.graph.root.type === "tabs") {
			const tab = this.graph.root.tabs[this.activeTabIndex];
			return tab ? this.groupsIn(tab.content) : [];
		}
		return this.allGroups();
	}

	private allGroups(): GroupInfo[] {
		return this.groupsIn(this.graph.root);
	}

	private groupsIn(node: LayoutNode): GroupInfo[] {
		const out: GroupInfo[] = [];
		const visit = (n: LayoutNode): void => {
			if (n.type === "radio_group" || n.type === "checkbox_group") {
				const optionValues = n.options.map((o) => o.value);
				const requested = n.type === "radio_group" ? (n.value === undefined ? [] : [n.value]) : (n.value ?? []);
				out.push({
					id: n.id,
					type: n.type,
					optionCount: n.options.length,
					optionValues,
					initialSelection: [...new Set(requested.filter((v) => optionValues.includes(v)))],
				});
				return;
			}
			if (n.type === "card" || n.type === "col" || n.type === "row" || n.type === "stack") {
				for (const c of n.children) visit(c);
				return;
			}
			if (n.type === "tabs") {
				for (const t of n.tabs) visit(t.content);
				return;
			}
			if (n.type === "scroll") {
				visit(n.child);
				return;
			}
		};
		visit(node);
		return out;
	}

	private findGroup(id: string): GroupNode | undefined {
		const visit = (n: LayoutNode): GroupNode | undefined => {
			if ((n.type === "radio_group" || n.type === "checkbox_group") && n.id === id) {
				return n;
			}
			if (n.type === "card" || n.type === "col" || n.type === "row" || n.type === "stack") {
				for (const c of n.children) {
					const found = visit(c);
					if (found) return found;
				}
			}
			if (n.type === "tabs") {
				for (const t of n.tabs) {
					const found = visit(t.content);
					if (found) return found;
				}
			}
			if (n.type === "scroll") return visit(n.child);
			return undefined;
		};
		return visit(this.graph.root);
	}
}
