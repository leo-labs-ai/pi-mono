#!/usr/bin/env node

import { execFileSync } from "node:child_process";

const DEFAULT_BASE_REF = process.env.CHANGELOG_BASE_REF ?? "origin/main";
const diffRange = process.argv[2] ?? `${DEFAULT_BASE_REF}...HEAD`;
const SEMVER = String.raw`\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?`;
const AI_MANIFEST = "packages/ai/package.json";
const AI_VERSION_MODULE = "packages/ai/src/utils/version.ts";

function git(args) {
	return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function parseNames(output) {
	return output
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
}

// Committed range plus anything staged. The staged half matters when this runs from the
// pre-commit hook: the commit being created is not in HEAD yet, so a range-only view is
// always one commit behind and the very commit that adds the required changelog entry
// would be rejected for not having it.
function changedFiles() {
	const committed = parseNames(git(["diff", "--name-only", diffRange]));
	let staged = [];
	try {
		staged = parseNames(git(["diff", "--name-only", "--cached"]));
	} catch {
		staged = [];
	}
	return [...new Set([...committed, ...staged])];
}

function isChangelog(path) {
	return path === "FORK-CHANGELOG.md" || /(^|\/)CHANGELOG\.md$/.test(path);
}

function isDocsOnly(path) {
	return path.startsWith("docs/") || path.endsWith(".md") || path.endsWith(".mdx");
}

function isTestOnly(path) {
	return /(^|\/)(test|tests|__tests__|fixtures)\//.test(path) || /\.(spec|test)\.[cm]?[jt]sx?$/.test(path);
}

// Generated lockfiles have no documentable surface. Match by basename, not an exact root
// path, so a lockfile nested in a workspace is ignored too.
function isLockfile(path) {
	return /(^|\/)(package-lock\.json|npm-shrinkwrap\.json)$/.test(path);
}

function isVersionLine(content) {
	// A package's own version bump or an internal @leo-labs-ai/* dependency pin bump, e.g.
	//   "version": "0.80.3",
	//   "@leo-labs-ai/pi-ai": "0.80.3",
	return (
		new RegExp(String.raw`^"version":\s*"${SEMVER}",?$`).test(content) ||
		new RegExp(String.raw`^"@leo-labs-ai/[^"]+":\s*"[~^]?${SEMVER}",?$`).test(content)
	);
}

// A package.json whose diff only bumps the package's own version and/or internal
// @leo-labs-ai/* dependency pins is a release-mechanical change (like a lockfile), not a
// documentable surface change — the changesets "version packages" PR (config changelog:
// false) lands here. Any other changed line (new dep, script, config) still requires a
// changelog entry.
function isVersionOnlyPackageJson(path) {
	if (!/(^|\/)package\.json$/.test(path)) return false;
	let diff;
	try {
		diff = git(["diff", "--unified=0", diffRange, "--", path]);
		// Staged-only edits are invisible to the range diff (see changedFiles).
		if (diff.trim() === "") diff = git(["diff", "--unified=0", "--cached", "--", path]);
	} catch {
		return false;
	}
	let sawChange = false;
	for (const line of diff.split("\n")) {
		if (line.startsWith("+++") || line.startsWith("---")) continue;
		if (!line.startsWith("+") && !line.startsWith("-")) continue;
		const content = line.slice(1).trim();
		if (content === "") continue;
		sawChange = true;
		if (!isVersionLine(content)) return false;
	}
	return sawChange;
}

function patchLines(diff) {
	const firstHunk = diff.indexOf("\n@@ ");
	if (firstHunk === -1) return [];
	return diff.slice(firstHunk).split("\n").filter((line) => /^[+-]/.test(line));
}

// sync-versions.js mirrors pi-ai's manifest in this file so browsers do not
// need to read package.json. Exempt only that substitution, with matching old
// and new manifest versions in the same diff; do not exempt the file itself.
function isGeneratedAiVersion(path) {
	if (path !== AI_VERSION_MODULE) return false;
	try {
		const diff = (comparison, file) => git(["diff", "--unified=0", comparison, "--", file]);
		const committed = diff(diffRange, path);
		const staged = diff("--cached", path);
		if (committed && (staged || diff("--cached", AI_MANIFEST))) return false;
		const comparison = committed ? diffRange : "--cached";
		const manifestDiff = git(["diff", "--raw", "--no-abbrev", "--no-renames", comparison, "--", AI_MANIFEST]);
		const blobs = /^:\d+ \d+ ([0-9a-f]+) ([0-9a-f]+) M\t/.exec(manifestDiff);
		if (!blobs) return false;
		const version = (blob) => JSON.parse(git(["cat-file", "blob", blob])).version;
		const before = version(blobs[1]);
		const after = version(blobs[2]);
		const semver = new RegExp(`^${SEMVER}$`);
		if (before === after || typeof before !== "string" || typeof after !== "string") return false;
		if (!semver.test(before) || !semver.test(after)) return false;
		const sourceDiff = committed || staged;
		if (/^old mode /m.test(sourceDiff)) return false;
		const changes = patchLines(sourceDiff);
		return (
			changes.length === 2 &&
			changes[0] === `-export const PI_AI_VERSION = "${before}";` &&
			changes[1] === `+export const PI_AI_VERSION = "${after}";`
		);
	} catch {
		return false;
	}
}

function isIgnored(path) {
	return (
		isChangelog(path) ||
		isDocsOnly(path) ||
		isTestOnly(path) ||
		path.startsWith(".github/") ||
		isLockfile(path) ||
		isVersionOnlyPackageJson(path) ||
		isGeneratedAiVersion(path)
	);
}

function requiredChangelog(path) {
	if (isIgnored(path)) return undefined;
	const packageMatch = /^packages\/([^/]+)\//.exec(path);
	if (packageMatch) return `packages/${packageMatch[1]}/CHANGELOG.md`;
	return "FORK-CHANGELOG.md";
}

const files = changedFiles();
const changed = new Set(files);
const required = new Set(files.map(requiredChangelog).filter(Boolean));
// Fork convention: FORK-CHANGELOG.md is the home for all fork-specific notes, so a
// touched FORK-CHANGELOG.md also satisfies any package-CHANGELOG requirement.
// Package CHANGELOGs stay reserved for upstream / upstreamable release notes and may
// still be updated directly, but are no longer mandatory for a fork change.
const forkChangelogTouched = changed.has("FORK-CHANGELOG.md");
const missing = [...required].filter(
	(path) => !changed.has(path) && !(forkChangelogTouched && path !== "FORK-CHANGELOG.md"),
);

if (missing.length === 0) {
	console.log("Changelog check passed.");
	process.exit(0);
}

console.error("Changelog check failed.");
console.error("");
console.error(`Diff range: ${diffRange}`);
console.error("");
console.error("Update the changelog file that matches the changed surface:");
for (const path of missing) {
	console.error(`  - ${path}`);
}
console.error("");
console.error(
	"Docs-only, tests-only, workflow-only, lockfile-only, and version-bump-only changes are ignored.",
);
process.exit(1);
