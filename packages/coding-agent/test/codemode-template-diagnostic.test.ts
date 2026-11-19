import { describe, expect, it } from "vitest";
import { executeCodemode } from "../src/extensions/codemode/execute.ts";

describe("codemode syntax diagnostics", () => {
	it.each([
		'await tools.write({path:"notes.md",content:`# Title\n`code` and ``` fences`})',
		"const markdown = `# Title\n`code``;",
	])("suggests safe markdown writing for a malformed template (#614): %s", async (code) => {
		const result = await executeCodemode("syntax", { code }, undefined, undefined, undefined);
		const output = result.content
			.filter((item) => item.type === "text")
			.map((item) => item.text)
			.join("\n");
		expect(result.isError).toBe(true);
		expect(output).toMatch(/SyntaxError: .+/);
		expect(output).toContain("codemode.js:");
		expect(output).toContain("No tool calls were made.");
		expect(output).toContain("escaped backticks");
	});

	it.each([
		"const value = '`'; const = ;",
		"const content = '`'; const = ;",
		"const note = `# Title\n`code``;",
		"const content = `# Title`; JSON.parse('invalid JSON');",
	])("does not suggest template fixes for unrelated error: %s", async (code) => {
		const result = await executeCodemode("syntax", { code }, undefined, undefined, undefined);
		const output = result.content
			.filter((item) => item.type === "text")
			.map((item) => item.text)
			.join("\n");
		expect(result.isError).toBe(true);
		expect(output).toContain("SyntaxError");
		expect(output).not.toContain("escaped backticks");
	});
});
