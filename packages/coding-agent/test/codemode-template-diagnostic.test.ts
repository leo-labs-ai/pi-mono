import { describe, expect, it } from "vitest";
import { executeCodemode } from "../src/extensions/codemode/execute.ts";

describe("codemode syntax diagnostics", () => {
	it("suggests safe markdown writing for a malformed template (#614)", async () => {
		const code = 'await tools.write({path:"/tmp/x.md",content:`# Title\n`code` and ``` fences`})';
		const result = await executeCodemode("syntax", { code }, undefined, undefined, undefined);
		const output = result.content
			.filter((item) => item.type === "text")
			.map((item) => item.text)
			.join("\n");
		expect(result.isError).toBe(true);
		expect(output).toContain("SyntaxError");
		expect(output).toContain("No tool calls were made.");
		expect(output).toContain("escaped backticks");
	});

	it("does not suggest template fixes for unrelated syntax errors", async () => {
		const result = await executeCodemode("syntax", { code: "const = ;" }, undefined, undefined, undefined);
		const output = result.content
			.filter((item) => item.type === "text")
			.map((item) => item.text)
			.join("\n");
		expect(result.isError).toBe(true);
		expect(output).toContain("SyntaxError");
		expect(output).not.toContain("escaped backticks");
	});
});
