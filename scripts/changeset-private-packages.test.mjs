import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { read } = require("@changesets/config");
const changesetsCli = require.resolve("@changesets/cli/bin.js");
const repoRoot = fileURLToPath(new URL("..", import.meta.url));

test("release config does not version or tag private packages", async () => {
	const config = await read(repoRoot);
	assert.equal(config.privatePackages.version, false);
	assert.equal(config.privatePackages.tag, false);
});

// @changesets/config@3.1.4 treats a missing privatePackages key as version: true.
// changesets/action then reads CHANGELOG.md for every package whose version changed,
// and "changelog": false does not create one for private p2.
async function versionFixture(privatePackages) {
	const root = await mkdtemp(join(tmpdir(), "pi-changeset-private-"));
	const config = {
		changelog: false,
		commit: false,
		fixed: [],
		linked: [],
		access: "restricted",
		baseBranch: "main",
		updateInternalDependencies: "patch",
		ignore: [],
	};
	if (privatePackages) config.privatePackages = privatePackages;
	await writeJson(root, "package.json", {
		name: "fixture",
		private: true,
		workspaces: ["packages/*", "apps/*"],
	});
	await writeJson(root, ".changeset/config.json", config);
	await writeText(root, ".changeset/fix.md", "---\n\"lib\": patch\n---\n\nFix.\n");
	await writeJson(root, "packages/lib/package.json", { name: "lib", version: "1.0.0" });
	await writeText(root, "packages/lib/CHANGELOG.md", "# lib\n");
	await writeJson(root, "apps/p2/package.json", {
		name: "p2",
		version: "0.0.3",
		private: true,
		dependencies: { lib: "1.0.0" },
	});
	execFileSync("git", ["init", "-b", "main"], { cwd: root, stdio: "ignore" });
	execFileSync(process.execPath, [changesetsCli, "version"], { cwd: root, stdio: "ignore" });
	return root;
}

async function writeJson(root, relativePath, value) {
	await writeText(root, relativePath, `${JSON.stringify(value, null, "\t")}\n`);
}

async function writeText(root, relativePath, contents) {
	const path = join(root, relativePath);
	await mkdir(join(path, ".."), { recursive: true });
	await writeFile(path, contents);
}

test("privatePackages.version false does not bump a private dependent and still retargets its dependency", async () => {
	const root = await versionFixture({ version: false, tag: false });
	try {
		const app = JSON.parse(await readFile(join(root, "apps/p2/package.json"), "utf8"));
		const lib = JSON.parse(await readFile(join(root, "packages/lib/package.json"), "utf8"));
		assert.equal(lib.version, "1.0.1");
		assert.equal(app.version, "0.0.3");
		assert.equal(app.dependencies.lib, "1.0.1");
		assert.equal(existsSync(join(root, "apps/p2/CHANGELOG.md")), false);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("an omitted privatePackages key bumps the private dependent and leaves no changelog to read", async () => {
	const root = await versionFixture(undefined);
	try {
		const app = JSON.parse(await readFile(join(root, "apps/p2/package.json"), "utf8"));
		assert.equal(app.version, "0.0.4");
		assert.equal(app.dependencies.lib, "1.0.1");
		assert.equal(existsSync(join(root, "apps/p2/CHANGELOG.md")), false);
		await assert.rejects(readFile(join(root, "apps/p2/CHANGELOG.md"), "utf8"), (error) => error.code === "ENOENT");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
