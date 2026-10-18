import { expect, test } from "vitest";
import { type BashOperations, type BashSpawnHook, createBashToolDefinition } from "../src/core/tools/bash.ts";

// Finding → test:
// R001: <<"EOF" body with backticks and $( )
// R002: printed example; gh api quoted payload
// R003: no runtime fixture (the assignment-in-expression loop is gone)
// R004: R004 quoted END-DOC then expanding gh body
// agentic P2 5560980350: --body-file after an unrelated backtick command
// P1-1: case statement without gh; gh pr view inside a case pattern; case pattern hiding a gh pr comment
// P1-2: short -b with backticks; attached -b with backticks; review -b with backticks
// P1-3: unquoted heredoc piped to a stdin body; echo backticks piped to a stdin body
// P2: body-file path with a parameter; whole --body= command substitution; double-quoted --body mixing text and $(date)
// P3-1: no runtime fixture (three linear scans replace the lazy GH_MUTATION regex)
// P3-2: if gh body-file; if backtick body; time subshell with a backtick body
// P3-3: computed gh group
// P3-4: brace group piped to a stdin body

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
		"unquoted <<EOF body with backticks",
		["gh pr create --title t --body-file - <<EOF", `see ${tick}code${tick}`, "EOF"].join("\n"),
	],
	[
		"unquoted <<EOF body with $( )",
		["gh pr comment 5 --body-file - <<EOF", "see $(date)", "EOF"].join("\n"),
	],
	[
		"double-quoted --body with backticks",
		[
			'gh pr create --title "bump"',
			`--body "Bumps the PR-review model to ${tick}claude-sonnet-5-5-200k${tick} per the brief."`,
		].join(" "),
	],
	[
		"double-quoted --body with $( )",
		'gh pr comment 5 --body "see $(echo $V)"',
	],
	["double-quoted --body with $VAR", 'gh pr comment 5 --body "see $VAR"'],
	["bare backticks", `gh pr create --title t --body ${tick}date${tick}`],
	[
		"backtick after a newline",
		`gh issue comment 18 --body "Evidence from the diagnosis.\n` +
			`The file is ${tick}docs/diagnosis/relay-2026-10.md${tick}."`,
	],
	[
		"raw backtick after an escaped quote",
		`gh issue create --title "t" --body "Say \\"hello\\" then ${tick}gh${tick} docs"`,
	],
	[
		"backtick assigned then expanded as $VAR",
		[`body="see ${tick}gh${tick} docs"`, 'gh pr create --title t --body "$body"'].join("\n"),
	],
	["gh pr review comment body", `gh pr review 12 --comment --body "see ${tick}gh${tick} docs"`],
	[
		"R004 quoted END-DOC then expanding gh body",
		["cat <<'END-DOC'", "hello", "END-DOC", `gh pr comment 5 --body "see ${tick}code${tick}"`].join("\n"),
	],
	["gh mutation after semicolon", `echo ok; gh pr comment 5 --body "see ${tick}code${tick}"`],
	["gh mutation after &&", `echo ok && gh pr comment 5 --body "see ${tick}code${tick}"`],
	["gh mutation after ||", `false || gh pr comment 5 --body "see ${tick}code${tick}"`],
	["gh mutation after pipe", `echo ok | gh pr comment 5 --body "see ${tick}code${tick}"`],
	[
		"gh mutation after newline",
		["echo ok", `gh pr comment 5 --body "see ${tick}code${tick}"`].join("\n"),
	],
	["gh mutation inside $( )", `echo $(gh pr comment 5 --body "see ${tick}code${tick}")`],
	["gh mutation inside a subshell", `(gh pr comment 5 --body "see ${tick}code${tick}")`],
	["short -b with backticks", `gh pr comment 5 -b "see ${tick}code${tick}"`],
	["attached -b with backticks", `gh pr comment 5 -b"see ${tick}code${tick}"`],
	["review -b with backticks", `gh pr review 12 --comment -b "see ${tick}code${tick}"`],
	[
		"unquoted heredoc piped to a stdin body",
		["cat <<EOF | gh pr comment 5 -F -", `see ${tick}code${tick}`, "EOF"].join("\n"),
	],
	["echo backticks piped to a stdin body", `echo "see ${tick}code${tick}" | gh pr comment 5 --body-file -`],
	["double-quoted --body mixing text and $(date)", 'gh pr comment 5 --body "see $(date)"'],
	["if backtick body", `if true; then gh pr comment 5 --body "see ${tick}code${tick}"; fi`],
	["time subshell with a backtick body", `time (gh pr comment 5 --body "see ${tick}code${tick}")`],
	["computed gh group", `gh "$(echo pr)" comment 5 --body "see ${tick}code${tick}"`],
	[
		"brace group piped to a stdin body",
		`{ echo "see ${tick}code${tick}"; echo ok; } | gh pr comment 5 -F -`,
	],
];

const unparsed: Array<[string, string]> = [
	[
		"unterminated heredoc hiding a later gh mutation",
		["cat <<'END-DOC'", "hello", `gh pr comment 5 --body "see ${tick}code${tick}"`].join("\n"),
	],
	["unterminated quote", 'gh pr comment 5 --body "see code'],
	["case pattern hiding a gh pr comment", "case $x in a) gh pr comment 5 --body-file body.md;; esac"],
];

const allowed: Array<[string, string]> = [
	["body file", "gh pr create --title t --body-file /tmp/pr-body.md"],
	["plain one-line body", 'gh pr comment 5 --body "Done, thanks"'],
	["command substitution on the title only", 'gh pr create --title "$(date)" --body-file f.md'],
	["read-only gh pr diff", "gh pr diff 89"],
	["unrelated command", "echo ok"],
	["single-quoted --body with backticks", `gh pr comment 5 --body 'see ${tick}gh${tick} docs'`],
	[
		"escaped backtick is a bash literal",
		`gh pr create --title "t" --body "one-line \\${tick}harbor pending\\${tick} stub"`,
	],
	[
		"nested quoted heredoc",
		[
			"gh pr create --draft --title \"ci: run the check\" --body \"$(cat <<'EOF'",
			"## What",
			`Add a second CI job, ${tick}check-linux${tick}, on ubuntu-latest.`,
			"EOF",
			")\"",
		].join("\n"),
	],
	[
		"<<'EOF' quoted stdin body with backticks and $( )",
		["gh pr comment 5 --body-file - <<'EOF'", `see ${tick}code${tick} and $(date)`, "EOF"].join("\n"),
	],
	[
		'<<"EOF" body with backticks and $( )',
		["gh pr comment 5 --body-file - <<\"EOF\"", `see ${tick}code${tick} and $(date)`, "EOF"].join("\n"),
	],
	[
		"<<\\EOF body with backticks and $( )",
		["gh pr comment 5 --body-file - <<\\EOF", `see ${tick}code${tick} and $(date)`, "EOF"].join("\n"),
	],
	[
		"<<-'EOF' with a tab-indented terminator",
		["gh pr comment 5 --body-file - <<-'EOF'", `see ${tick}code${tick} and $(date)`, "\tEOF"].join("\n"),
	],
	[
		"quoted END-DOC heredoc then a safe gh call",
		["cat <<'END-DOC'", `hello ${tick}code${tick}`, "END-DOC", "gh pr comment 5 --body-file body.md"].join("\n"),
	],
	[
		"--body-file after an unrelated backtick command",
		[`echo ${tick}date${tick}`, "gh pr comment 5 --body-file body.md"].join("\n"),
	],
	["cat file", 'gh pr create --title t --body "$(cat body.md)"'],
	["printed example", `printf '%s\\n' 'gh pr create --body "$(cat body.md)"'`],
	["gh api quoted payload", `gh api repos/o/r/issues -f body='gh pr create --body "$(cat body.md)"'`],
	["case statement without gh", "case $x in a) echo 1;; esac"],
	["function body without gh", "f() { echo hi; }"],
	["array assignment without gh", "a=(1 2)"],
	["if arithmetic without gh", "if (( $# == 0 )); then echo none; fi"],
	["for arithmetic without gh", "for ((i=0;i<2;i++)); do echo $i; done"],
	["regex conditional without gh", "[[ $x =~ ^(a|b)$ ]]"],
	["time subshell without gh", "time (make)"],
	["gh pr view inside a case pattern", "case $x in a) gh pr view 5;; esac"],
	["body-file path with a parameter", 'gh pr create --title t --body-file "$tmp"'],
	["short -F path", "gh pr comment 5 -F body.md"],
	["cat file piped to a stdin body", "cat body.md | gh pr comment 5 --body-file -"],
	[
		"quoted heredoc piped to a stdin body",
		["cat <<'EOF' | gh pr comment 5 -F -", `see ${tick}code${tick}`, "EOF"].join("\n"),
	],
	["whole --body= command substitution", 'gh pr create --title t --body="$(cat body.md)"'],
	["if gh body-file", "if (( n > 0 )); then gh pr comment 5 --body-file body.md; fi"],
];

test.each(blocked)("refuses %s before spawn", async (_name, command) => {
	const { pending, calls, updates } = execute(command);
	const error = await pending.then(
		() => {
			throw new Error("expected a refusal");
		},
		(caught: unknown) => caught,
	);
	const message = error instanceof Error ? error.message : String(error);
	expect(message).toMatch(/--body-file/);
	// $(echo pr) is the computed-group fixture: its command text has no "gh pr" substring.
	expect(message).toMatch(/gh (pr|issue)|\$\(echo pr\)/);
	expect(calls).toEqual([]);
	expect(updates()).toBe(0);
});

test.each(unparsed)("refuses %s because it cannot parse", async (_name, command) => {
	const { pending, calls, updates } = execute(command);
	await expect(pending).rejects.toThrow(/cannot parse/);
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
