const MUTATION_GROUP = new Set(["pr", "issue"]);
const MUTATION_SUB = new Set(["create", "edit", "comment", "review"]);
const RESERVED = ["if", "then", "elif", "else", "do", "while", "until", "time"];

const CANNOT_PARSE =
	"Blocked: cannot parse this bash command. It contains a gh pr/issue mutation that the guard cannot read. " +
	"Run that gh call as its own plain command with --body-file.";

const GH_WORD = /\bgh\b/;
const GH_MUTATION = /\bgh\b[\s\S]*?\b(pr|issue)\b[\s\S]*?\b(create|edit|comment|review)\b/;

/**
 * Refuse one simple command at a time. A heredoc is literal when any part of
 * its delimiter is quoted, quote removal keeps punctuation such as END-DOC,
 * and the commands after that terminator are still judged. An earlier
 * backtick does not affect a later gh command. A script with no gh word is
 * left alone. A script that does not parse is refused only when it still
 * looks like a gh pr/issue mutation.
 */
export function fragileGhBodyReason(command: string): string | undefined {
	if (!GH_WORD.test(command)) return undefined;
	const parsed = parseScript(command);
	if (!parsed.ok) return GH_MUTATION.test(command) ? CANNOT_PARSE : undefined;
	let index = 0;
	while (index < parsed.commands.length) {
		const simpleCommand = parsed.commands[index];
		if (ghBodyExpands(simpleCommand, parsed.commands, index)) return refusal(simpleCommand);
		index++;
	}
	return undefined;
}

interface Word {
	value: string;
	backtick: boolean;
	param: boolean;
	arith: boolean;
	substExpands: boolean;
	substCount: number;
}

interface PendingHeredoc {
	literal: boolean;
	expands: boolean;
	terminator: string;
	dash: boolean;
}

interface SimpleCommand {
	text: string;
	words: Word[];
	heredocs: PendingHeredoc[];
	pipe: boolean;
}

interface Ctx {
	source: string;
	index: number;
	error: boolean;
	commands: SimpleCommand[];
}

function refusal(command: SimpleCommand): string {
	const shown = command.text.replace(/\s+/g, " ").trim();
	return (
		`Blocked: \`${shown}\` builds its gh body in the shell, so backticks or expansions run before gh reads them. ` +
		"Write that body with the Write tool and pass --body-file."
	);
}

function parseScript(source: string): { ok: true; commands: SimpleCommand[] } | { ok: false } {
	const ctx: Ctx = { source, index: 0, error: false, commands: [] };
	parseList(ctx, null);
	if (ctx.error) return { ok: false };
	return { ok: true, commands: ctx.commands };
}

function parseList(ctx: Ctx, end: ")" | "}" | null, inheritedPipe = false): boolean {
	let expands = false;
	let pipeNext = inheritedPipe;
	const pending: PendingHeredoc[] = [];
	let command: SimpleCommand | undefined;
	let commandStart = ctx.index;

	const finish = (endIndex: number): SimpleCommand | undefined => {
		if (!command) return undefined;
		command.text = ctx.source.slice(commandStart, endIndex).trim();
		command.pipe = pipeNext;
		pipeNext = false;
		const finished = command;
		command = undefined;
		if (finished.words.length === 0 && finished.heredocs.length === 0) return undefined;
		ctx.commands.push(finished);
		expands = noteHeredocs(finished, expands);
		return finished;
	};

	const ensure = (): SimpleCommand => {
		if (!command) {
			commandStart = ctx.index;
			command = { text: "", words: [], heredocs: [], pipe: false };
		}
		return command;
	};

	while (ctx.index < ctx.source.length && !ctx.error) {
		const before = ctx.index;
		skipBlank(ctx);
		if (ctx.index >= ctx.source.length) break;
		const current = ctx.source[ctx.index];
		if (current === "\\" && ctx.source[ctx.index + 1] === "\n") {
			ctx.index += 2;
			continue;
		}
		if (end === ")" && current === ")") {
			finish(ctx.index);
			ctx.index++;
			if (pending.length > 0) ctx.error = true;
			return expands;
		}
		if (end === "}" && bareWord(ctx, "}")) {
			finish(ctx.index);
			ctx.index++;
			if (pending.length > 0) ctx.error = true;
			return expands;
		}
		if (current === "#") {
			skipComment(ctx);
			continue;
		}
		if (current === "\n") {
			const endIndex = ctx.index;
			const finished = command;
			ctx.index++;
			finish(endIndex);
			fillHeredocs(ctx, pending);
			if (finished) expands = noteHeredocs(finished, expands);
			continue;
		}
		if (current === ")") {
			ctx.error = true;
			break;
		}
		if (current === "&" && ctx.source[ctx.index + 1] === ">") {
			ctx.index++;
			readRedirect(ctx, ensure(), pending);
			continue;
		}
		if (isSeparator(ctx)) {
			const endIndex = ctx.index;
			const pipe = consumeSeparator(ctx);
			finish(endIndex);
			pipeNext = pipe;
			continue;
		}
		if (current === "(") {
			if (command && command.words.length > 0) {
				ctx.error = true;
				break;
			}
			const inherited = pipeNext;
			finish(ctx.index);
			pipeNext = false;
			ctx.index++;
			if (parseList(ctx, ")", inherited)) expands = true;
			continue;
		}
		if (bareWord(ctx, "{") && (!command || command.words.length === 0)) {
			const inherited = pipeNext;
			finish(ctx.index);
			pipeNext = false;
			ctx.index++;
			if (parseList(ctx, "}", inherited)) expands = true;
			continue;
		}
		if (skipReserved(ctx, command)) continue;
		const simple = ensure();
		if (startsRedirect(ctx)) {
			readRedirect(ctx, simple, pending);
		} else {
			const word = readWord(ctx);
			if (!word) ctx.error = true;
			else simple.words.push(word);
		}
		if (ctx.index === before) ctx.error = true;
	}

	const finished = command;
	finish(ctx.index);
	if (pending.length > 0) fillHeredocs(ctx, pending);
	if (finished) expands = noteHeredocs(finished, expands);
	if (pending.length > 0) ctx.error = true;
	return expands;
}

function noteHeredocs(command: SimpleCommand, expands: boolean): boolean {
	for (const heredoc of command.heredocs) {
		if (heredoc.expands) return true;
	}
	for (const word of command.words) {
		if (word.backtick || word.param || word.arith || word.substExpands) return true;
	}
	return expands;
}

function fillHeredocs(ctx: Ctx, pending: PendingHeredoc[]) {
	for (const heredoc of pending) {
		if (!readHeredocBody(ctx, heredoc)) {
			ctx.error = true;
			return;
		}
	}
	pending.length = 0;
}

function readHeredocBody(ctx: Ctx, heredoc: PendingHeredoc): boolean {
	const source = ctx.source;
	while (ctx.index <= source.length) {
		const start = ctx.index;
		const newline = source.indexOf("\n", start);
		const last = newline === -1;
		const end = last ? source.length : newline;
		let line = source.slice(start, end);
		if (heredoc.dash) line = line.replace(/^\t+/, "");
		ctx.index = last ? source.length : newline + 1;
		if (line === heredoc.terminator) return true;
		if (!heredoc.literal && heredocLineExpands(line)) heredoc.expands = true;
		if (last) return false;
	}
	return false;
}

function heredocLineExpands(line: string): boolean {
	let index = 0;
	while (index < line.length) {
		const current = line[index];
		if (current === "\\") {
			index += 2;
			continue;
		}
		if (current === "`") return true;
		if (current === "$") {
			const next = line[index + 1];
			if (next === "(" || next === "{" || (next !== undefined && isParamChar(next))) return true;
		}
		index++;
	}
	return false;
}

function readHeredocOperator(ctx: Ctx): PendingHeredoc | undefined {
	ctx.index += 2;
	let dash = false;
	if (ctx.source[ctx.index] === "-") {
		dash = true;
		ctx.index++;
	}
	skipBlank(ctx);
	const delimiter = readDelimiter(ctx);
	if (!delimiter) return undefined;
	return { literal: delimiter.quoted, expands: false, terminator: delimiter.terminator, dash };
}

function readDelimiter(ctx: Ctx): { terminator: string; quoted: boolean } | undefined {
	const source = ctx.source;
	let terminator = "";
	let quoted = false;
	if (ctx.index >= source.length || isWordEnd(source[ctx.index])) {
		ctx.error = true;
		return undefined;
	}
	while (ctx.index < source.length) {
		const current = source[ctx.index];
		if (current === "'") {
			quoted = true;
			ctx.index++;
			const end = source.indexOf("'", ctx.index);
			if (end === -1) {
				ctx.error = true;
				return undefined;
			}
			terminator += source.slice(ctx.index, end);
			ctx.index = end + 1;
			continue;
		}
		if (current === '"') {
			quoted = true;
			ctx.index++;
			while (ctx.index < source.length && source[ctx.index] !== '"') {
				if (source[ctx.index] === "\\" && ctx.index + 1 < source.length) {
					const escaped = source[ctx.index + 1];
					if (escaped === '"' || escaped === "\\" || escaped === "$" || escaped === "`") {
						terminator += escaped;
						ctx.index += 2;
						continue;
					}
					if (escaped === "\n") {
						ctx.index += 2;
						continue;
					}
				}
				terminator += source[ctx.index];
				ctx.index++;
			}
			if (source[ctx.index] !== '"') {
				ctx.error = true;
				return undefined;
			}
			ctx.index++;
			continue;
		}
		if (current === "\\") {
			quoted = true;
			const escaped = source[ctx.index + 1];
			if (escaped === undefined) {
				ctx.error = true;
				return undefined;
			}
			ctx.index += 2;
			if (escaped !== "\n") terminator += escaped;
			continue;
		}
		if (isWordEnd(current)) break;
		terminator += current;
		ctx.index++;
	}
	if (terminator.length === 0) {
		ctx.error = true;
		return undefined;
	}
	return { terminator, quoted };
}

function readRedirect(ctx: Ctx, command: SimpleCommand, pending: PendingHeredoc[]) {
	const source = ctx.source;
	while (source[ctx.index] >= "0" && source[ctx.index] <= "9") ctx.index++;
	if (source[ctx.index] === "<" && source[ctx.index + 1] === "<" && source[ctx.index + 2] === "<") {
		ctx.index += 3;
		skipBlank(ctx);
		const word = readWord(ctx);
		if (!word) {
			ctx.error = true;
			return;
		}
		if (bodyOperandUnsafe(word, "")) {
			command.heredocs.push({ literal: false, expands: true, terminator: "", dash: false });
		}
		return;
	}
	if (source[ctx.index] === "<" && source[ctx.index + 1] === "<") {
		const heredoc = readHeredocOperator(ctx);
		if (!heredoc) {
			ctx.error = true;
			return;
		}
		command.heredocs.push(heredoc);
		pending.push(heredoc);
		return;
	}
	if (source[ctx.index] === "<" && source[ctx.index + 1] === "(") {
		ctx.index += 2;
		const innerExpands = parseList(ctx, ")");
		command.words.push({
			value: "",
			backtick: false,
			param: false,
			arith: false,
			substExpands: innerExpands,
			substCount: 1,
		});
		return;
	}
	if (source[ctx.index] === ">") {
		ctx.index++;
		if (source[ctx.index] === ">" || source[ctx.index] === "|" || source[ctx.index] === "&") ctx.index++;
	} else if (source[ctx.index] === "<") {
		ctx.index++;
		if (source[ctx.index] === ">" || source[ctx.index] === "&") ctx.index++;
	} else {
		ctx.error = true;
		return;
	}
	skipBlank(ctx);
	if (ctx.index < source.length && !isWordEnd(source[ctx.index]) && source[ctx.index] !== "#") {
		if (!readWord(ctx)) ctx.error = true;
	}
}

function readWord(ctx: Ctx): Word | undefined {
	const source = ctx.source;
	if (ctx.index >= source.length || isWordEnd(source[ctx.index])) return undefined;
	const word: Word = { value: "", backtick: false, param: false, arith: false, substExpands: false, substCount: 0 };
	while (ctx.index < source.length && !ctx.error) {
		const current = source[ctx.index];
		if (isWordEnd(current)) break;
		if (current === "\\") {
			const escaped = source[ctx.index + 1];
			if (escaped === undefined) {
				ctx.error = true;
				return undefined;
			}
			ctx.index += 2;
			if (escaped !== "\n") word.value += escaped;
			continue;
		}
		if (current === "'") {
			if (!readSingle(ctx, word)) return undefined;
			continue;
		}
		if (current === '"') {
			ctx.index++;
			if (!readDouble(ctx, word)) return undefined;
			continue;
		}
		if (current === "$") {
			if (!readDollar(ctx, word, false)) return undefined;
			continue;
		}
		if (current === "`") {
			if (!readBacktick(ctx, word)) return undefined;
			continue;
		}
		word.value += current;
		ctx.index++;
	}
	return ctx.error ? undefined : word;
}

function readSingle(ctx: Ctx, word: Word): boolean {
	const source = ctx.source;
	ctx.index++;
	while (ctx.index < source.length && source[ctx.index] !== "'") {
		word.value += source[ctx.index];
		ctx.index++;
	}
	if (source[ctx.index] !== "'") {
		ctx.error = true;
		return false;
	}
	ctx.index++;
	return true;
}

function readDouble(ctx: Ctx, word: Word): boolean {
	const source = ctx.source;
	while (ctx.index < source.length && !ctx.error) {
		const current = source[ctx.index];
		if (current === "\\") {
			const escaped = source[ctx.index + 1];
			if (escaped === undefined) {
				ctx.error = true;
				return false;
			}
			ctx.index += 2;
			if (escaped !== "\n") word.value += escaped;
			continue;
		}
		if (current === '"') {
			ctx.index++;
			return true;
		}
		if (current === "`") {
			if (!readBacktick(ctx, word)) return false;
			continue;
		}
		if (current === "$") {
			if (!readDollar(ctx, word, true)) return false;
			continue;
		}
		word.value += current;
		ctx.index++;
	}
	ctx.error = true;
	return false;
}

function readDollar(ctx: Ctx, word: Word, inDouble: boolean): boolean {
	const next = ctx.source[ctx.index + 1];
	if (next === "(") return readDollarParen(ctx, word);
	if (next === "{") return readBraceParam(ctx, word);
	if (next === "'" && !inDouble) return readAnsi(ctx, word);
	if (next === '"' && !inDouble) {
		ctx.index += 2;
		return readDouble(ctx, word);
	}
	if (next !== undefined && isParamChar(next)) {
		word.param = true;
		ctx.index += 2;
		if (isName(next)) {
			while (ctx.index < ctx.source.length && isNameOrDigit(ctx.source[ctx.index])) ctx.index++;
		}
		return true;
	}
	word.value += "$";
	ctx.index++;
	return true;
}

function readDollarParen(ctx: Ctx, word: Word): boolean {
	if (ctx.source[ctx.index + 2] === "(") {
		word.arith = true;
		return readArithmetic(ctx);
	}
	ctx.index += 2;
	word.substCount++;
	if (parseList(ctx, ")")) word.substExpands = true;
	return !ctx.error;
}

function readArithmetic(ctx: Ctx): boolean {
	const source = ctx.source;
	// Index is on `$`. The first `(` is already open once `$(` is classified as `$((`.
	ctx.index += 2;
	let depth = 1;
	while (ctx.index < source.length) {
		const current = source[ctx.index];
		if (current === "(") {
			depth++;
			ctx.index++;
			continue;
		}
		if (current === ")") {
			depth--;
			ctx.index++;
			if (depth === 0) return true;
			continue;
		}
		if (current === "`" || (current === "$" && source[ctx.index + 1] === "(")) {
			ctx.error = true;
			return false;
		}
		if (current === "\\") ctx.index += 2;
		else ctx.index++;
	}
	ctx.error = true;
	return false;
}

function readBraceParam(ctx: Ctx, word: Word): boolean {
	word.param = true;
	ctx.index += 2;
	let depth = 1;
	const source = ctx.source;
	while (ctx.index < source.length && depth > 0) {
		const current = source[ctx.index];
		if (current === "\\") {
			ctx.index += 2;
			continue;
		}
		if (current === "'" || current === '"') {
			const quote = current;
			ctx.index++;
			while (ctx.index < source.length && source[ctx.index] !== quote) {
				if (source[ctx.index] === "\\") ctx.index += 2;
				else ctx.index++;
			}
			if (source[ctx.index] !== quote) {
				ctx.error = true;
				return false;
			}
			ctx.index++;
			continue;
		}
		if (current === "{") depth++;
		if (current === "}") depth--;
		ctx.index++;
	}
	if (depth !== 0) {
		ctx.error = true;
		return false;
	}
	return true;
}

function readAnsi(ctx: Ctx, word: Word): boolean {
	const source = ctx.source;
	ctx.index += 2;
	while (ctx.index < source.length) {
		const current = source[ctx.index];
		if (current === "\\") {
			const escaped = source[ctx.index + 1];
			if (escaped === undefined) {
				ctx.error = true;
				return false;
			}
			word.value += escaped === "n" ? "\n" : escaped === "t" ? "\t" : escaped;
			ctx.index += 2;
			continue;
		}
		if (current === "'") {
			ctx.index++;
			return true;
		}
		word.value += current;
		ctx.index++;
	}
	ctx.error = true;
	return false;
}

function readBacktick(ctx: Ctx, word: Word): boolean {
	word.backtick = true;
	ctx.index++;
	const inner = takeBacktick(ctx);
	if (inner === undefined) return false;
	const nested = parseNested(inner, ctx.commands);
	if (nested.error) {
		ctx.error = true;
		return false;
	}
	if (nested.expands) word.substExpands = true;
	return true;
}

function takeBacktick(ctx: Ctx): string | undefined {
	const source = ctx.source;
	let inner = "";
	while (ctx.index < source.length) {
		const current = source[ctx.index];
		if (current === "\\" && ctx.index + 1 < source.length) {
			const escaped = source[ctx.index + 1];
			if (escaped === "\\" || escaped === "$" || escaped === "`" || escaped === "\n") {
				if (escaped !== "\n") inner += escaped;
				ctx.index += 2;
				continue;
			}
		}
		if (current === "`") {
			ctx.index++;
			return inner;
		}
		inner += current;
		ctx.index++;
	}
	ctx.error = true;
	return undefined;
}

function parseNested(source: string, commands: SimpleCommand[]): { expands: boolean; error: boolean } {
	const ctx: Ctx = { source, index: 0, error: false, commands };
	const expands = parseList(ctx, null);
	return { expands, error: ctx.error };
}

interface BodyFlag {
	kind: "body" | "file";
	word: Word;
	prefix: string;
	stdin: boolean;
	next: number;
}

function ghBodyExpands(command: SimpleCommand, commands: SimpleCommand[], commandIndex: number): boolean {
	const words = command.words;
	let index = 0;
	while (index < words.length && isAssignment(words[index].value)) index++;
	if (words[index]?.value === "!") index++;
	const name = words[index];
	const group = words[index + 1];
	const sub = words[index + 2];
	if (!name || name.value !== "gh" || !group || !sub) return false;
	if (bodyOperandUnsafe(group, "") || bodyOperandUnsafe(sub, "")) return true;
	if (!MUTATION_GROUP.has(group.value) || !MUTATION_SUB.has(sub.value)) return false;
	let stdin = false;
	let cursor = index + 3;
	while (cursor < words.length) {
		const flag = readBodyFlag(words, cursor);
		if (!flag) {
			cursor++;
			continue;
		}
		if (flag.kind === "file") {
			if (flag.stdin) stdin = true;
		} else if (bodyOperandUnsafe(flag.word, flag.prefix)) return true;
		cursor = flag.next;
	}
	if (stdin && pipelineExpands(commands, commandIndex)) return true;
	for (const heredoc of command.heredocs) {
		if (heredoc.expands) return true;
	}
	return false;
}

function readBodyFlag(words: Word[], cursor: number): BodyFlag | undefined {
	return fileFlag(words, cursor) ?? bodyFlag(words, cursor);
}

function fileFlag(words: Word[], cursor: number): BodyFlag | undefined {
	const word = words[cursor];
	const value = word.value;
	if (value === "--body-file" || value === "-F") {
		if (!wordHasSyntax(word)) return separateFile(words, cursor);
		const prefix = value === "--body-file" ? "--body-file" : "-F";
		return { kind: "file", word, prefix, stdin: isPlainDash(word, value.slice(prefix.length)), next: cursor + 1 };
	}
	const prefix = longPrefix(value, "--body-file=") ?? shortPrefix(value, "F");
	if (!prefix) return undefined;
	const path = value.slice(prefix.length);
	return { kind: "file", word, prefix, stdin: isPlainDash(word, path), next: cursor + 1 };
}

function bodyFlag(words: Word[], cursor: number): BodyFlag | undefined {
	const word = words[cursor];
	const value = word.value;
	if (value === "--body" || value === "-b") {
		if (!wordHasSyntax(word)) return separateBody(words, cursor);
		const prefix = value === "--body" ? "--body" : "-b";
		return { kind: "body", word, prefix, stdin: false, next: cursor + 1 };
	}
	if (value.startsWith("--body=")) return { kind: "body", word, prefix: "--body=", stdin: false, next: cursor + 1 };
	const prefix = shortPrefix(value, "b");
	if (!prefix) return undefined;
	return { kind: "body", word, prefix, stdin: false, next: cursor + 1 };
}

function separateFile(words: Word[], cursor: number): BodyFlag {
	const operand = words[cursor + 1];
	if (!operand) return { kind: "file", word: words[cursor], prefix: "", stdin: false, next: cursor + 1 };
	return { kind: "file", word: operand, prefix: "", stdin: isPlainDash(operand, operand.value), next: cursor + 2 };
}

function separateBody(words: Word[], cursor: number): BodyFlag {
	const operand = words[cursor + 1];
	if (!operand) return { kind: "body", word: words[cursor], prefix: "", stdin: false, next: cursor + 1 };
	return { kind: "body", word: operand, prefix: "", stdin: false, next: cursor + 2 };
}

function longPrefix(value: string, prefix: string): string | undefined {
	return value.startsWith(prefix) ? prefix : undefined;
}

function shortPrefix(value: string, letter: string): string | undefined {
	if (value.startsWith("--") || !value.startsWith(`-${letter}`) || value.length <= 2) return undefined;
	return value[2] === "=" ? `-${letter}=` : `-${letter}`;
}

function wordHasSyntax(word: Word): boolean {
	return word.backtick || word.param || word.arith || word.substExpands || word.substCount > 0;
}

function isPlainDash(word: Word, path: string): boolean {
	return path === "-" && !word.backtick && !word.param && !word.arith && !word.substExpands && word.substCount === 0;
}

function pipelineExpands(commands: SimpleCommand[], index: number): boolean {
	let start = index;
	while (start > 0 && commands[start].pipe) start--;
	let cursor = start;
	while (cursor < index) {
		if (commandFeedsBody(commands[cursor])) return true;
		cursor++;
	}
	return false;
}

function commandFeedsBody(command: SimpleCommand): boolean {
	for (const word of command.words) {
		if (bodyOperandUnsafe(word, "")) return true;
	}
	for (const heredoc of command.heredocs) {
		if (heredoc.expands) return true;
	}
	return false;
}

function bodyOperandUnsafe(word: Word, prefix: string): boolean {
	if (word.backtick || word.param || word.arith || word.substExpands) return true;
	if (word.substCount !== 1) return word.substCount > 1;
	const literal = prefix.length > 0 && word.value.startsWith(prefix) ? word.value.slice(prefix.length) : word.value;
	return literal.length !== 0;
}

function isAssignment(value: string): boolean {
	return /^[A-Za-z_][A-Za-z0-9_]*=/.test(value);
}

function startsRedirect(ctx: Ctx): boolean {
	const source = ctx.source;
	let index = ctx.index;
	while (source[index] >= "0" && source[index] <= "9") index++;
	return source[index] === "<" || source[index] === ">";
}

function isSeparator(ctx: Ctx): boolean {
	const current = ctx.source[ctx.index];
	const next = ctx.source[ctx.index + 1];
	if (current === "&" && next === ">") return false;
	return current === ";" || current === "&" || current === "|";
}

function consumeSeparator(ctx: Ctx): boolean {
	const current = ctx.source[ctx.index];
	const next = ctx.source[ctx.index + 1];
	if (current === "&" && next === "&") {
		ctx.index += 2;
		return false;
	}
	if (current === "|" && next === "|") {
		ctx.index += 2;
		return false;
	}
	if (current === "|" && next === "&") {
		ctx.index += 2;
		return true;
	}
	if (current === "|") {
		ctx.index++;
		return true;
	}
	ctx.index++;
	return false;
}

function skipReserved(ctx: Ctx, command: SimpleCommand | undefined): boolean {
	if (command && (command.words.length > 0 || command.heredocs.length > 0)) return false;
	if (bareWord(ctx, "!")) {
		ctx.index++;
		return true;
	}
	for (const word of RESERVED) {
		if (!bareWord(ctx, word)) continue;
		ctx.index += word.length;
		return true;
	}
	return false;
}

function bareWord(ctx: Ctx, word: string): boolean {
	if (!ctx.source.startsWith(word, ctx.index)) return false;
	const next = ctx.source[ctx.index + word.length];
	return next === undefined || isWordEnd(next) || next === "#";
}

function skipBlank(ctx: Ctx) {
	const source = ctx.source;
	while (source[ctx.index] === " " || source[ctx.index] === "\t") ctx.index++;
}

function skipComment(ctx: Ctx) {
	while (ctx.index < ctx.source.length && ctx.source[ctx.index] !== "\n") ctx.index++;
}

function isWordEnd(char: string | undefined): boolean {
	return (
		char === undefined ||
		char === " " ||
		char === "\t" ||
		char === "\n" ||
		char === ";" ||
		char === "|" ||
		char === "&" ||
		char === "(" ||
		char === ")" ||
		char === "<" ||
		char === ">"
	);
}

function isParamChar(char: string): boolean {
	return (
		isName(char) ||
		isDigit(char) ||
		char === "@" ||
		char === "*" ||
		char === "#" ||
		char === "?" ||
		char === "!" ||
		char === "-" ||
		char === "$"
	);
}

function isNameOrDigit(char: string): boolean {
	return isName(char) || isDigit(char);
}

function isName(char: string): boolean {
	return (char >= "A" && char <= "Z") || (char >= "a" && char <= "z") || char === "_";
}

function isDigit(char: string): boolean {
	return char >= "0" && char <= "9";
}
