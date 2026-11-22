import { strict as assert } from "node:assert";
import { $ } from "bun";

// Run after opening the Retention policy form in manual-ui.ts inside an isolated Tern window:
// bun test/tern-layout.ts <control-port>
// This checks rendered geometry, not the component's declared role or source text.
interface LayoutElement {
	class?: string;
	text?: string;
	rect: [number, number, number, number];
	children?: LayoutElement[];
}

const port = process.argv[2];
assert.ok(port, "Pass the isolated Tern control port");
const result = await $`tern ctl --control ${port} tree`.quiet();
const reply: { ok: boolean; tree: LayoutElement[] } = JSON.parse(result.text());
assert.equal(reply.ok, true, "Tern must return the rendered option tree");
function optionsFrom(nodes: LayoutElement[]): LayoutElement[] {
	return nodes.flatMap(node =>
		node.class?.split(" ").includes("sf-item") ? [node] : optionsFrom(node.children ?? []),
	);
}
const options = optionsFrom(reply.tree);
assert.equal(options.length, 3, "The retention form must expose both choices and Other");
for (const option of options) {
	const label = option.children?.find(child => child.class === "sf-item-label");
	assert.ok(label, "Each option must have a visible label");
	// Tern's Ask marker occupies x=12..28 within the row; labels need a separate gutter.
	assert.ok(label.rect[0] - option.rect[0] >= 30, `${label.text}: label overlaps the radio marker`);
	assert.ok(
		label.rect[1] >= option.rect[1] && label.rect[1] + label.rect[3] <= option.rect[1] + option.rect[3],
		`${label.text}: label must remain inside its option row`,
	);
}
console.log("Verified three native option labels are separated from their radio markers.");
