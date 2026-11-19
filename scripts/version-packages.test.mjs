import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const rootManifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

function steps(script) {
	return script.split("&&").map((step) => step.trim());
}

// release.yml runs `npm run version-packages` through changesets/action to build the
// "chore(release): version fork packages" PR. `changeset version` rewrites package.json
// files only, so without scripts/sync-versions.js the PI_AI_VERSION constant in
// packages/ai/src/utils/version.ts stays on the previous release and
// packages/ai/test/identity.test.ts fails on that PR (1.4.1: expected '1.4.0' to be '1.4.1').
test("version-packages regenerates the pi-ai version constant after changeset version and before the lockfile refresh", () => {
	const pipeline = steps(rootManifest.scripts["version-packages"]);
	const versionIndex = pipeline.indexOf("changeset version");
	const syncIndex = pipeline.findIndex((step) => /^node scripts\/sync-versions\.js$/.test(step));
	const lockfileIndex = pipeline.findIndex((step) => step.startsWith("npm install --package-lock-only"));
	const installLockIndex = pipeline.indexOf("npm run install-lock:coding-agent");

	assert.equal(versionIndex, 0, pipeline.join(" && "));
	assert.ok(syncIndex > versionIndex, `sync-versions must run after changeset version: ${pipeline.join(" && ")}`);
	assert.ok(lockfileIndex > syncIndex, `the lockfile refresh must see the synced manifests: ${pipeline.join(" && ")}`);
	assert.ok(installLockIndex > lockfileIndex, `the coding-agent install lock is regenerated last: ${pipeline.join(" && ")}`);
});

test("sync-versions is what keeps PI_AI_VERSION equal to the pi-ai package version", () => {
	const syncVersions = readFileSync(fileURLToPath(new URL("./sync-versions.js", import.meta.url)), "utf8");
	assert.match(syncVersions, /export const PI_AI_VERSION = \$\{JSON\.stringify\(aiPackage\.data\.version\)\}/);
	const versionModule = readFileSync(new URL("../packages/ai/src/utils/version.ts", import.meta.url), "utf8");
	const aiManifest = JSON.parse(readFileSync(new URL("../packages/ai/package.json", import.meta.url), "utf8"));
	assert.match(versionModule, new RegExp(`export const PI_AI_VERSION = "${aiManifest.version.replaceAll(".", "\\.")}";`));
});
