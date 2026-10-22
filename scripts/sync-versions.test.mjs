import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const syncVersionsScript = fileURLToPath(new URL("./sync-versions.js", import.meta.url));

async function writeManifest(root, relativeDirectory, manifest) {
	const directory = join(root, relativeDirectory);
	await mkdir(directory, { recursive: true });
	await writeFile(join(directory, "package.json"), `${JSON.stringify(manifest, null, "\t")}\n`);
}

async function readManifest(root, relativeDirectory) {
	return JSON.parse(await readFile(join(root, relativeDirectory, "package.json"), "utf8"));
}

function runSyncVersions(root) {
	return spawnSync(process.execPath, [syncVersionsScript, join(root, "packages")], {
		cwd: root,
		encoding: "utf8",
	});
}

// #10865: caret ranges allowed older agents to install incompatible newer workspace dependencies.
test("pins fork-owned dependencies without touching vendored packages, registry aliases, generated manifests, or published lockstep", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-sync-versions-"));
	try {
		await writeManifest(root, "packages/ai", {
			name: "@leo-labs-ai/pi-ai",
			version: "2.0.0",
		});
		await writeManifest(root, "packages/coding-agent", {
			name: "@leo-labs-ai/pi-coding-agent",
			version: "2.0.0",
			dependencies: {
				"@leo-labs-ai/pi-ai": "^2.0.0",
			},
			devDependencies: {
				"@leo-labs-ai/pi-ai": "~1.0.0",
			},
			optionalDependencies: {
				"@leo-labs-ai/pi-ai": "1.0.0",
			},
		});
		// Vendored upstream package: published, and deliberately off the fork's lockstep.
		await writeManifest(root, "packages/chord", {
			name: "@earendil-works/chord",
			version: "9.9.9",
		});
		await writeManifest(root, "packages/evals", {
			name: "@leo-labs-ai/pi-evals",
			version: "9.9.9",
			private: true,
			dependencies: {
				"@leo-labs-ai/pi-coding-agent": "^1.0.0",
				"@earendil-works/chord": "9.9.9",
				"@mariozechner/pi-ai": "npm:@earendil-works/pi-ai@1.0.0",
			},
		});
		await writeManifest(root, "packages/coding-agent/install-lock", {
			name: "generated-install-lock",
			version: "0.0.0",
			private: true,
			dependencies: {
				"@leo-labs-ai/pi-coding-agent": "^1.0.0",
			},
		});

		const result = runSyncVersions(root);
		assert.equal(result.status, 0, result.stderr);

		const agentManifest = await readManifest(root, "packages/coding-agent");
		for (const section of ["dependencies", "devDependencies", "optionalDependencies"]) {
			assert.equal(agentManifest[section]["@leo-labs-ai/pi-ai"], "2.0.0");
		}
		const evalsManifest = await readManifest(root, "packages/evals");
		assert.equal(evalsManifest.dependencies["@leo-labs-ai/pi-coding-agent"], "2.0.0");
		// Vendored versions are upstream's, so the exact pin must survive the rewrite.
		assert.equal(evalsManifest.dependencies["@earendil-works/chord"], "9.9.9");
		assert.equal(evalsManifest.dependencies["@mariozechner/pi-ai"], "npm:@earendil-works/pi-ai@1.0.0");
		const generatedManifest = await readManifest(root, "packages/coding-agent/install-lock");
		assert.equal(generatedManifest.dependencies["@leo-labs-ai/pi-coding-agent"], "^1.0.0");

		const alreadySynced = runSyncVersions(root);
		assert.equal(alreadySynced.status, 0, alreadySynced.stderr);
		assert.match(alreadySynced.stdout, /All inter-package dependencies are already in sync/);

		await writeManifest(root, "packages/ai", {
			name: "@leo-labs-ai/pi-ai",
			version: "3.0.0",
		});
		const lockstepFailure = runSyncVersions(root);
		assert.equal(lockstepFailure.status, 1, lockstepFailure.stderr);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("pins each fork-owned dependency to the exact version, whatever range it had", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-sync-versions-range-"));
	try {
		await writeManifest(root, "packages/ai", { name: "@leo-labs-ai/pi-ai", version: "2.0.0" });
		await writeManifest(root, "packages/coding-agent", {
			name: "@leo-labs-ai/pi-coding-agent",
			version: "2.0.0",
		});
		await writeManifest(root, "packages/consumer", {
			name: "@leo-labs-ai/pi-consumer",
			version: "2.0.0",
			private: true,
			dependencies: {
				"@leo-labs-ai/pi-ai": "1.0.0",
				"@leo-labs-ai/pi-coding-agent": "~1.0.0",
			},
		});

		const result = runSyncVersions(root);
		assert.equal(result.status, 0, result.stderr);

		const consumer = await readManifest(root, "packages/consumer");
		assert.equal(consumer.dependencies["@leo-labs-ai/pi-ai"], "2.0.0");
		assert.equal(consumer.dependencies["@leo-labs-ai/pi-coding-agent"], "2.0.0");

		// Running again must be a no-op: changesets maintains the same exact pins.
		const rerun = runSyncVersions(root);
		assert.equal(rerun.status, 0, rerun.stderr);
		assert.match(rerun.stdout, /already in sync/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("writes the pi-ai version constant", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-sync-versions-"));
	try {
		await writeManifest(root, "packages/ai", {
			name: "@leo-labs-ai/pi-ai",
			version: "2.0.0",
		});
		const versionPath = join(root, "packages/ai/src/utils/version.ts");
		await mkdir(join(root, "packages/ai/src/utils"), { recursive: true });
		await writeFile(versionPath, 'export const PI_AI_VERSION = "1.0.0";\n');

		const result = runSyncVersions(root);
		assert.equal(result.status, 0, result.stderr);
		assert.match(await readFile(versionPath, "utf8"), /export const PI_AI_VERSION = "2\.0\.0";\n$/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
