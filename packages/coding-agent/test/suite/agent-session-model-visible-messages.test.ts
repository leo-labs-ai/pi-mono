import { fauxAssistantMessage } from "@leo-labs-ai/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { convertToLlm } from "../../src/core/messages.ts";
import { createHarness, type Harness } from "./harness.ts";

// Fork: UI-only custom messages (modelVisible: false). Re-grafted from leo-labs-ai/pi-mono#528.
describe("AgentSession model-visible custom messages", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		for (const harness of harnesses.splice(0)) {
			harness.cleanup();
		}
	});

	it("keeps UI-only status out of provider requests and appends visible wakes as the final message", async () => {
		const requests: Array<{ systemPrompt?: string; tools?: unknown[]; messages: unknown[] }> = [];
		const serializeRequest = (context: unknown) =>
			JSON.parse(JSON.stringify(context, (_key, value) => (typeof value === "function" ? undefined : value)));
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([
			(context) => {
				requests.push(serializeRequest(context));
				return fauxAssistantMessage("baseline");
			},
			(context) => {
				requests.push(serializeRequest(context));
				return fauxAssistantMessage("output handled");
			},
			(context) => {
				requests.push(serializeRequest(context));
				return fauxAssistantMessage("exit handled");
			},
			(context) => {
				requests.push(serializeRequest(context));
				return fauxAssistantMessage("routine handled");
			},
		]);

		await harness.session.prompt("start");
		await harness.session.sendCustomMessage({
			customType: "monitor-status",
			content: "mon_volatile status running wake 1/20 log /tmp/volatile.log",
			display: true,
			modelVisible: false,
		});
		await harness.session.sendCustomMessage(
			{
				customType: "monitor-event",
				content: "mon_output status running wake 2/20 output changed",
				display: true,
				modelVisible: true,
			},
			{ triggerTurn: true },
		);
		await harness.session.sendCustomMessage(
			{
				customType: "monitor-event",
				content: "mon_exit status exited wake 3/20 output changed",
				display: true,
				modelVisible: true,
			},
			{ triggerTurn: true },
		);
		await harness.session.sendCustomMessage(
			{
				customType: "routine-checkpoint",
				content: "routine_id=checkpoint-1 status=due firedAt=volatile",
				display: true,
				modelVisible: true,
			},
			{ triggerTurn: true },
		);

		expect(requests).toHaveLength(4);
		const staticPrefix = (request: (typeof requests)[number]) =>
			JSON.stringify({ systemPrompt: request.systemPrompt, tools: request.tools });
		expect(staticPrefix(requests[1])).toBe(staticPrefix(requests[2]));
		expect(staticPrefix(requests[2])).toBe(staticPrefix(requests[3]));
		const outputTail = requests[1].messages.at(-1);
		const exitTail = requests[2].messages.at(-1);
		const routineTail = requests[3].messages.at(-1);
		expect(JSON.stringify(outputTail)).toContain("mon_output status running wake 2/20 output changed");
		expect(JSON.stringify(exitTail)).toContain("mon_exit status exited wake 3/20 output changed");
		expect(JSON.stringify(routineTail)).toContain("routine_id=checkpoint-1 status=due firedAt=volatile");
		expect(JSON.stringify(requests[1].messages)).not.toContain("mon_volatile status running wake 1/20");
		expect(JSON.stringify(requests[2].messages)).not.toContain("mon_volatile status running wake 1/20");
		expect(JSON.stringify(requests[3].messages)).not.toContain("mon_volatile status running wake 1/20");

		const statusEntry = harness.sessionManager
			.getEntries()
			.find((entry) => entry.type === "custom_message" && entry.customType === "monitor-status");
		if (!statusEntry || statusEntry.type !== "custom_message")
			throw new Error("missing persisted monitor status entry");
		expect(statusEntry.modelVisible).toBe(false);
		expect(statusEntry.display).toBe(true);
		const rebuiltProviderMessages = convertToLlm(harness.sessionManager.buildSessionContext().messages);
		expect(JSON.stringify(rebuiltProviderMessages)).not.toContain("mon_volatile status running wake 1/20");
	});
});
