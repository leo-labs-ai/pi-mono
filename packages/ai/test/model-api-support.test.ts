import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hydrateModelCatalog } from "../scripts/hydrate-model-catalog.ts";
import { isKnownNpmAdapter, unknownAdapterSkip, unsupportedApiSkip } from "../scripts/model-api-support.ts";
import { opencodeProvider } from "../src/providers/opencode.ts";
import { opencodeGoProvider } from "../src/providers/opencode-go.ts";
import type { Api, Model, ProviderStreams } from "../src/types.ts";
import { AssistantMessageEventStream } from "../src/utils/event-stream.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const googleCalls = vi.hoisted(() => [] as { modelId: string; headers: unknown }[]);

vi.mock("../src/api/google-generative-ai.lazy.ts", () => ({
	googleGenerativeAIApi: (): ProviderStreams => {
		const record = (model: Model<Api>, _context: unknown, options?: { headers?: unknown }) => {
			googleCalls.push({ modelId: model.id, headers: options?.headers });
			return new AssistantMessageEventStream();
		};
		return { stream: record, streamSimple: record } as ProviderStreams;
	},
}));

const packageRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const temporaryRoots: string[] = [];

afterEach(() => {
	vi.restoreAllMocks();
	for (const root of temporaryRoots.splice(0)) rmSync(root, { force: true, recursive: true });
});

function chatModel(id: string, api: string): Record<string, unknown> {
	return {
		type: "chat",
		id,
		name: id,
		api,
		provider: "opencode-go",
		baseUrl: "https://example.test/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000,
		maxTokens: 100,
	};
}

/** A package root with one generated provider, plus a catalog file holding `catalog`. */
function createFixture(catalog: unknown): { catalogFile: string; packageRoot: string } {
	const packageRoot = mkdtempSync(join(tmpdir(), "pi-model-snapshot-"));
	temporaryRoots.push(packageRoot);
	const providersDir = join(packageRoot, "src", "providers");
	mkdirSync(providersDir, { recursive: true });
	writeFileSync(
		join(packageRoot, "src", "models.generated.ts"),
		'import { OPENCODE_GO_CLASSIFIER_MODELS, OPENCODE_GO_IMAGE_MODELS, OPENCODE_GO_MODELS } from "./providers/opencode-go.models.ts";\n',
	);
	writeFileSync(
		join(providersDir, "opencode-go.models.ts"),
		'import values from "./data/opencode-go.json" with { type: "json" };\n',
	);
	const catalogFile = join(packageRoot, "catalog.json");
	writeFileSync(catalogFile, JSON.stringify(catalog));
	return { catalogFile, packageRoot };
}

describe("model API support", () => {
	it.each([
		["opencode", opencodeProvider],
		["opencode-go", opencodeGoProvider],
	] as const)(
		"dispatches google-generative-ai models through the %s provider",
		(providerId, createOpenCodeProvider) => {
			const provider = createOpenCodeProvider();
			const googleModel: Model<"google-generative-ai"> = {
				id: "gemini-test",
				name: "Gemini test",
				api: "google-generative-ai",
				provider: providerId,
				baseUrl: "https://opencode.ai/zen/v1",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 1000,
				maxTokens: 100,
			};
			googleCalls.length = 0;

			provider.stream(googleModel, normalizeContext({ messages: [{ role: "user", content: "hi", timestamp: 0 }] }), {
				apiKey: "test-key",
				sessionId: "session-1",
			});

			return vi.waitFor(() => {
				expect(googleCalls).toEqual([
					{ modelId: "gemini-test", headers: expect.objectContaining({ "x-opencode-session": "session-1" }) },
				]);
			});
		},
	);

	it("distinguishes unknown npm adapters from unsupported APIs", () => {
		expect(isKnownNpmAdapter(undefined)).toBe(true);
		expect(isKnownNpmAdapter("@ai-sdk/google")).toBe(true);
		expect(isKnownNpmAdapter("@ai-sdk/mistral")).toBe(false);
		expect(unknownAdapterSkip("opencode", "m", "@ai-sdk/mistral")).toMatchObject({
			reason: "unknown-adapter",
			npm: "@ai-sdk/mistral",
		});
		expect(unsupportedApiSkip("opencode-go", "m", "google-generative-ai")).toBeUndefined();
		expect(unsupportedApiSkip("opencode-go", "m", "bedrock-converse-stream", "@ai-sdk/x")).toMatchObject({
			reason: "unsupported-api",
			api: "bedrock-converse-stream",
		});
		// Providers with a fixed API are not checked here.
		expect(unsupportedApiSkip("anthropic", "m", "anthropic-messages")).toBeUndefined();
	});
});

describe("model catalog snapshot hydration", () => {
	it("skips APIs the provider cannot serve", () => {
		const { catalogFile, packageRoot } = createFixture({
			"opencode-go": [chatModel("ok", "openai-completions"), chatModel("bad", "bedrock-converse-stream")],
		});
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

		hydrateModelCatalog(packageRoot, catalogFile);

		const data = readFileSync(join(packageRoot, "src", "providers", "data", "opencode-go.json"), "utf8");
		expect(data).toContain('"ok"');
		expect(data).not.toContain('"bad"');
		expect(warn).toHaveBeenCalledWith(expect.stringContaining("opencode-go/bad"));
	});

	it("hydrates this checkout from the committed snapshot without network access", () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch");
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

		hydrateModelCatalog(packageRoot, join(packageRoot, "model-catalog.snapshot.json"), { validateOnly: true });

		expect(fetchSpy).not.toHaveBeenCalled();
		// A snapshot that needs skips was generated before the API drift check passed.
		expect(warn).not.toHaveBeenCalled();
	});
});
