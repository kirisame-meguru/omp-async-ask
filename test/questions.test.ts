import { expect, test } from "bun:test";
import { defaultFormData } from "@oh-my-pi/pi-coding-agent/tools/html-form/data";
import { parseHtmlForm } from "@oh-my-pi/pi-coding-agent/tools/html-form/parse";
import { compileQuestions } from "../src/questions";

test("structured questions compile to a native form with recommendations as defaults", () => {
	const html = compileQuestions([
		{ id: "store", prompt: "Session store", options: [
			{ value: "sqlite", label: "SQLite", detail: "one file" }, { value: "redis", label: "Redis" },
		], recommended: "sqlite" },
		{ id: "features", prompt: "Features", kind: "multi", options: [{ value: "a" }, { value: "b" }], recommended: ["a", "b"] },
		{ id: "ttl", prompt: "Lifetime <days>", kind: "number", recommended: 30 },
		{ id: "notes", prompt: "Notes", kind: "longtext" },
	], "Sessions are lost on restart.\n\nPick one.");
	expect(html).toContain("Lifetime &lt;days&gt;");
	const form = parseHtmlForm(html);
	expect(form.fields.map(field => field.name)).toEqual(["store", "features", "ttl", "notes"]);
	expect(defaultFormData(form)).toMatchObject({ store: "sqlite", features: ["a", "b"], ttl: 30 });
});

test("malformed questions are rejected with actionable errors", () => {
	const option = [{ value: "a" }, { value: "b" }];
	expect(() => compileQuestions([])).toThrow("At least one");
	expect(() => compileQuestions([{ id: "x", prompt: "X" }, { id: "x", prompt: "Y" }])).toThrow("repeated");
	expect(() => compileQuestions([{ id: "1x", prompt: "X" }])).toThrow("identifier");
	expect(() => compileQuestions([{ id: "x", prompt: "X", kind: "single", options: [{ value: "a" }] }])).toThrow("two options");
	expect(() => compileQuestions([{ id: "x", prompt: "X", options: option, recommended: "c" }])).toThrow("unknown option");
	expect(() => compileQuestions([{ id: "x", prompt: "X", options: option, recommended: ["a", "b"] }])).toThrow("single");
	expect(() => compileQuestions([{ id: "x", prompt: "X", kind: "text", options: option }])).toThrow("kind text");
});
