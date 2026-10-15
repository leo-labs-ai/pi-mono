import type { AgentMessage, AgentTool } from "@leo-labs-ai/pi-agent-core";
import {
	type AssistantMessage,
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	fauxToolCall,
	getCurrentTools,
	type Model,
	type SimpleStreamOptions,
	type TranscriptContext,
} from "@leo-labs-ai/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { estimateTokens } from "../../src/core/compaction/index.ts";
import { createHarness, getUserTexts, type Harness } from "./harness.ts";

type SessionWithCompactionInternals = {
	_checkCompaction: (assistantMessage: AssistantMessage, skipAbortedCheck?: boolean) => Promise<boolean>;
	_runAutoCompaction: (reason: "overflow" | "threshold", willRetry: boolean) => Promise<boolean>;
};

function deferred() {
	let resolve = () => {};
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

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

function createAssistant(
	harness: Harness,
	options: {
		stopReason?: AssistantMessage["stopReason"];
		errorMessage?: string;
		totalTokens?: number;
		timestamp?: number;
	},
): AssistantMessage {
	const model = harness.getModel();
	return {
		...fauxAssistantMessage("", {
			stopReason: options.stopReason,
			errorMessage: options.errorMessage,
			timestamp: options.timestamp,
		}),
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: createUsage(options.totalTokens ?? 0),
	};
}

function useSummaryStreamFn(
	harness: Harness,
	summary: string,
	onRequest?: (context: TranscriptContext, options: SimpleStreamOptions | undefined) => void,
): () => number {
	let callCount = 0;
	harness.session.agent.streamFunction = (model, context, options) => {
		callCount++;
		onRequest?.(context, options);
		const stream = createAssistantMessageEventStream();
		queueMicrotask(() => {
			const message: AssistantMessage = {
				...fauxAssistantMessage(summary),
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: createUsage(10),
			};
			stream.push({ type: "done", reason: "stop", message });
		});
		return stream;
	};
	return () => callCount;
}

function seedCompactableSession(harness: Harness): void {
	harness.settingsManager.applyOverrides({ compaction: { keepRecentTokens: 1 } });
	const now = Date.now();
	harness.sessionManager.appendMessage({
		role: "user",
		content: [{ type: "text", text: "message to compact" }],
		timestamp: now - 1000,
	});
	const assistant = createAssistant(harness, {
		stopReason: "stop",
		totalTokens: 100,
		timestamp: now - 500,
	});
	assistant.content = [{ type: "text", text: "assistant response to compact" }];
	harness.sessionManager.appendMessage(assistant);
	harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
}

async function createAbortableCompactionHarness(): Promise<{
	harness: Harness;
	compactionStarted: Promise<void>;
}> {
	let markCompactionStarted = () => {};
	const compactionStarted = new Promise<void>((resolve) => {
		markCompactionStarted = resolve;
	});
	const harness = await createHarness({
		settings: { compaction: { keepRecentTokens: 1 } },
		extensionFactories: [
			(pi) => {
				pi.on("session_before_compact", async (event) => {
					return await new Promise<{ cancel: true }>((resolve) => {
						event.signal.addEventListener("abort", () => resolve({ cancel: true }), { once: true });
						markCompactionStarted();
					});
				});
			},
		],
	});
	seedCompactableSession(harness);
	return { harness, compactionStarted };
}

describe("AgentSession compaction characterization", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("conditionally compacts only above a valid threshold with known finite usage", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		seedCompactableSession(harness);
		const calls = useSummaryStreamFn(harness, "conditional summary");
		const signal = new AbortController().signal;
		const usage = vi.spyOn(harness.session, "getContextUsage");
		for (const minTokens of [-1, Number.NaN, Infinity]) {
			await expect(harness.session.compactIfIdle({ minTokens, signal })).rejects.toThrow(RangeError);
		}
		for (const tokens of [null, Number.NaN, Infinity, -Infinity, 99, 100]) {
			usage.mockReturnValue({ tokens, contextWindow: 1000, percent: null });
			await expect(harness.session.compactIfIdle({ minTokens: 100, signal })).resolves.toBeUndefined();
		}
		usage.mockReturnValue(undefined);
		await expect(harness.session.compactIfIdle({ minTokens: 0, signal })).resolves.toBeUndefined();
		usage.mockRestore();
		const tokens = harness.session.getContextUsage()?.tokens;
		expect(tokens).toBe(100);
		await expect(harness.session.compactIfIdle({ minTokens: 99, signal })).resolves.toMatchObject({
			summary: expect.stringContaining("conditional summary"),
		});
		expect(calls()).toBe(1);
		// Usage stays unknown after compaction; stale provider usage must not trigger another summary.
		await expect(harness.session.compactIfIdle({ minTokens: 0, signal })).resolves.toBeUndefined();
	});

	it("reserves synchronously, rejects competing runs, and cancels only its own operation", async () => {
		const { harness, compactionStarted } = await createAbortableCompactionHarness();
		harnesses.push(harness);
		const abort = vi.spyOn(harness.session, "abort");
		const abortCompaction = vi.spyOn(harness.session, "abortCompaction");
		const agentAbort = vi.spyOn(harness.session.agent, "abort");
		const controller = new AbortController();
		const removeListener = vi.spyOn(controller.signal, "removeEventListener");
		const alreadyAborted = new AbortController();
		alreadyAborted.abort();
		await expect(
			harness.session.compactIfIdle({ minTokens: 0, signal: alreadyAborted.signal }),
		).resolves.toBeUndefined();
		const pending = harness.session.extensionRunner
			.createContext()
			.compactIfIdle({ minTokens: 0, signal: controller.signal });
		const rejected = expect(pending).rejects.toThrow("Compaction cancelled");
		expect(harness.session.isCompacting).toBe(true);
		await expect(
			harness.session.compactIfIdle({ minTokens: 0, signal: new AbortController().signal }),
		).resolves.toBeUndefined();
		await compactionStarted;
		await expect(harness.session.prompt("competing prompt")).rejects.toThrow("compaction");
		await expect(
			harness.session.sendCustomMessage(
				{ customType: "wake", content: "wake", display: false },
				{ triggerTurn: true },
			),
		).rejects.toThrow("compaction");
		controller.abort();
		await rejected;
		expect(abort).not.toHaveBeenCalled();
		expect(abortCompaction).not.toHaveBeenCalled();
		expect(agentAbort).not.toHaveBeenCalled();
		expect(removeListener).toHaveBeenCalledWith("abort", expect.any(Function));
		expect(harness.sessionManager.getEntries().some((entry) => entry.type === "compaction")).toBe(false);
		const ctx = harness.session.extensionRunner.createContext();
		harness.session.extensionRunner.invalidate();
		expect(() => ctx.compactIfIdle({ minTokens: 0, signal: controller.signal })).toThrow("stale");
	});

	it.each(["prompt", "steer", "followUp", "command"] as const)(
		"rejects admission during %s asynchronous preflight and releases handled admissions",
		async (method) => {
			const entered = deferred();
			const release = deferred();
			const harness = await createHarness({
				extensionFactories: [
					(pi) => {
						pi.on("input", async () => {
							entered.resolve();
							await release.promise;
							return { action: "handled" };
						});
						pi.registerCommand("hold", {
							handler: async () => {
								entered.resolve();
								await release.promise;
							},
						});
					},
				],
			});
			harnesses.push(harness);
			seedCompactableSession(harness);
			useSummaryStreamFn(harness, "after preflight");
			const input = method === "command" ? harness.session.prompt("/hold") : harness.session[method]("held");
			await entered.promise;
			await expect(
				harness.session.compactIfIdle({ minTokens: 0, signal: new AbortController().signal }),
			).resolves.toBeUndefined();
			release.resolve();
			await input;
			await expect(
				harness.session.compactIfIdle({ minTokens: 0, signal: new AbortController().signal }),
			).resolves.toBeDefined();
		},
	);

	it.each(["session", "agent", "nextTurn"] as const)("rejects admission with %s queued work", async (queue) => {
		const harness = await createHarness();
		harnesses.push(harness);
		seedCompactableSession(harness);
		if (queue === "session") {
			await harness.session.steer("queued");
			harness.session.agent.clearAllQueues();
		} else if (queue === "agent") {
			harness.session.agent.followUp({ role: "user", content: "queued", timestamp: Date.now() });
		} else {
			await harness.session.sendCustomMessage(
				{ customType: "aside", content: "queued", display: false },
				{ deliverAs: "nextTurn" },
			);
		}
		await expect(
			harness.session.compactIfIdle({ minTokens: 0, signal: new AbortController().signal }),
		).resolves.toBeUndefined();
		expect(harness.eventsOfType("compaction_start")).toHaveLength(0);
	});

	it("rejects admission during branch navigation without cancelling it", async () => {
		const entered = deferred();
		const release = deferred();
		let branchSignal: AbortSignal | undefined;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("session_before_tree", async (event) => {
						branchSignal = event.signal;
						entered.resolve();
						await release.promise;
						return { cancel: true };
					});
				},
			],
		});
		harnesses.push(harness);
		seedCompactableSession(harness);
		const target = harness.sessionManager.getBranch()[0]!.id;
		const navigation = harness.session.navigateTree(target);
		await entered.promise;
		await expect(
			harness.session.compactIfIdle({ minTokens: 0, signal: new AbortController().signal }),
		).resolves.toBeUndefined();
		expect(branchSignal?.aborted).toBe(false);
		release.resolve();
		await navigation;
	});

	it("checks cancellation before hooks and rejects admitted generation failures", async () => {
		const hook = vi.fn();
		const failed = vi.fn();
		const harness = await createHarness({
			settings: { retry: { enabled: false } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", hook);
					pi.on("session_compact_failed", failed);
				},
			],
		});
		harnesses.push(harness);
		seedCompactableSession(harness);
		const controller = new AbortController();
		const unsubscribe = harness.session.subscribe((event) => {
			if (event.type === "compaction_start") controller.abort();
		});
		await expect(harness.session.compactIfIdle({ minTokens: 0, signal: controller.signal })).rejects.toThrow();
		expect(hook).not.toHaveBeenCalled();
		unsubscribe();
		harness.session.agent.streamFunction = () => {
			throw new Error("summary failed");
		};
		await expect(
			harness.session.compactIfIdle({ minTokens: 0, signal: new AbortController().signal }),
		).rejects.toThrow("summary failed");
		expect(failed).toHaveBeenLastCalledWith(
			expect.objectContaining({ reason: "manual", aborted: false }),
			expect.anything(),
		);
		expect(harness.session.isCompacting).toBe(false);
	});

	it("does not append a cancelled hook result or let its old finalizer clear a successor", async () => {
		const firstGate = deferred();
		const secondEntered = deferred();
		const secondGate = deferred();
		let hookCalls = 0;
		const signals: AbortSignal[] = [];
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => {
						signals.push(event.signal);
						if (++hookCalls === 1) await firstGate.promise;
						else {
							secondEntered.resolve();
							await secondGate.promise;
						}
						return {
							compaction: {
								summary: "hook summary",
								firstKeptEntryId: event.preparation.firstKeptEntryId,
								tokensBefore: event.preparation.tokensBefore,
							},
						};
					});
				},
			],
		});
		harnesses.push(harness);
		seedCompactableSession(harness);
		const firstController = new AbortController();
		const secondController = new AbortController();
		let successor: ReturnType<typeof harness.session.compactIfIdle> | undefined;
		harness.session.subscribe((event) => {
			if (event.type === "compaction_end" && event.aborted) {
				successor = harness.session.compactIfIdle({ minTokens: 0, signal: secondController.signal });
			}
		});
		const first = harness.session.compactIfIdle({ minTokens: 0, signal: firstController.signal });
		const rejected = expect(first).rejects.toThrow();
		firstController.abort();
		firstGate.resolve();
		await rejected;
		await secondEntered.promise;
		expect(harness.session.isCompacting).toBe(true);
		expect(signals[1]?.aborted).toBe(false);
		expect(harness.sessionManager.getEntries().some((entry) => entry.type === "compaction")).toBe(false);
		secondGate.resolve();
		await expect(successor).resolves.toMatchObject({ summary: "hook summary" });
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(1);
	});

	it("rejects admission during active runs and settlement, including deferred custom starts", async () => {
		const outcomes: unknown[] = [];
		let deferredWake = false;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("agent_start", async (_event, ctx) => {
						outcomes.push(await ctx.compactIfIdle({ minTokens: 0, signal: new AbortController().signal }));
					});
					pi.on("agent_before_settle", async (_event, ctx) => {
						outcomes.push(await ctx.compactIfIdle({ minTokens: 0, signal: new AbortController().signal }));
					});
					pi.on("agent_settled", async (_event, ctx) => {
						if (!deferredWake) {
							deferredWake = true;
							pi.sendMessage({ customType: "wake", content: "wake", display: false }, { triggerTurn: true });
						}
						outcomes.push(await ctx.compactIfIdle({ minTokens: 0, signal: new AbortController().signal }));
					});
				},
			],
		});
		harnesses.push(harness);
		seedCompactableSession(harness);
		harness.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("wake response")]);
		await harness.session.prompt("run");
		expect(outcomes).toEqual(Array(6).fill(undefined));
		expect(harness.session.getLastAssistantText()).toBe("wake response");
		expect(harness.eventsOfType("compaction_start")).toHaveLength(0);
	});

	it("manually compacts using an extension-provided summary", async () => {
		const summaryUsage = {
			input: 10,
			output: 20,
			cacheRead: 30,
			cacheWrite: 40,
			totalTokens: 100,
			cost: { input: 0.1, output: 0.2, cacheRead: 0.3, cacheWrite: 0.4, total: 1 },
		};
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => ({
						compaction: {
							summary: "summary from extension",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							usage: summaryUsage,
							details: { source: "extension" },
						},
					}));
				},
			],
		});
		harnesses.push(harness);

		await harness.session.prompt("one");
		await harness.session.prompt("two");
		const statsBefore = harness.session.getSessionStats();

		const result = await harness.session.compact();
		const compactionEntries = harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction");
		const estimatedTokensAfter = harness.session.messages.reduce((sum, message) => sum + estimateTokens(message), 0);

		expect(result.summary).toBe("summary from extension");
		expect(result.usage).toEqual(summaryUsage);
		expect(result.estimatedTokensAfter).toBe(estimatedTokensAfter);
		expect(compactionEntries).toHaveLength(1);
		const compactionEntry = compactionEntries[0];
		if (compactionEntry?.type === "compaction") {
			expect(compactionEntry.usage).toEqual(summaryUsage);
		}
		const statsAfter = harness.session.getSessionStats();
		expect(statsAfter.tokens.input).toBe(statsBefore.tokens.input + summaryUsage.input);
		expect(statsAfter.tokens.output).toBe(statsBefore.tokens.output + summaryUsage.output);
		expect(statsAfter.tokens.cacheRead).toBe(statsBefore.tokens.cacheRead + summaryUsage.cacheRead);
		expect(statsAfter.tokens.cacheWrite).toBe(statsBefore.tokens.cacheWrite + summaryUsage.cacheWrite);
		expect(statsAfter.cost).toBe(statsBefore.cost + summaryUsage.cost.total);
		expect(harness.session.messages[0]?.role).toBe("system");
		expect(harness.session.messages[1]?.role).toBe("compactionSummary");
	});

	it("checkpoints ordered system patches with a consolidated legacy fallback and correct removals", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("declared")]);
		await harness.session.prompt("declare the prompt");
		const declared = harness.session.messages[0];
		if (declared?.role !== "system") throw new Error("expected declared system message");

		harness.sessionManager.appendMessage({
			role: "system",
			content: "summarized instruction",
			sections: { early: "<early>1</early>" },
			toolsRemoved: [{ name: "bash" }],
			timestamp: Date.now(),
		});
		const firstKeptEntryId = harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "kept before patch" }],
			timestamp: Date.now(),
		});
		harness.sessionManager.appendMessage({
			role: "system",
			content: "retained instruction",
			sections: { extra: "<extra>late</extra>" },
			toolsRemoved: [{ name: "read" }],
			timestamp: Date.now(),
		});
		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "kept after patch" }],
			timestamp: Date.now(),
		});
		harness.sessionManager.appendCompaction("compacted", firstKeptEntryId, 100);

		const messages = harness.sessionManager.buildSessionContext().messages;
		expect(messages.map((message) => message.role)).toEqual([
			"system",
			"system",
			"system",
			"compactionSummary",
			"user",
			"user",
		]);
		expect(messages[0]).toEqual(declared);
		expect(messages[1]).toMatchObject({
			role: "system",
			content: "summarized instruction",
			sections: { early: "<early>1</early>" },
			toolsRemoved: [{ name: "bash" }],
		});
		expect(messages[2]).toMatchObject({
			role: "system",
			content: "retained instruction",
			sections: { extra: "<extra>late</extra>" },
			toolsRemoved: [{ name: "read" }],
		});
		expect(messages.slice(4).map((message) => ("content" in message ? message.content : undefined))).toEqual([
			[{ type: "text", text: "kept before patch" }],
			[{ type: "text", text: "kept after patch" }],
		]);
		const entry = harness.sessionManager.getLeafEntry();
		if (entry?.type !== "compaction") throw new Error("expected compaction entry");
		expect(entry.systemMessageHistory).toEqual(messages.slice(0, 3));
		const checkpoint = entry.systemMessage;
		if (!checkpoint) throw new Error("expected consolidated legacy checkpoint");
		expect(checkpoint.content).toBe("summarized instruction\n\nretained instruction");
		expect(checkpoint.sections).toEqual({
			...declared.sections,
			early: "<early>1</early>",
			extra: "<extra>late</extra>",
		});
		const expectedTools = harness.session.getActiveToolNames().filter((name) => name !== "read" && name !== "bash");
		expect(checkpoint.toolsAdded?.map((tool) => tool.name)).toEqual(expectedTools);
		expect(getCurrentTools(messages).map((tool) => tool.name)).toEqual(expectedTools);

		// Simulate a stored legacy checkpoint without the optional declaration history.
		const history = entry.systemMessageHistory;
		delete entry.systemMessageHistory;
		try {
			const legacy = harness.sessionManager.buildSessionContext().messages;
			expect(legacy.map((message) => message.role)).toEqual(["system", "compactionSummary", "user", "user"]);
			expect(legacy[0]).toEqual(checkpoint);
			expect(legacy.slice(1)).toEqual(messages.slice(3));
			expect(getCurrentTools(legacy).map((tool) => tool.name)).toEqual(expectedTools);
		} finally {
			entry.systemMessageHistory = history;
		}
	});

	it.each(["manual", "conditional"])("allows a queued prompt to start when %s compaction ends", async (mode) => {
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => ({
						compaction: {
							summary: "manual compacted",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: {},
						},
					}));
				},
			],
		});
		harnesses.push(harness);
		seedCompactableSession(harness);
		harness.setResponses([fauxAssistantMessage("queued response")]);

		let queuedPrompt: Promise<void> | undefined;
		harness.session.subscribe((event) => {
			if (event.type === "compaction_end" && event.reason === "manual" && event.result) {
				expect(harness.session.isCompacting).toBe(false);
				queuedPrompt = harness.session.prompt("queued after compaction");
			}
		});

		if (mode === "manual") await harness.session.compact();
		else await harness.session.compactIfIdle({ minTokens: 0, signal: new AbortController().signal });
		if (!queuedPrompt) throw new Error("compaction_end did not start the queued prompt");
		await queuedPrompt;

		expect(getUserTexts(harness)).toContain("queued after compaction");
		expect(harness.session.getLastAssistantText()).toBe("queued response");
	});

	it("throws when compacting without a model", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.session.agent.state.model = undefined as unknown as Model<any>;

		await expect(harness.session.compact()).rejects.toThrow("No model selected");
	});

	it("throws when compacting without configured auth", async () => {
		const harness = await createHarness({ withConfiguredAuth: false });
		harnesses.push(harness);
		// Auth is resolved only when Pi summarizes itself, after checking there is something to compact.
		seedCompactableSession(harness);

		await expect(harness.session.compact()).rejects.toThrow(`No API key found for ${harness.getModel().provider}.`);
	});

	it("manually compacts with a custom streamFn when registry auth is absent", async () => {
		const harness = await createHarness({ withConfiguredAuth: false });
		harnesses.push(harness);
		seedCompactableSession(harness);
		const getStreamCallCount = useSummaryStreamFn(harness, "summary from custom stream");

		const result = await harness.session.compact();

		expect(result.summary).toContain("summary from custom stream");
		expect(getStreamCallCount()).toBe(1);
	});

	it("manually compacts with provider-resolved bearer auth", async () => {
		const harness = await createHarness({ withConfiguredAuth: false });
		harnesses.push(harness);
		const model = harness.getModel();
		harness.session.modelRuntime.registerNativeProvider({
			id: model.provider,
			name: "Faux bearer provider",
			auth: {
				apiKey: {
					name: "Faux bearer token",
					resolve: async () => ({
						auth: { headers: { Authorization: "Bearer ambient-token" } },
						source: "ambient bearer token",
					}),
				},
			},
			getModels: () => harness.models,
			stream: () => createAssistantMessageEventStream(),
			streamSimple: () => createAssistantMessageEventStream(),
		});
		seedCompactableSession(harness);
		const summaryResponse = (_context: TranscriptContext, options: SimpleStreamOptions | undefined) => {
			expect(options?.apiKey).toBeUndefined();
			expect(options?.headers).toEqual({ Authorization: "Bearer ambient-token" });
			return fauxAssistantMessage("summary with bearer auth");
		};
		harness.setResponses([summaryResponse]);

		const result = await harness.session.compact();

		expect(result.summary).toContain("summary with bearer auth");
		expect(harness.faux.state.callCount).toBe(1);
	});

	it("keeps the session's thinking level for compaction summaries, with no reserve-based output cap", async () => {
		// Summaries used to force thinking "off" because thinking could use up the
		// 0.8 × reserveTokens output cap and fail compaction with a length stop. The cap is gone
		// (pi-ai applies the model limit, clamped to the context window), so the summary keeps the
		// session's level and the same thinking settings as the turn that wrote the cached prefix.
		const harness = await createHarness({
			models: [{ id: "faux-reasoning", reasoning: true }],
			settings: { compaction: { keepRecentTokens: 1 } },
		});
		harnesses.push(harness);
		seedCompactableSession(harness);
		harness.session.setThinkingLevel("high");
		expect(harness.session.thinkingLevel).toBe("high");

		const requestOptions: Array<SimpleStreamOptions | undefined> = [];
		useSummaryStreamFn(harness, "summary with reasoning", (_context, options) => {
			requestOptions.push(options);
		});

		await harness.session.compact();

		expect(requestOptions.length).toBeGreaterThan(0);
		for (const options of requestOptions) {
			expect(options?.reasoning).toBe("high");
			expect(options?.maxTokens).toBeUndefined();
		}
	});

	it("uses the cache-safe compaction request context without the active agent transport", async () => {
		const harness = await createHarness({ settings: { compaction: { keepRecentTokens: 1 } } });
		harnesses.push(harness);
		seedCompactableSession(harness);

		// The live request runs the agent's transformContext before convertToLlm, so the summary
		// request must too: a projection that hides tool declarations or rewrites a message
		// changes the replayed bytes, and a prefix that differs from the live one is cached nowhere.
		const transformContext = vi.fn(async (messages: AgentMessage[]) =>
			messages.map((message) =>
				message.role === "user"
					? { ...message, content: [{ type: "text" as const, text: "PROJECTED message to compact" }] }
					: message,
			),
		);
		harness.session.agent.transformContext = transformContext;
		harness.session.agent.sessionId = "active-routing-session";
		harness.session.agent.transport = "websocket";
		const liveMessages = await harness.session.agent.convertToLlm(
			await transformContext(harness.session.agent.state.messages),
		);

		let requestContext: TranscriptContext | undefined;
		let requestOptions: SimpleStreamOptions | undefined;
		useSummaryStreamFn(harness, "cache-safe summary", (context, options) => {
			requestContext = context;
			requestOptions = options;
		});

		await harness.session.compact();

		// Fork: the summary request replays the live transcript verbatim (system message, tool
		// declarations, conversation) and appends only the summary instruction. That prefix is
		// already cached by the main loop, so the request keeps caching on to read it and keeps the
		// live routing session so it lands on the node holding it. Asserting "none" here would
		// assert the bug: build a cache-reusable prefix, then forbid the reuse and cold-write it.
		expect(transformContext).toHaveBeenCalledTimes(2);
		expect(requestContext?.messages.slice(0, liveMessages.length)).toEqual(liveMessages);
		expect(requestContext?.messages).toHaveLength(liveMessages.length + 1);
		expect(JSON.stringify(requestContext?.messages)).toContain("PROJECTED message to compact");
		expect(getCurrentTools(requestContext?.messages ?? [])).toEqual(getCurrentTools(liveMessages));
		// The split-turn prefix is already in the replayed messages; the request must not
		// re-serialize it as a text blob after the cached prefix (see generateTurnPrefixSummary).
		const summaryAsk = JSON.stringify(requestContext?.messages.at(-1));
		expect(summaryAsk).toContain("active session context");
		expect(summaryAsk).toContain("<boundary>");
		expect(summaryAsk).not.toContain("# Conversation");
		expect(summaryAsk).not.toContain("[User]:");
		expect(requestOptions?.cacheRetention).not.toBe("none");
		expect(requestOptions?.sessionId).toBe("active-routing-session");
		expect(requestOptions?.transport).toBeUndefined();
	});

	it("persists usage from pi-generated manual compaction", async () => {
		const harness = await createHarness({ withConfiguredAuth: false });
		harnesses.push(harness);
		seedCompactableSession(harness);
		useSummaryStreamFn(harness, "summary from custom stream");

		const result = await harness.session.compact();

		const compactionEntries = harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction");
		expect(result.usage).toEqual(createUsage(10));
		expect(compactionEntries).toHaveLength(1);
		expect(compactionEntries[0]?.type === "compaction" ? compactionEntries[0].usage : undefined).toEqual(
			createUsage(10),
		);
	});

	it("auto-compacts with a custom streamFn when registry auth is absent", async () => {
		const harness = await createHarness({ withConfiguredAuth: false });
		harnesses.push(harness);
		seedCompactableSession(harness);
		const getStreamCallCount = useSummaryStreamFn(harness, "auto summary from custom stream");
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;

		await sessionInternals._runAutoCompaction("threshold", false);

		const compactionEntries = harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction");
		const compactionEnd = harness.eventsOfType("compaction_end").at(-1);
		expect(compactionEntries).toHaveLength(1);
		expect(compactionEnd?.result?.estimatedTokensAfter).toBeGreaterThan(0);
		expect(getStreamCallCount()).toBe(1);
	});

	it("notifies extensions when auto-compaction fails", async () => {
		const failedEvents: Array<{
			reason: "manual" | "threshold" | "overflow";
			errorMessage?: string;
			aborted: boolean;
			willRetry: boolean;
			fromExtension: boolean;
		}> = [];
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("session_compact_failed", async (event) => {
						failedEvents.push(event);
					});
				},
			],
		});
		harnesses.push(harness);
		seedCompactableSession(harness);
		harness.session.agent.streamFunction = () => {
			throw new Error("summary generator blew up");
		};
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;

		await expect(sessionInternals._runAutoCompaction("threshold", false)).resolves.toBe(false);

		expect(harness.eventsOfType("compaction_end").at(-1)).toMatchObject({
			reason: "threshold",
			aborted: false,
			willRetry: false,
			errorMessage: "Auto-compaction failed: summary generator blew up",
		});
		expect(failedEvents).toEqual([
			expect.objectContaining({
				type: "session_compact_failed",
				reason: "threshold",
				aborted: false,
				willRetry: false,
				fromExtension: false,
				errorMessage: "Auto-compaction failed: summary generator blew up",
			}),
		]);
	});

	it("compacts and resumes after a length stop below the desired output limit", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 1000, maxTokens: 100 }],
			settings: { compaction: { keepRecentTokens: 1, reserveTokens: 0 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => ({
						compaction: {
							summary: "overflow compacted",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: {},
						},
					}));
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("partial response", { stopReason: "length" }),
			fauxAssistantMessage("completed response"),
		]);

		await harness.session.prompt("x".repeat(5000));

		expect(harness.faux.state.callCount).toBe(2);
		expect(harness.eventsOfType("compaction_end").at(-1)).toMatchObject({
			reason: "overflow",
			aborted: false,
			willRetry: true,
		});
		expect(harness.session.getLastAssistantText()).toBe("completed response");
	});

	// Regression coverage for #8133: model overrides must also apply between assistant turns.
	// Regression coverage for #9740: an oversized trailing tool result must still produce a cut point.
	it.each([false, true])(
		"compacts after an oversized tool result in the same run (model override: %s)",
		async (modelOverride) => {
			const toolResult = `large-tool-result:${"x".repeat(8000)}`;
			const largeTool: AgentTool = {
				name: "large_result",
				label: "Large result",
				description: "Returns enough content to cross the compaction threshold",
				parameters: Type.Object({}),
				execute: async () => ({ content: [{ type: "text", text: toolResult }], details: {} }),
			};
			const order: string[] = [];
			const observedSettings: unknown[] = [];
			const harness = await createHarness({
				models: [{ id: "faux-1", contextWindow: 2600, maxTokens: 100 }],
				settings: {
					compaction: modelOverride
						? {
								enabled: true,
								reserveTokens: 0,
								keepRecentTokens: 20000,
								modelOverrides: { "faux/faux-1": { reserveTokens: 400, keepRecentTokens: 1750 } },
							}
						: { enabled: true, reserveTokens: 400, keepRecentTokens: 1750 },
				},
				tools: [largeTool],
				extensionFactories: [
					(pi) => {
						pi.on("session_before_compact", (event) => {
							order.push("compaction");
							observedSettings.push(event.preparation.settings);
							return {
								compaction: {
									summary: "compacted history",
									firstKeptEntryId: event.preparation.firstKeptEntryId,
									tokensBefore: event.preparation.tokensBefore,
									details: {},
								},
							};
						});
					},
				],
			});
			harnesses.push(harness);
			let resumedRequest = "";
			harness.setResponses([
				fauxAssistantMessage(`old-history:${"a".repeat(800)}`),
				fauxAssistantMessage(`recent-history:${"b".repeat(800)}`),
				fauxAssistantMessage(fauxToolCall("large_result", {}), { stopReason: "toolUse" }),
				(context) => {
					order.push("provider");
					resumedRequest = JSON.stringify(context.messages);
					return fauxAssistantMessage("finished after compaction");
				},
			]);

			await harness.session.prompt("seed old history");
			await harness.session.prompt("seed recent history");
			const agentStartsBefore = harness.eventsOfType("agent_start").length;
			await harness.session.prompt("run the large tool");

			expect(order.slice(0, 2)).toEqual(["compaction", "provider"]);
			expect(observedSettings[0]).toEqual({ enabled: true, reserveTokens: 400, keepRecentTokens: 1750 });
			expect(harness.eventsOfType("agent_start")).toHaveLength(agentStartsBefore + 1);
			expect(harness.eventsOfType("compaction_start").at(-1)).toEqual({
				type: "compaction_start",
				reason: "threshold",
			});
			expect(resumedRequest).toContain("compacted history");
			expect(resumedRequest).toContain("large-tool-result");
			expect(harness.session.getLastAssistantText()).toBe("finished after compaction");
		},
	);

	it("includes steering queued during compaction in the resumed assistant request", async () => {
		const largeTool: AgentTool = {
			name: "large_result",
			label: "Large result",
			description: "Returns enough content to cross the compaction threshold",
			parameters: Type.Object({}),
			execute: async () => ({
				content: [{ type: "text", text: `large-tool-result:${"x".repeat(6800)}` }],
				details: {},
			}),
		};
		let markCompactionStarted = () => {};
		const compactionStarted = new Promise<void>((resolve) => {
			markCompactionStarted = resolve;
		});
		let releaseCompaction = () => {};
		const compactionReleased = new Promise<void>((resolve) => {
			releaseCompaction = resolve;
		});
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 2600, maxTokens: 100 }],
			settings: { compaction: { enabled: true, reserveTokens: 400, keepRecentTokens: 1750 } },
			tools: [largeTool],
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => {
						markCompactionStarted();
						await compactionReleased;
						return {
							compaction: {
								summary: "compacted history",
								firstKeptEntryId: event.preparation.firstKeptEntryId,
								tokensBefore: event.preparation.tokensBefore,
								details: {},
							},
						};
					});
				},
			],
		});
		harnesses.push(harness);
		let resumedRequest = "";
		harness.setResponses([
			fauxAssistantMessage(`old-history:${"a".repeat(800)}`),
			fauxAssistantMessage(`recent-history:${"b".repeat(800)}`),
			fauxAssistantMessage(fauxToolCall("large_result", {}), { stopReason: "toolUse" }),
			(context) => {
				resumedRequest = JSON.stringify(context.messages);
				return fauxAssistantMessage("finished after compaction");
			},
			fauxAssistantMessage("finished after delayed steering"),
		]);

		await harness.session.prompt("seed old history");
		await harness.session.prompt("seed recent history");
		const promptPromise = harness.session.prompt("run the large tool");
		await compactionStarted;
		await harness.session.steer("change direction");
		releaseCompaction();
		await promptPromise;

		expect(resumedRequest).toContain("change direction");
		expect(harness.faux.state.callCount).toBe(4);
	});

	it("does not compact after a terminating tool result", async () => {
		const terminatingTool: AgentTool = {
			name: "terminate_with_large_result",
			label: "Terminate with large result",
			description: "Returns enough content to cross the compaction threshold, then terminates",
			parameters: Type.Object({}),
			execute: async () => ({
				content: [{ type: "text", text: `large-tool-result:${"x".repeat(6800)}` }],
				details: {},
				terminate: true,
			}),
		};
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 2600, maxTokens: 100 }],
			settings: { compaction: { enabled: true, reserveTokens: 400, keepRecentTokens: 1750 } },
			tools: [terminatingTool],
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", (event) => ({
						compaction: {
							summary: "unexpected compaction",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: {},
						},
					}));
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(`old-history:${"a".repeat(800)}`),
			fauxAssistantMessage(`recent-history:${"b".repeat(800)}`),
			fauxAssistantMessage(fauxToolCall("terminate_with_large_result", {}), { stopReason: "toolUse" }),
		]);

		await harness.session.prompt("seed old history");
		await harness.session.prompt("seed recent history");
		await harness.session.prompt("run the terminating tool");

		expect(harness.eventsOfType("compaction_start")).toEqual([]);
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toEqual([]);
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("does not compact when a length stop reaches the desired output limit", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 1_000_000, maxTokens: 100 }],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("x".repeat(400), { stopReason: "length" })]);

		await harness.session.prompt("hello");

		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.eventsOfType("compaction_start")).toHaveLength(0);
	});

	it("stops after one compact-and-retry when a second response is also truncated", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 1_000_000, maxTokens: 100 }],
			settings: { compaction: { keepRecentTokens: 1, reserveTokens: 0 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => ({
						compaction: {
							summary: "overflow compacted",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: {},
						},
					}));
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			() => fauxAssistantMessage("x".repeat(64), { stopReason: "length", timestamp: Date.now() + 10_000 }),
			() => fauxAssistantMessage("y".repeat(64), { stopReason: "length", timestamp: Date.now() + 10_000 }),
		]);

		await harness.session.prompt("x".repeat(5000));

		expect(harness.faux.state.callCount).toBe(2);
		expect(harness.eventsOfType("compaction_start").filter((event) => event.reason === "overflow")).toHaveLength(1);
		expect(harness.eventsOfType("compaction_end").at(-1)?.errorMessage).toBe(
			"Truncated response recovery failed after one compact-and-retry attempt.",
		);
	});

	it("keeps overflow wording when a repeated length stop fills the context window", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 100, maxTokens: 100 }],
		});
		harnesses.push(harness);
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;
		const lengthOverflowMessage = createAssistant(harness, {
			stopReason: "length",
			totalTokens: 100,
			timestamp: Date.now(),
		});
		const runAutoCompactionSpy = vi.spyOn(sessionInternals, "_runAutoCompaction").mockResolvedValue(false);
		const compactionErrors: string[] = [];
		harness.session.subscribe((event) => {
			if (event.type === "compaction_end" && event.errorMessage) {
				compactionErrors.push(event.errorMessage);
			}
		});

		await sessionInternals._checkCompaction(lengthOverflowMessage);
		await sessionInternals._checkCompaction({ ...lengthOverflowMessage, timestamp: Date.now() + 1 });

		expect(runAutoCompactionSpy).toHaveBeenCalledTimes(1);
		expect(compactionErrors).toContain(
			"Context overflow recovery failed after one compact-and-retry attempt. Try reducing context or switching to a larger-context model.",
		);
	});

	it("cancels in-progress manual compaction when abortCompaction is called", async () => {
		const { harness, compactionStarted } = await createAbortableCompactionHarness();
		harnesses.push(harness);

		const compactPromise = harness.session.compact();
		const compactExpectation = expect(compactPromise).rejects.toThrow("Compaction cancelled");
		await compactionStarted;
		harness.session.abortCompaction();

		await compactExpectation;
	});

	// Regression test for #8920.
	it("aborts an in-progress manual compaction and waits until the session is idle", async () => {
		const { harness, compactionStarted } = await createAbortableCompactionHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("continued")]);

		const compactPromise = harness.session.compact();
		const compactExpectation = expect(compactPromise).rejects.toThrow("Compaction cancelled");
		await compactionStarted;
		await harness.session.abort();
		await compactExpectation;

		expect(harness.eventsOfType("compaction_end").at(-1)).toMatchObject({
			reason: "manual",
			aborted: true,
		});
		expect(harness.session.isCompacting).toBe(false);
		expect(harness.session.isIdle).toBe(true);

		await expect(harness.session.prompt("next prompt")).resolves.toBeUndefined();
		expect(harness.session.getLastAssistantText()).toBe("continued");
	});

	it("resumes after threshold compaction when only agent-level queued messages exist", async () => {
		vi.useFakeTimers();
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => ({
						compaction: {
							summary: "auto compacted",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: {},
						},
					}));
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
		await harness.session.prompt("first");
		await harness.session.prompt("second");

		harness.session.agent.followUp({
			role: "custom",
			customType: "test",
			content: [{ type: "text", text: "queued custom" }],
			display: false,
			timestamp: Date.now(),
		});

		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;

		await expect(sessionInternals._runAutoCompaction("threshold", false)).resolves.toBe(true);
	});

	it("does not retry overflow recovery more than once", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;
		const overflowMessage = createAssistant(harness, {
			stopReason: "error",
			errorMessage: "prompt is too long",
			timestamp: Date.now(),
		});
		const runAutoCompactionSpy = vi.spyOn(sessionInternals, "_runAutoCompaction").mockResolvedValue(false);
		const compactionErrors: string[] = [];
		harness.session.subscribe((event) => {
			if (event.type === "compaction_end" && event.errorMessage) {
				compactionErrors.push(event.errorMessage);
			}
		});

		await sessionInternals._checkCompaction(overflowMessage);
		await sessionInternals._checkCompaction({ ...overflowMessage, timestamp: Date.now() + 1 });

		expect(runAutoCompactionSpy).toHaveBeenCalledTimes(1);
		expect(compactionErrors).toContain(
			"Context overflow recovery failed after one compact-and-retry attempt. Try reducing context or switching to a larger-context model.",
		);
	});

	it("compacts successful overflow responses without retrying", async () => {
		const harness = await createHarness({
			settings: { compaction: { enabled: true, keepRecentTokens: 1, reserveTokens: 0 } },
			models: [{ id: "faux-1", contextWindow: 1, maxTokens: 100 }],
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => ({
						compaction: {
							summary: "successful overflow compacted",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: {},
						},
					}));
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("completed answer")]);

		await expect(harness.session.prompt("hello")).resolves.toBeUndefined();

		const compactionEnd = harness.eventsOfType("compaction_end").at(-1);
		expect(compactionEnd).toMatchObject({
			reason: "overflow",
			aborted: false,
			willRetry: false,
		});
		expect(harness.faux.state.callCount).toBe(1);
	});

	it("ignores stale pre-compaction assistant usage on pre-prompt checks", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;
		const staleTimestamp = Date.now() - 10_000;
		const staleAssistant = createAssistant(harness, {
			stopReason: "stop",
			totalTokens: 610_000,
			timestamp: staleTimestamp,
		});

		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "before compaction" }],
			timestamp: staleTimestamp - 1000,
		});
		harness.sessionManager.appendMessage(staleAssistant);
		const firstKeptEntryId = harness.sessionManager.getEntries()[0]!.id;
		harness.sessionManager.appendCompaction(
			"summary",
			firstKeptEntryId,
			staleAssistant.usage.totalTokens,
			undefined,
			false,
		);
		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "after compaction" }],
			timestamp: Date.now(),
		});

		const runAutoCompactionSpy = vi.spyOn(sessionInternals, "_runAutoCompaction").mockResolvedValue(false);

		await sessionInternals._checkCompaction(staleAssistant, false);

		expect(runAutoCompactionSpy).not.toHaveBeenCalled();
	});

	it("triggers threshold compaction for error messages using the last successful usage", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;
		const successfulAssistant = createAssistant(harness, {
			stopReason: "stop",
			totalTokens: 190_000,
			timestamp: Date.now(),
		});
		const errorAssistant = createAssistant(harness, {
			stopReason: "error",
			errorMessage: "529 overloaded",
			timestamp: Date.now() + 1000,
		});
		harness.session.agent.state.messages = [
			{ role: "user", content: [{ type: "text", text: "hello" }], timestamp: Date.now() - 1000 },
			successfulAssistant,
			{ role: "user", content: [{ type: "text", text: "retry" }], timestamp: Date.now() + 500 },
			errorAssistant,
		];

		const runAutoCompactionSpy = vi.spyOn(sessionInternals, "_runAutoCompaction").mockResolvedValue(false);

		await sessionInternals._checkCompaction(errorAssistant);

		expect(runAutoCompactionSpy).toHaveBeenCalledWith("threshold", false);
	});

	it("does not trigger threshold compaction for error messages when no prior usage exists", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;
		const errorAssistant = createAssistant(harness, {
			stopReason: "error",
			errorMessage: "529 overloaded",
			timestamp: Date.now(),
		});
		harness.session.agent.state.messages = [
			{ role: "user", content: [{ type: "text", text: "hello" }], timestamp: Date.now() - 1000 },
			errorAssistant,
		];

		const runAutoCompactionSpy = vi.spyOn(sessionInternals, "_runAutoCompaction").mockResolvedValue(false);

		await sessionInternals._checkCompaction(errorAssistant);

		expect(runAutoCompactionSpy).not.toHaveBeenCalled();
	});

	it("does not trigger threshold compaction when only kept pre-compaction usage exists", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;
		const preCompactionTimestamp = Date.now() - 10_000;
		const keptAssistant = createAssistant(harness, {
			stopReason: "stop",
			totalTokens: 190_000,
			timestamp: preCompactionTimestamp,
		});

		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "before compaction" }],
			timestamp: preCompactionTimestamp - 1000,
		});
		harness.sessionManager.appendMessage(keptAssistant);
		const firstKeptEntryId = harness.sessionManager.getEntries()[0]!.id;
		harness.sessionManager.appendCompaction(
			"summary",
			firstKeptEntryId,
			keptAssistant.usage.totalTokens,
			undefined,
			false,
		);

		const errorAssistant = createAssistant(harness, {
			stopReason: "error",
			errorMessage: "529 overloaded",
			timestamp: Date.now(),
		});
		harness.session.agent.state.messages = [
			{ role: "user", content: [{ type: "text", text: "kept user" }], timestamp: preCompactionTimestamp - 1000 },
			keptAssistant,
			{ role: "user", content: [{ type: "text", text: "new prompt" }], timestamp: Date.now() - 500 },
			errorAssistant,
		];

		const runAutoCompactionSpy = vi.spyOn(sessionInternals, "_runAutoCompaction").mockResolvedValue(false);

		await sessionInternals._checkCompaction(errorAssistant);

		expect(runAutoCompactionSpy).not.toHaveBeenCalled();
	});

	it("does not trigger threshold compaction below the threshold or when disabled", async () => {
		const belowThresholdHarness = await createHarness({
			settings: { compaction: { enabled: true, reserveTokens: 1000 } },
			models: [{ id: "faux-1", contextWindow: 200_000 }],
		});
		harnesses.push(belowThresholdHarness);
		const disabledHarness = await createHarness({ settings: { compaction: { enabled: false } } });
		harnesses.push(disabledHarness);

		const belowThresholdInternals = belowThresholdHarness.session as unknown as SessionWithCompactionInternals;
		const disabledInternals = disabledHarness.session as unknown as SessionWithCompactionInternals;
		const belowThresholdSpy = vi.spyOn(belowThresholdInternals, "_runAutoCompaction").mockResolvedValue(false);
		const disabledSpy = vi.spyOn(disabledInternals, "_runAutoCompaction").mockResolvedValue(false);

		await belowThresholdInternals._checkCompaction(
			createAssistant(belowThresholdHarness, { stopReason: "stop", totalTokens: 1_000, timestamp: Date.now() }),
		);
		await disabledInternals._checkCompaction(
			createAssistant(disabledHarness, { stopReason: "stop", totalTokens: 1_000_000, timestamp: Date.now() }),
		);

		expect(belowThresholdSpy).not.toHaveBeenCalled();
		expect(disabledSpy).not.toHaveBeenCalled();
	});
});
