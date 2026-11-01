/**
 * Chat APIs that OpenCode Zen and OpenCode Go both register in their providers.
 * The model generator imports this list to decide which catalog entries it can
 * emit, so adding an API here requires a matching entry in both providers' `api`
 * maps (each map satisfies `Record<OpenCodeApi, ProviderStreams>`).
 */
export const OPENCODE_APIS = [
	"anthropic-messages",
	"google-generative-ai",
	"openai-completions",
	"openai-responses",
] as const;

export type OpenCodeApi = (typeof OPENCODE_APIS)[number];
