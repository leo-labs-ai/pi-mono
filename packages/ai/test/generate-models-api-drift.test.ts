import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { getSupportedThinkingLevels } from "../src/models.ts";
import type { Api, Model } from "../src/types.ts";

const packageRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const temporaryRoots: string[] = [];

afterEach(() => {
	for (const root of temporaryRoots.splice(0)) rmSync(root, { force: true, recursive: true });
});

function upstreamModel(id: string, npm?: string): Record<string, unknown> {
	return { id, name: id, tool_call: true, ...(npm ? { provider: { npm } } : {}) };
}

/** Run the generator against a mocked models.dev; every other fetch fails. */
function runGenerator(catalog: Record<string, { models: Record<string, unknown> }>, extraArgs: string[]) {
	const fixtureRoot = mkdtempSync(join(tmpdir(), "pi-api-drift-"));
	temporaryRoots.push(fixtureRoot);
	const isolatedPackageRoot = join(fixtureRoot, "package");
	mkdirSync(isolatedPackageRoot);
	for (const entry of ["package.json", "scripts", "src"]) {
		cpSync(join(packageRoot, entry), join(isolatedPackageRoot, entry), { recursive: true });
	}
	const preloadPath = join(fixtureRoot, "mock-models-dev.mjs");
	writeFileSync(
		preloadPath,
		`const catalog = ${JSON.stringify(catalog)};\n` +
			`globalThis.fetch = async (input) => {\n` +
			`  if (String(input) === "https://models.dev/api.json") return new Response(JSON.stringify(catalog), { status: 200 });\n` +
			`  throw new Error(\`Unexpected fetch: \${String(input)}\`);\n` +
			`};\n`,
	);
	const diagnosticsPath = join(fixtureRoot, "diagnostics.json");
	const result = spawnSync(
		process.execPath,
		[
			"--import",
			pathToFileURL(preloadPath).href,
			"scripts/generate-models.ts",
			"--json-only",
			"--json-output",
			join(fixtureRoot, "out"),
			"--diagnostics-json",
			diagnosticsPath,
			...extraArgs,
		],
		{ cwd: isolatedPackageRoot, encoding: "utf8", timeout: 30_000 },
	);
	const diagnostics = JSON.parse(readFileSync(diagnosticsPath, "utf8")) as {
		skipped: { provider: string; modelId: string; reason: string; npm?: string }[];
	};
	return { result, diagnostics, outputDir: join(fixtureRoot, "out"), output: `${result.stdout}\n${result.stderr}` };
}

describe("generate-models API drift", () => {
	const models = {
		"known-model": upstreamModel("known-model", "@ai-sdk/openai"),
		// Documented override: OpenCode serves this as openai-compatible chat completions.
		"mistral-large-4": upstreamModel("mistral-large-4", "@ai-sdk/mistral"),
		"mystery-model": upstreamModel("mystery-model", "@ai-sdk/mystery"),
	};

	it("skips and logs an unknown adapter in ordinary runs", () => {
		const { result, diagnostics, output, outputDir } = runGenerator({ opencode: { models } }, []);

		expect(result.status).toBe(0);
		const emitted = JSON.parse(readFileSync(join(outputDir, "models.json"), "utf8")).opencode;
		expect(Object.keys(emitted).sort()).toEqual(["known-model", "mistral-large-4"]);
		expect(emitted["mistral-large-4"].api).toBe("openai-completions");
		expect(output).toContain("Skipped model: opencode/mystery-model: unknown npm adapter @ai-sdk/mystery");
		expect(diagnostics.skipped).toEqual([
			expect.objectContaining({
				provider: "opencode",
				modelId: "mystery-model",
				reason: "unknown-adapter",
				npm: "@ai-sdk/mystery",
			}),
		]);
	});

	it("fails --check-api-drift when an unknown adapter is skipped", () => {
		const { result, diagnostics, output } = runGenerator({ opencode: { models } }, ["--check-api-drift"]);

		expect(result.status).toBe(1);
		expect(output).toContain("API drift: 1 upstream model(s) were skipped");
		expect(diagnostics.skipped.map((entry) => entry.modelId)).toEqual(["mystery-model"]);
	});

	it("passes --check-api-drift when only documented adapters appear", () => {
		const { result, diagnostics } = runGenerator(
			{
				opencode: {
					models: { "known-model": models["known-model"], "mistral-large-4": models["mistral-large-4"] },
				},
			},
			["--check-api-drift"],
		);

		expect(result.status).toBe(0);
		expect(diagnostics.skipped).toEqual([]);
	});

	// models.dev deprecated opencode-go/deepseek-v4-flash, so the live catalog no longer
	// carries it; the generator's DeepSeek V4 Flash level mapping is checked against a fixture.
	it("maps DeepSeek V4 Flash on opencode-go to off/low/high/max", () => {
		const { result, outputDir } = runGenerator(
			{
				"opencode-go": {
					models: { "deepseek-v4-flash": { ...upstreamModel("deepseek-v4-flash"), reasoning: true } },
				},
			},
			[],
		);

		expect(result.status).toBe(0);
		const emitted = JSON.parse(readFileSync(join(outputDir, "models.json"), "utf8"))["opencode-go"][
			"deepseek-v4-flash"
		] as Model<Api>;
		expect(getSupportedThinkingLevels(emitted)).toEqual(["off", "low", "high", "max"]);
	});
});
