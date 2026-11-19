// The source runtime resolves both workspace scopes and p2's plugin API to checkout source.
import assert from "node:assert/strict";
import { test } from "node:test";
import "../../src/source-resolver.ts";

const aliases = [
	["@leo-labs-ai/pi-ai", "packages/ai/src/index.ts"],
	["@leo-labs-ai/pi-durable", "packages/durable/src/index.ts"],
	["@leo-labs-ai/pi-env", "packages/env/src/index.ts"],
	["@leo-labs-ai/pi-tui", "packages/tui/src/index.ts"],
	["@leo-labs-ai/pi-telemetry/render", "packages/telemetry/src/render.ts"],
	["@earendil-works/pi-ai", "packages/ai/src/index.ts"],
	["@earendil-works/pi-codemode", "packages/codemode/src/index.ts"],
	["@earendil-works/pi-schema", "packages/schema/src/index.ts"],
	["@p2/app/v1", "apps/p2/src/api/v1/index.ts"],
] as const;

for (const [specifier, path] of aliases) {
	test(`${specifier} resolves to source instead of package build output`, () => {
		assert.equal(import.meta.resolve(specifier), new URL(`../../../../${path}`, import.meta.url).href);
	});
}
