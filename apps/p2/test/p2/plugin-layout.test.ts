// p2's plugins are laid out for Chord's plugin builder (`@earendil-works/chord/plugins`): every plugin directory is a
// package, and every facet builds on its own against p2's plugin API (`@p2/app/v1`), with no import of base code by
// path, of Chord directly, of another plugin's non-contract files or of another kind's files.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { test } from "node:test";
import { buildFacet, discoverPlugins } from "@earendil-works/chord/plugins";
import { BACKGROUND_CONTEXT } from "@p2/app/v1";
import { APP } from "./helpers.ts";

const KINDS = ["server", "worker", "tui", "web"] as const;

/** The packages a facet shares with its host as instances (never bundled), besides the API. */
const SHARED = [
	"@leo-labs-ai/pi-ai",
	"@leo-labs-ai/pi-ai/api/anthropic-messages.lazy",
	"@leo-labs-ai/pi-ai/api/google-generative-ai.lazy",
	"@leo-labs-ai/pi-ai/api/openai-completions.lazy",
	"@leo-labs-ai/pi-ai/api/openai-responses.lazy",
	"@leo-labs-ai/pi-ai/models",
	"@leo-labs-ai/pi-ai/providers/all",
	"@leo-labs-ai/pi-ai/providers/faux",
	"@leo-labs-ai/pi-ai/providers/radius",
	"@leo-labs-ai/pi-ai/providers/radius-config",
	"@earendil-works/pi-codemode",
	"@leo-labs-ai/pi-durable",
	"@leo-labs-ai/pi-durable/codemode",
	"@leo-labs-ai/pi-durable/env",
	"@leo-labs-ai/pi-durable/env/node",
	"@leo-labs-ai/pi-durable/tool-search",
	"@leo-labs-ai/pi-durable/tools",
	"@leo-labs-ai/pi-env",
	"@earendil-works/pi-mcp",
	"@earendil-works/pi-mcp/oauth",
	"@earendil-works/pi-schema",
	"@earendil-works/pi-schema/formats",
	"@leo-labs-ai/pi-tui",
	"ws",
	"yaml",
];

/** The API modules each kind may import. */
const API: Record<(typeof KINDS)[number], readonly string[]> = {
	server: ["@p2/app/v1", "@p2/app/v1/node", "@p2/app/v1/server", "discord.js"],
	worker: ["@p2/app/v1", "@p2/app/v1/node", "@p2/app/v1/worker"],
	tui: ["@p2/app/v1", "@p2/app/v1/tui"],
	web: ["@p2/app/v1", "@p2/app/v1/web", "react", "react/jsx-runtime", "react-dom"],
};

test("every plugin directory is a package named after it", async () => {
	const { plugins, problems } = await discoverPlugins(
		[{ path: join(APP, "plugins"), required: true }],
		{ kinds: [...KINDS] },
		BACKGROUND_CONTEXT,
	);
	assert.deepEqual(problems, []);
	for (const plugin of plugins) assert.equal(plugin.name, relative(join(APP, "plugins"), plugin.dir));
});

test("every server, worker, TUI and web facet builds against the plugin API alone", async () => {
	const { plugins } = await discoverPlugins(
		[{ path: join(APP, "plugins"), required: true }],
		{ kinds: [...KINDS] },
		BACKGROUND_CONTEXT,
	);
	const failures: string[] = [];
	for (const plugin of plugins) {
		for (const kind of KINDS) {
			if (plugin.facets[kind] === undefined) continue;
			const built = await buildFacet(
				plugin,
				kind,
				{
					hostPackages: [...API[kind], ...SHARED],
					platform: kind === "web" ? "browser" : "node",
					api: { name: "@p2/app", versions: ["v1"] },
					kinds: KINDS,
					plugins,
				},
				BACKGROUND_CONTEXT,
			);
			if (built.kind === "failed") failures.push(...built.errors.map((error) => `${plugin.name}/${kind}: ${error}`));
		}
	}
	assert.deepEqual(failures, []);
});

test("p2's tsconfig maps every workspace package the repository's maps, and the plugin API", () => {
	const paths = (directory: string) =>
		(
			JSON.parse(readFileSync(join(directory, "tsconfig.json"), "utf8")) as {
				compilerOptions: { paths: Record<string, string[]> };
			}
		).compilerOptions.paths;
	const repository = resolve(APP, "../..");
	const absolute = (directory: string, entries: Record<string, string[]>) =>
		Object.fromEntries(
			Object.entries(entries).map(([pattern, targets]) => [
				pattern,
				targets.map((target) => resolve(directory, target)),
			]),
		);
	const own = absolute(APP, paths(APP));
	// The fork's packages are mapped by their fork names: the repository maps both names, p2 only the fork's.
	const forkOwned = /^@earendil-works\/(pi-(?:ai|agent-core|tui|telemetry|durable|env|coding-agent|evals))(?=\/|$)/;
	for (const [pattern, targets] of Object.entries(absolute(repository, paths(repository)))) {
		if (pattern.startsWith("@earendil-works/") || pattern === "typebox")
			assert.deepEqual(own[pattern.replace(forkOwned, "@leo-labs-ai/$1")], targets, pattern);
	}
	assert.deepEqual(own["@p2/app/v1"], [join(APP, "src/api/v1/index.ts")]);
});
