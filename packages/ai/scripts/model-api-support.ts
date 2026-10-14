import { OPENCODE_APIS } from "../src/providers/opencode-apis.ts";

/**
 * - `unknown-adapter`: the upstream npm adapter (e.g. `@ai-sdk/mistral`) has no mapping to a pi API.
 * - `unsupported-api`: the adapter maps to a known pi API, but the provider does not register it.
 */
export type ModelSkipReason = "unknown-adapter" | "unsupported-api";

export interface SkippedModel {
	provider: string;
	modelId: string;
	reason: ModelSkipReason;
	npm?: string;
	api?: string;
	message: string;
}

/** Providers whose catalog API varies per model, and the chat APIs each registers. */
const DYNAMIC_API_PROVIDERS: Record<string, readonly string[]> = {
	opencode: OPENCODE_APIS,
	"opencode-go": OPENCODE_APIS,
};

/** Upstream npm adapters with a defined API mapping. A missing adapter means OpenAI-compatible. */
const KNOWN_NPM_ADAPTERS = new Set([
	"@ai-sdk/openai",
	"@ai-sdk/anthropic",
	"@ai-sdk/google",
	"@ai-sdk/alibaba",
	"@ai-sdk/openai-compatible",
]);

/**
 * models.dev lists Mistral Large 4 under `@ai-sdk/mistral`, but OpenCode documents it as an
 * `@ai-sdk/openai-compatible` chat-completions endpoint
 * (https://opencode.ai/docs/zen/#endpoints). Correct that one entry; every other unmapped
 * adapter still reports as drift.
 */
const DOCUMENTED_NPM_ADAPTER_OVERRIDES: Record<string, { npm: string; adapter: string }> = {
	"mistral-large-4": { npm: "@ai-sdk/mistral", adapter: "@ai-sdk/openai-compatible" },
};

/** Return the documented adapter for a model, or its models.dev adapter when no override applies. */
export function resolveNpmAdapter(provider: string, modelId: string, npm: string | undefined): string | undefined {
	const override = provider === "opencode" ? DOCUMENTED_NPM_ADAPTER_OVERRIDES[modelId] : undefined;
	return override && override.npm === npm ? override.adapter : npm;
}

export function unknownAdapterSkip(provider: string, modelId: string, npm: string): SkippedModel {
	return {
		provider,
		modelId,
		reason: "unknown-adapter",
		npm,
		message: `${provider}/${modelId}: unknown npm adapter ${npm}. Map it in generate-models.ts (OpenCode loop) if pi can serve it.`,
	};
}

/** Return a skip record when the resolved API is not registered by the provider. */
export function unsupportedApiSkip(provider: string, modelId: string, api: string, npm?: string): SkippedModel | undefined {
	const supported = DYNAMIC_API_PROVIDERS[provider];
	if (!supported || supported.includes(api)) return undefined;
	return {
		provider,
		modelId,
		reason: "unsupported-api",
		...(npm ? { npm } : {}),
		api,
		message: `${provider}/${modelId}: API ${api} is not registered by the ${provider} provider. Register it in src/providers/${provider}.ts and opencode-apis.ts.`,
	};
}

export function isKnownNpmAdapter(npm: string | undefined): boolean {
	return npm === undefined || npm === null || KNOWN_NPM_ADAPTERS.has(npm);
}
