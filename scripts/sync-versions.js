#!/usr/bin/env node

/**
 * Validates lockstep versions for published packages, then synchronizes
 * exact internal dependency versions in all workspace packages, including private ones,
 * and in the apps next to the packages directory (`apps/*`, never published).
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { findPackageDirectories, isVendoredUpstreamPackage } from "./package-workspaces.mjs";

const GENERATED_PACKAGE_SUFFIXES = [join("coding-agent", "install-lock")];

function readManifests(directories) {
	return directories.map((directory) => {
		const path = join(directory, "package.json");
		return { data: JSON.parse(readFileSync(path, "utf8")), path };
	});
}

const packageRoot = process.argv[2] ?? "packages";
const workspacePackages = readManifests(
	findPackageDirectories(packageRoot).filter(
		(directory) => !GENERATED_PACKAGE_SUFFIXES.some((suffix) => directory.endsWith(suffix)),
	),
);
// Apps pin workspace packages exactly too, rather than fetching them from a registry.
const appRoot = join(dirname(packageRoot), "apps");
const appPackages = existsSync(appRoot) ? readManifests(findPackageDirectories(appRoot)) : [];

// Vendored upstream packages are versioned by upstream, so they neither join the
// fork's lockstep set nor supply versions for the dependency rewrite below.
const forkOwnedPackages = workspacePackages.filter((pkg) => !isVendoredUpstreamPackage(pkg.data.name));
const publishedPackages = forkOwnedPackages.filter((pkg) => pkg.data.private !== true);
const versionMap = new Map(forkOwnedPackages.map((pkg) => [pkg.data.name, pkg.data.version]));

console.log("Current versions:");
for (const pkg of [...publishedPackages].sort((a, b) => a.data.name.localeCompare(b.data.name))) {
	console.log(`  ${pkg.data.name}: ${pkg.data.version}`);
}

const versions = new Set(publishedPackages.map((pkg) => pkg.data.version));
if (versions.size > 1) {
	console.error("\nERROR: Not all non-private packages have the same version.");
	console.error("Expected lockstep versioning. Run one of:");
	console.error("  npm run version:patch");
	console.error("  npm run version:minor");
	console.error("  npm run version:major");
	process.exit(1);
}

console.log("\nAll non-private packages are at the same version (lockstep).");

let totalUpdates = 0;
const updatedPackages = new Set();
for (const pkg of [...workspacePackages, ...appPackages]) {
	for (const dependencyType of ["dependencies", "devDependencies", "optionalDependencies"]) {
		const dependencies = pkg.data[dependencyType];
		if (!dependencies) {
			continue;
		}

		for (const [dependencyName, currentSpecifier] of Object.entries(dependencies)) {
			// `file:`, `link:`, git and URL specifiers name a source, not a registry version. Test fixtures
			// such as Chord's plugin-imports example link private packages under packages/ this way, so a
			// lockstep pin would replace a local path with a version npm cannot resolve. Registry versions
			// and ranges contain neither `:` nor `/`.
			if (currentSpecifier.includes(":") || currentSpecifier.includes("/")) {
				continue;
			}
			// Registry aliases such as `npm:@earendil-works/pi-ai@0.1.2` are never workspace-linked,
			// so lockstep bumping them would point at a version that is not published yet.
			const newSpecifier = versionMap.get(dependencyName);
			if (!newSpecifier || currentSpecifier === newSpecifier) {
				continue;
			}

			console.log(`\n${pkg.data.name}:`);
			console.log(
				`  ${dependencyName}: ${currentSpecifier} → ${newSpecifier}${dependencyType === "dependencies" ? "" : ` (${dependencyType})`}`,
			);
			dependencies[dependencyName] = newSpecifier;
			updatedPackages.add(pkg);
			totalUpdates++;
		}
	}
}

for (const pkg of updatedPackages) {
	writeFileSync(pkg.path, `${JSON.stringify(pkg.data, null, "\t")}\n`);
}

if (totalUpdates === 0) {
	console.log("\nAll inter-package dependencies are already in sync.");
} else {
	console.log(`\nUpdated ${totalUpdates} dependency version(s).`);
}

// pi-ai reports its version in the User-Agent without reading package.json, which browsers cannot do.
const aiPackage = workspacePackages.find((pkg) => pkg.data.name === "@leo-labs-ai/pi-ai");
const aiVersionPath = aiPackage && join(dirname(aiPackage.path), "src", "utils", "version.ts");
if (aiVersionPath && existsSync(aiVersionPath)) {
	const content = `// The @leo-labs-ai/pi-ai package version. scripts/sync-versions.js keeps it in sync with package.json.\nexport const PI_AI_VERSION = ${JSON.stringify(aiPackage.data.version)};\n`;
	if (readFileSync(aiVersionPath, "utf8") !== content) {
		writeFileSync(aiVersionPath, content);
		console.log(`\nUpdated ${aiVersionPath} to ${aiPackage.data.version}.`);
	}
}
