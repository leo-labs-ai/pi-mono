import type { AgentTool } from "@leo-labs-ai/pi-agent-core";
import { type AssistantMessage, fauxAssistantMessage, fauxToolCall } from "@leo-labs-ai/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHarness, getUserTexts, type Harness } from "./harness.ts";

const CONTINUE_INSTRUCTION =
	"This compaction ran automatically in the middle of your turn. The task is not finished. " +
	"Continue it now from this summary and the messages after it; do not stop to report progress.";

function createUsage(totalTokens: number) {
	return {
		input: totalTokens,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

/** Seed a turn that the next compaction splits: with keepRecentTokens 1 the cut lands on the assistant message. */
function seedSplitTurn(
	harness: Harness,
	userText: string,
	assistant: { text: string; stopReason: AssistantMessage["stopReason"]; totalTokens: number },
): void {
	const now = Date.now();
	const model = harness.getModel();
	harness.sessionManager.appendMessage({
		role: "user",
		content: [{ type: "text", text: userText }],
		timestamp: now - 1000,
	});
	harness.sessionManager.appendMessage({
		...fauxAssistantMessage(assistant.text, { stopReason: assistant.stopReason, timestamp: now - 500 }),
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: createUsage(assistant.totalTokens),
	});
	harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
}

function storedSummaries(harness: Harness): string[] {
	return harness.sessionManager.getBranch().flatMap((entry) => (entry.type === "compaction" ? [entry.summary] : []));
}

describe("AgentSession split-turn compaction continue instruction", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		vi.restoreAllMocks();
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("ends the summary with the instruction when threshold compaction splits the running turn", async () => {
		const largeTool: AgentTool = {
			name: "large_result",
			label: "Large result",
			description: "Returns enough content to cross the compaction threshold",
			parameters: Type.Object({}),
			execute: async () => ({
				content: [{ type: "text", text: `large-tool-result:${"x".repeat(16000)}` }],
				details: {},
			}),
		};
		// The tool result (about 4000 tokens) crosses the threshold mid-run and exceeds keepRecentTokens,
		// so the cut lands on the tool call: the turn's prompt is summarized and the result is kept.
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 6700, maxTokens: 100 }],
			settings: { compaction: { enabled: true, reserveTokens: 400, keepRecentTokens: 1750 } },
			tools: [largeTool],
		});
		harnesses.push(harness);
		let resumedRequest = "";
		harness.setResponses([
			fauxAssistantMessage(`old-history:${"a".repeat(6000)}`),
			fauxAssistantMessage(`recent-history:${"b".repeat(6000)}`),
			fauxAssistantMessage(fauxToolCall("large_result", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("## Goal\nSummary of the earlier turns"),
			fauxAssistantMessage("## Original Request\nRun the large tool"),
			(context) => {
				resumedRequest = JSON.stringify(context.messages);
				return fauxAssistantMessage("finished after compaction");
			},
		]);

		await harness.session.prompt("seed old history");
		await harness.session.prompt("seed recent history");
		await harness.session.prompt("run the large tool");

		expect(harness.eventsOfType("compaction_end")).toMatchObject([{ reason: "threshold", willRetry: false }]);
		const [summary] = storedSummaries(harness);
		expect(summary).toContain("**Turn Context (split turn):**");
		expect(summary.endsWith(CONTINUE_INSTRUCTION)).toBe(true);
		expect(resumedRequest).toContain(CONTINUE_INSTRUCTION);
		expect(resumedRequest).toContain("large-tool-result");
		expect(harness.session.getLastAssistantText()).toBe("finished after compaction");
		expect(harness.faux.state.callCount).toBe(6);
	});

	it("keeps the plain summary when automatic compaction follows a completed answer", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 1, maxTokens: 100 }],
			settings: { compaction: { enabled: true, reserveTokens: 0, keepRecentTokens: 1 } },
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("All done. The task is complete."),
			fauxAssistantMessage("## Original Request\nDo the task"),
		]);

		await harness.session.prompt("do the task");

		// The run is over: the compaction splits the finished turn, but nothing resumes it.
		expect(harness.eventsOfType("compaction_end")).toMatchObject([{ reason: "overflow", willRetry: false }]);
		const [summary] = storedSummaries(harness);
		expect(summary).toContain("**Turn Context (split turn):**");
		expect(summary).not.toContain(CONTINUE_INSTRUCTION);
		expect(harness.session.getLastAssistantText()).toBe("All done. The task is complete.");
		expect(harness.faux.state.callCount).toBe(2);
	});

	it("keeps the plain summary when the pre-prompt check compacts before a new prompt", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 100, maxTokens: 100 }],
			settings: { compaction: { enabled: true, reserveTokens: 0, keepRecentTokens: 1 } },
		});
		harnesses.push(harness);
		seedSplitTurn(harness, "previous prompt", { text: "partial answer", stopReason: "length", totalTokens: 100 });
		harness.setResponses([
			fauxAssistantMessage("## Original Request\nThe previous prompt"),
			fauxAssistantMessage("answered next prompt"),
		]);
		const continueSpy = vi.spyOn(harness.session.agent, "continue");

		await harness.session.prompt("next prompt");

		// Overflow recovery reports a retry, but prompt() sends the new prompt instead of resuming.
		expect(harness.eventsOfType("compaction_end")).toMatchObject([{ reason: "overflow", willRetry: true }]);
		expect(continueSpy).not.toHaveBeenCalled();
		const [summary] = storedSummaries(harness);
		expect(summary).toContain("**Turn Context (split turn):**");
		expect(summary).not.toContain(CONTINUE_INSTRUCTION);
		expect(getUserTexts(harness)).toContain("next prompt");
		expect(harness.session.getLastAssistantText()).toBe("answered next prompt");
	});

	it("ends the summary with the instruction when overflow recovery retries the turn", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 1000, maxTokens: 100 }],
			settings: { compaction: { enabled: true, reserveTokens: 0, keepRecentTokens: 1 } },
		});
		harnesses.push(harness);
		let resumedRequest = "";
		harness.setResponses([
			fauxAssistantMessage("partial response", { stopReason: "length" }),
			fauxAssistantMessage("## Original Request\nThe long prompt"),
			(context) => {
				resumedRequest = JSON.stringify(context.messages);
				return fauxAssistantMessage("completed response");
			},
		]);

		await harness.session.prompt("x".repeat(5000));

		expect(harness.eventsOfType("compaction_end")).toMatchObject([{ reason: "overflow", willRetry: true }]);
		const [summary] = storedSummaries(harness);
		expect(summary).toContain("**Turn Context (split turn):**");
		expect(summary.endsWith(CONTINUE_INSTRUCTION)).toBe(true);
		expect(resumedRequest).toContain(CONTINUE_INSTRUCTION);
		expect(harness.session.getLastAssistantText()).toBe("completed response");
		expect(harness.faux.state.callCount).toBe(3);
	});

	it("keeps the plain summary for manual compaction of a split turn", async () => {
		const harness = await createHarness({
			settings: { compaction: { enabled: true, keepRecentTokens: 1 } },
		});
		harnesses.push(harness);
		seedSplitTurn(harness, "do the task", { text: "All done.", stopReason: "stop", totalTokens: 0 });
		harness.setResponses([fauxAssistantMessage("## Original Request\nDo the task")]);

		const result = await harness.session.compact();

		expect(result.summary).toContain("**Turn Context (split turn):**");
		expect(result.summary).not.toContain(CONTINUE_INSTRUCTION);
		expect(storedSummaries(harness)).toEqual([result.summary]);
	});
});
