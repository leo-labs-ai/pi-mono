const GH_BODY_MUTATION = /\bgh\s+(?:pr|issue)\s+(?:create|edit|comment|review)\b/;
const GH_HEREDOC = /<<-?\s*['"]?[A-Za-z_]\w*/;
const GH_INLINE_BODY_FLAG = /(?:--body(?!-)|--notes(?!-)|(?<![\w-])-b)(?:=|\s+)/;

const FRAGILE_GH_BODY =
	"Blocked: this gh pr/issue command builds the body in the shell, which expands backticks and $(...) " +
	"before gh reads them (mangled body, or the text runs as a command). Write the body with the Write tool " +
	"and pass --body-file. A plain one-line --body with no backticks is unchanged.";

/**
 * Shell-expanded PR and issue bodies. A doc line does not stop the model from
 * passing Markdown through `gh --body`, and bash expands backticks before `gh`
 * starts. Refuse that command before spawn. `--body-file` and a one-line
 * literal with no backticks stay allowed.
 */
export function fragileGhBodyReason(command: string): string | undefined {
	if (!GH_BODY_MUTATION.test(command)) return undefined;
	if (GH_HEREDOC.test(command) || ghInlineBodyIsExpanded(command) || doubleQuotedBacktick(command)) {
		return FRAGILE_GH_BODY;
	}
	return undefined;
}

function ghInlineBodyIsExpanded(command: string): boolean {
	const flags = new RegExp(GH_INLINE_BODY_FLAG.source, "g");
	let match: RegExpExecArray | null;
	while ((match = flags.exec(command))) {
		let valueAt = match.index + match[0].length;
		while (command[valueAt] === " " || command[valueAt] === "\t") valueAt++;
		if (bodyValueStartsExpanded(command, valueAt)) return true;
		const wordEnd = endOfShellWord(command, valueAt);
		if (wordEnd <= flags.lastIndex) break;
		flags.lastIndex = wordEnd;
	}
	return false;
}

/** True when an inline body value starts with bash command substitution. Single quotes do not. */
function bodyValueStartsExpanded(command: string, i: number): boolean {
	if (i >= command.length || command[i] === "'") return false;
	if (command[i] === '"') i++;
	return command.startsWith("$(", i) || command[i] === "`";
}

/** End index of one shell word, so a later flag scan does not read inside this argument. */
function endOfShellWord(command: string, i: number): number {
	if (i >= command.length) return i;
	const quote = command[i];
	if (quote === "'" || quote === '"') {
		i++;
		while (i < command.length) {
			if (quote === '"' && command[i] === "\\") {
				i += 2;
				continue;
			}
			if (command[i] === quote) return i + 1;
			i++;
		}
		return i;
	}
	while (i < command.length && command[i] !== " " && command[i] !== "\t" && command[i] !== "\n") i++;
	return i;
}

/** A backtick inside double quotes is command substitution, including after a newline or an escaped quote. */
function doubleQuotedBacktick(command: string): boolean {
	let i = 0;
	while (i < command.length) {
		const c = command[i];
		if (c === "\\") {
			i += 2;
			continue;
		}
		if (c === "'") {
			i++;
			while (i < command.length && command[i] !== "'") i++;
			i++;
			continue;
		}
		if (c === '"') {
			i++;
			while (i < command.length) {
				if (command[i] === "\\") {
					i += 2;
					continue;
				}
				if (command[i] === "`") return true;
				if (command[i] === '"') break;
				i++;
			}
		}
		i++;
	}
	return false;
}
