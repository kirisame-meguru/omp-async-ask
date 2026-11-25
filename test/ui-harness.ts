import type { ExtensionUiHost } from "@oh-my-pi/pi-coding-agent";
import { signal, type UiEvent, type UiNode } from "@oh-my-pi/pi-tui";
import { bubbleEvent, keypathOf, pathTo } from "@oh-my-pi/pi-tui/dispatch";
import { createTestTerminal, type TestTerminal } from "@oh-my-pi/pi-tui/testing/terminal";

/** Actual 19.2.1 nodes, shared semantic dispatcher and terminal backend; no legacy component adapter. */
export class UiHarness {
	readonly terminal: TestTerminal;
	readonly root: UiNode;
	readonly size = signal({ columns: 100, rows: 30 });
	readonly host: ExtensionUiHost = {
		size: this.size,
		requestRender: () => this.terminal?.render(),
		suspend: run => run(),
	};
	constructor(factory: (host: ExtensionUiHost) => UiNode) {
		let root!: UiNode;
		this.terminal = createTestTerminal(() => ({ dock: root = factory(this.host) }), { columns: 100, rows: 30 });
		this.root = root;
		this.terminal.focus(root);
	}
	findAll(predicate: (node: UiNode) => boolean): UiNode[] {
		const result: UiNode[] = [];
		const visit = (node: UiNode) => {
			if (predicate(node)) result.push(node);
			for (const child of node.children()) visit(child);
		};
		visit(this.root);
		return result;
	}
	find(predicate: (node: UiNode) => boolean): UiNode {
		const found = this.findAll(predicate)[0];
		if (!found) throw new Error("Expected UI node not found");
		return found;
	}
	event(node: UiNode, event: UiEvent): boolean {
		const path = pathTo([this.root], node);
		if (!path.length) return false;
		const handled = bubbleEvent(path, { ...event, key: keypathOf(path) });
		this.terminal.render();
		return handled;
	}
	action(node: UiNode, act: string): void {
		this.event(node, { type: "action", key: "", act, mods: [] });
	}
	snapshot(): string {
		const visit = (node: UiNode): unknown => {
			const { term: _term, ...props } = node.props() as Record<string, unknown>;
			return { kind: node.kind, key: node.key(), props, children: node.children().map(visit) };
		};
		return JSON.stringify(visit(this.root));
	}
	resize(rows: number): void {
		this.size.set({ columns: 100, rows });
		this.terminal.resize(100, rows);
	}
	dispose(): void { this.terminal.dispose(); }
}
