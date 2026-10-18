const MUTATION_GROUP = new Set(["pr", "issue"]);
const MUTATION_SUB = new Set(["create", "edit", "comment", "review"]);

const FRAGILE_GH_BODY =
	"Blocked: this gh pr/issue command builds the body in the shell, which expands backticks or an " +
	"unquoted heredoc before gh reads them (mangled body, or the text runs as a command). Write the body " +
	"with the Write tool and pass --body-file. A plain one-line --body, a single-quoted heredoc, and " +
	'--body "$(cat file)" are unchanged.';

interface ShellScan {
	mutation: boolean;
	expands: boolean;
}

interface PendingHeredoc {
	word: string;
	literal: boolean;
	dash: boolean;
}

/**
 * Refuse an executed `gh pr|issue create|edit|comment|review` when bash would
 * expand the body: a bare or double-quoted backtick, or a heredoc whose
 * delimiter is not single-quoted. A quoted heredoc, `$(cat file)`, and the
 * same text inside another command's quotes stay allowed.
 */
export function fragileGhBodyReason(command: string): string | undefined {
	const scan: ShellScan = { mutation: false, expands: false };
	scanShell(command, 0, false, scan);
	if (scan.mutation && scan.expands) return FRAGILE_GH_BODY;
	return undefined;
}

function noteCommand(words: string[], scan: ShellScan) {
	let index = 0;
	while (index < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index])) index++;
	const command = words[index];
	const group = words[index + 1];
	const sub = words[index + 2];
	if (command !== "gh" || group === undefined || sub === undefined) return;
	if (MUTATION_GROUP.has(group) && MUTATION_SUB.has(sub)) scan.mutation = true;
}

function consumeHeredocs(command: string, start: number, pending: PendingHeredoc[], scan: ShellScan): number {
	let cursor = start;
	for (const heredoc of pending) {
		if (!heredoc.literal) scan.expands = true;
		while (cursor < command.length) {
			const newline = command.indexOf("\n", cursor);
			const lineEnd = newline === -1 ? command.length : newline;
			const line = command.slice(cursor, lineEnd);
			const text = heredoc.dash ? line.replace(/^\t+/, "") : line;
			cursor = newline === -1 ? command.length : newline + 1;
			if (text === heredoc.word) break;
		}
	}
	pending.length = 0;
	return cursor;
}

function readHeredoc(command: string, start: number): { heredoc: PendingHeredoc; next: number } | undefined {
	if (command[start + 2] === "<") return undefined;
	let cursor = start + 2;
	let dash = false;
	if (command[cursor] === "-") {
		dash = true;
		cursor++;
	}
	while (command[cursor] === " " || command[cursor] === "\t") cursor++;
	let literal = false;
	const quote = command[cursor];
	if (quote === "'" || quote === '"') {
		literal = quote === "'";
		cursor++;
	}
	let word = "";
	while (cursor < command.length && /[A-Za-z0-9_]/.test(command[cursor])) {
		word += command[cursor];
		cursor++;
	}
	if (word.length === 0) return undefined;
	if ((quote === "'" || quote === '"') && command[cursor] === quote) cursor++;
	return { heredoc: { word, literal, dash }, next: cursor };
}

function readWord(command: string, start: number, scan: ShellScan): { value: string; next: number } {
	let value = "";
	let cursor = start;
	while (cursor < command.length) {
		const current = command[cursor];
		if (
			current === " " ||
			current === "\t" ||
			current === "\n" ||
			current === ";" ||
			current === "|" ||
			current === "&" ||
			current === "<" ||
			current === ">" ||
			current === "(" ||
			current === ")" ||
			current === "`"
		) {
			break;
		}
		if (current === "\\") {
			value += command[cursor + 1] ?? "";
			cursor += 2;
			continue;
		}
		if (current === "'") {
			cursor++;
			while (cursor < command.length && command[cursor] !== "'") {
				value += command[cursor];
				cursor++;
			}
			if (command[cursor] === "'") cursor++;
			continue;
		}
		if (current === '"') {
			cursor++;
			while (cursor < command.length) {
				const quoted = command[cursor];
				if (quoted === "\\") {
					const escaped = command[cursor + 1];
					if (escaped !== "`") value += escaped ?? "";
					cursor += 2;
					continue;
				}
				if (quoted === '"') {
					cursor++;
					break;
				}
				if (quoted === "`") {
					scan.expands = true;
					value += "`";
					cursor++;
					continue;
				}
				if (quoted === "$" && command[cursor + 1] === "(") {
					cursor = scanShell(command, cursor + 2, true, scan);
					continue;
				}
				value += quoted;
				cursor++;
			}
			continue;
		}
		if (current === "$" && command[cursor + 1] === "(") {
			cursor = scanShell(command, cursor + 2, true, scan);
			continue;
		}
		value += current;
		cursor++;
	}
	return { value, next: cursor };
}

function scanShell(command: string, start: number, stopOnCloseParen: boolean, scan: ShellScan): number {
	const words: string[] = [];
	const pending: PendingHeredoc[] = [];
	let cursor = start;
	while (cursor < command.length) {
		const current = command[cursor];
		if (current === " " || current === "\t") {
			cursor++;
			continue;
		}
		if (current === "\\") {
			cursor += 2;
			continue;
		}
		if (current === "`") {
			scan.expands = true;
			cursor++;
			continue;
		}
		if (current === "\n") {
			cursor = consumeHeredocs(command, cursor + 1, pending, scan);
			noteCommand(words, scan);
			words.length = 0;
			continue;
		}
		if (current === ";" || current === "|" || current === "&") {
			cursor++;
			if ((current === "|" || current === "&") && command[cursor] === current) cursor++;
			noteCommand(words, scan);
			words.length = 0;
			continue;
		}
		if (current === "(") {
			noteCommand(words, scan);
			words.length = 0;
			cursor++;
			continue;
		}
		if (current === ")") {
			noteCommand(words, scan);
			words.length = 0;
			if (stopOnCloseParen) return cursor + 1;
			cursor++;
			continue;
		}
		if (current === "<" && command[cursor + 1] === "<") {
			const heredoc = readHeredoc(command, cursor);
			if (heredoc) {
				pending.push(heredoc.heredoc);
				cursor = heredoc.next;
				continue;
			}
		}
		const word = readWord(command, cursor, scan);
		if (word.next === cursor) {
			cursor++;
			continue;
		}
		words.push(word.value);
		cursor = word.next;
	}
	cursor = consumeHeredocs(command, cursor, pending, scan);
	noteCommand(words, scan);
	return cursor;
}
