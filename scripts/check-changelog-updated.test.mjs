import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const checker = fileURLToPath(new URL("./check-changelog-updated.mjs", import.meta.url));
const manifestPath = "packages/ai/package.json";
const versionPath = "packages/ai/src/utils/version.ts";
const appPath = "apps/p2/package.json";
const durablePath = "packages/durable/package.json";

function fixture(t) {
	const cwd = mkdtempSync(join(tmpdir(), "check-changelog-"));
	t.after(() => rmSync(cwd, { recursive: true, force: true }));
	const git = (...args) => execFileSync("git", args, { cwd, stdio: "pipe", encoding: "utf8" });
	const file = (path, text) => {
		mkdirSync(join(cwd, dirname(path)), { recursive: true });
		writeFileSync(join(cwd, path), text);
	};
	const manifest = (version, nestedVersion = "1.5.2") =>
		file(manifestPath, `${JSON.stringify({ name: "@leo-labs-ai/pi-ai", version, nested: { version: nestedVersion } }, null, "\t")}\n`);
	const versionModule = (version, rest = "") =>
		file(versionPath, `export const PI_AI_VERSION = "${version}";\n${rest}`);
	const chordPin = (version) => {
		for (const path of [appPath, durablePath]) {
			file(path, `{\n\t"dependencies": {\n\t\t"@earendil-works/chord": "${version}"\n\t}\n}\n`);
		}
	};
	const commit = () => {
		git("add", ".");
		git(
			"-c",
			"core.hooksPath=/dev/null",
			"-c",
			"user.name=Fixture",
			"-c",
			"user.email=fixture@example.invalid",
			"commit",
			"--no-gpg-sign",
			"-qm",
			"fixture",
		);
		return git("rev-parse", "HEAD").trim();
	};
	git("init", "--quiet");
	manifest("1.5.2");
	versionModule("1.5.2");
	chordPin("1.5.2");
	const base = commit();
	const check = () => {
		const result = spawnSync(process.execPath, [checker, `${base}...HEAD`], { cwd, encoding: "utf8" });
		assert.ifError(result.error);
		return result;
	};
	return { manifest, versionModule, chordPin, commit, git, check };
}

test("changelog check accepts a generated pi-ai constant bump with the matching manifest bump", (t) => {
	const f = fixture(t);
	f.manifest("1.5.3");
	f.versionModule("1.5.3");
	f.git("add", ".");
	const staged = f.check();
	assert.equal(staged.status, 0, staged.stderr);
	f.commit();
	const committed = f.check();
	assert.equal(committed.status, 0, committed.stderr);
});

test("changelog check still requires a changelog for non-mechanical pi-ai source changes", async (t) => {
	for (const [name, manifestVersion, sourceVersion, rest, nestedVersion] of [
		["no corresponding manifest bump", "1.5.2", "1.5.3", ""],
		["mismatched bump", "1.5.3", "1.5.4", ""],
		["additional source change", "1.5.3", "1.5.3", "export const extra = true;\n"],
		["only a nested manifest property changed", "1.5.2", "1.5.3", "", "1.5.3"],
	]) {
		await t.test(name, (subtest) => {
			const f = fixture(subtest);
			f.manifest(manifestVersion, nestedVersion);
			f.versionModule(sourceVersion, rest);
			f.commit();
			const result = f.check();
			assert.equal(result.status, 1, result.stdout);
			assert.match(result.stderr, /packages\/ai\/CHANGELOG\.md/);
		});
	}
});

test("changelog check still flags Chord pin changes on a generated release", (t) => {
	const f = fixture(t);
	f.manifest("1.5.3");
	f.versionModule("1.5.3");
	f.chordPin("1.5.3");
	f.commit();
	const result = f.check();
	assert.equal(result.status, 1, result.stdout);
	assert.match(result.stderr, /FORK-CHANGELOG\.md/);
	assert.match(result.stderr, /packages\/durable\/CHANGELOG\.md/);
	assert.doesNotMatch(result.stderr, /packages\/ai\/CHANGELOG\.md/);
});
