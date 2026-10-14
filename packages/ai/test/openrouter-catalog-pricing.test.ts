import { describe, expect, it } from "vitest";
import { buildOpenRouterCatalog } from "../scripts/openrouter-catalog.ts";

describe("OpenRouter catalog pricing provenance", () => {
	// https://openrouter.ai/api/v1/models, observed 2026-10-14.
	// Independent model IDs carry independent prices; :batch does not imply a discount.
	it("preserves the source prices when a batch variant costs more than the standard model", () => {
		const { chat } = buildOpenRouterCatalog(
			[
				{
					id: "openai/gpt-oss-20b",
					name: "GPT OSS 20B",
					supported_parameters: ["tools"],
					pricing: { prompt: "0.000000018", completion: "0.00000009", input_cache_read: "0.000000009" },
				},
				{
					id: "openai/gpt-oss-20b:batch",
					name: "GPT OSS 20B Batch",
					supported_parameters: ["tools"],
					pricing: { prompt: "0.000000024", completion: "0.000000112" },
				},
			],
			[],
			[],
		);

		expect(chat.map(({ id, cost }) => ({ id, cost }))).toEqual([
			{ id: "openai/gpt-oss-20b", cost: { input: 0.018, output: 0.09, cacheRead: 0.009, cacheWrite: 0 } },
			{ id: "openai/gpt-oss-20b:batch", cost: { input: 0.024, output: 0.112, cacheRead: 0, cacheWrite: 0 } },
		]);
	});
});
