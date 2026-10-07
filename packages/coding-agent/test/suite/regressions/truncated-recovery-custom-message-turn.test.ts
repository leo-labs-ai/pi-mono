import { type AssistantMessage, fauxAssistantMessage } from "@lue-labs/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../harness.ts";

function seedCompactableSession(harness: Harness): void {
	const model = harness.getModel();
	for (let i = 0; i < 4; i++) {
		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: `old request ${i} ${"x".repeat(400)}` }],
			timestamp: i * 2 + 1,
		});
		const assistant: AssistantMessage = {
			...fauxAssistantMessage(`old answer ${i} ${"y".repeat(400)}`, { timestamp: i * 2 + 2 }),
			api: model.api,
			provider: model.provider,
			model: model.id,
		};
		harness.sessionManager.appendMessage(assistant);
	}
	harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
}

describe("truncated response recovery for custom-message turns", () => {
	let harness: Harness | undefined;

	afterEach(() => {
		harness?.cleanup();
		harness = undefined;
	});

	// A custom message (for example an extension wake-up) that triggers a new turn must get its own
	// compact-and-retry attempt. The one-shot guard from an earlier failed run must not carry over.
	it("attempts compaction again when a custom message turn is truncated after an earlier failed recovery", async () => {
		harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 100_000, maxTokens: 500 }],
			settings: {
				compaction: { enabled: true, reserveTokens: 100, keepRecentTokens: 1 },
				retry: { enabled: false },
			},
		});
		const session = harness.session;
		seedCompactableSession(harness);
		harness.setResponses(
			Array.from(
				{ length: 8 },
				() => () =>
					session.isCompacting
						? fauxAssistantMessage("summary")
						: fauxAssistantMessage("partial", { stopReason: "length" }),
			),
		);

		await session.prompt("first request");
		const failures = () =>
			harness?.eventsOfType("compaction_end").filter((event) => event.errorMessage?.includes("recovery failed")) ??
			[];
		expect(failures()).toHaveLength(1);
		const startsBefore = harness.eventsOfType("compaction_start").length;

		await session.sendCustomMessage({ customType: "wake", content: "wake", display: true }, { triggerTurn: true });

		expect(harness.eventsOfType("compaction_start").length).toBe(startsBefore + 1);
		expect(harness.eventsOfType("compaction_start").at(-1)?.reason).toBe("overflow");
	});
});
