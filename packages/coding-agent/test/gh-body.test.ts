import { expect, test } from "vitest";
import { type BashOperations, type BashSpawnHook, createBashToolDefinition } from "../src/core/tools/bash.ts";

const tick = "`";

function bashTool(spawnHook?: BashSpawnHook) {
	const calls: string[] = [];
	const operations: BashOperations = {
		exec: async (command) => {
			calls.push(command);
			return { exitCode: 0 };
		},
	};
	const tool = createBashToolDefinition(process.cwd(), {
		operations,
		exposeSessionEnvironment: false,
		spawnHook,
	});
	return { tool, calls };
}

function execute(command: string, spawnHook?: BashSpawnHook) {
	const { tool, calls } = bashTool(spawnHook);
	let updates = 0;
	const pending = tool.execute(
		"gh-body",
		{ command },
		undefined,
		() => {
			updates++;
		},
		{} as never,
	);
	return { pending, calls, updates: () => updates };
}

const blocked: Array<[string, string]> = [
	[
		"unquoted heredoc body",
		["gh pr create --title t --body-file - <<EOF", `see ${tick}code${tick}`, "EOF"].join("\n"),
	],
	[
		"double-quoted backtick (2026-10-01)",
		[
			'gh pr create --title "bump"',
			`--body "Bumps the PR-review model to ${tick}claude-sonnet-5-5-200k${tick} per the brief."`,
		].join(" "),
	],
	[
		"backtick after a newline (2026-10-02 issue comment)",
		`gh issue comment 18 --body "Evidence from the diagnosis.\n` +
			`The file is ${tick}docs/diagnosis/relay-2026-10.md${tick}."`,
	],
	[
		"raw backtick after an escaped quote",
		`gh issue create --title "t" --body "Say \\"hello\\" then ${tick}gh${tick} docs"`,
	],
	[
		"backtick assigned in the same command",
		[`body="see ${tick}gh${tick} docs"`, 'gh pr create --title t --body "$body"'].join("\n"),
	],
	[
		"gh pr review comment body",
		`gh pr review 12 --comment --body "see ${tick}gh${tick} docs"`,
	],
];

const allowed: Array<[string, string]> = [
	["body file", "gh pr create --title t --body-file /tmp/pr-body.md"],
	["plain one-line body", 'gh pr comment 5 --body "Done, thanks"'],
	["command substitution on the title only", 'gh pr create --title "$(date)" --body-file f.md'],
	["read-only gh pr diff", "gh pr diff 89"],
	["unrelated command", "echo ok"],
	["single-quoted backticks", `gh pr comment 5 --body 'see ${tick}gh${tick} docs'`],
	[
		"escaped backtick is a bash literal",
		`gh pr create --title "t" --body "one-line \\${tick}harbor pending\\${tick} stub"`,
	],
	[
		"quoted heredoc body (2026-10-13 agent-relay #89)",
		[
			"gh pr create --draft --title \"ci: run the check\" --body \"$(cat <<'EOF'",
			"## What",
			`Add a second CI job, ${tick}check-linux${tick}, on ubuntu-latest.`,
			"EOF",
			")\"",
		].join("\n"),
	],
	[
		"quoted stdin heredoc on --body-file",
		["gh pr comment 5 --body-file - <<'EOF'", `see ${tick}code${tick}`, "EOF"].join("\n"),
	],
	["file read through command substitution", 'gh pr create --title t --body "$(cat body.md)"'],
	[
		"quoted example printed, not executed",
		`printf '%s\\n' 'gh pr create --body "$(cat body.md)"'`,
	],
	[
		"gh api payload quoting an example",
		`gh api repos/o/r/issues -f body='gh pr create --body "$(cat body.md)"'`,
	],
];

test.each(blocked)("refuses %s before spawn", async (_name, command) => {
	const { pending, calls, updates } = execute(command);
	await expect(pending).rejects.toThrow(/--body-file/);
	expect(calls).toEqual([]);
	expect(updates()).toBe(0);
});

test.each(allowed)("runs %s", async (_name, command) => {
	const { pending, calls } = execute(command);
	const result = await pending;
	expect(result.isError).not.toBe(true);
	expect(calls).toEqual([command]);
});

test("judges the command a spawn hook rewrote into a fragile body", async () => {
	const fragile = `gh pr create --title "bump" --body "see ${tick}gh${tick} docs"`;
	const hook: BashSpawnHook = (ctx) => ({ ...ctx, command: fragile });
	const { pending, calls, updates } = execute("echo ok", hook);
	await expect(pending).rejects.toThrow(/--body-file/);
	expect(calls).toEqual([]);
	expect(updates()).toBe(0);
});

test("runs a fragile command once a spawn hook rewrote it to --body-file", async () => {
	const safe = "gh pr create --title t --body-file /tmp/pr-body.md";
	const hook: BashSpawnHook = (ctx) => ({ ...ctx, command: safe });
	const fragile = `gh pr create --title "bump" --body "see ${tick}gh${tick} docs"`;
	const { pending, calls } = execute(fragile, hook);
	await pending;
	expect(calls).toEqual([safe]);
});
