import { describe, expect, it } from "vitest";
import factory from "../src/index.js";

/**
 * Wiring smoke test: loads the real extension module (which imports the real
 * `SessionManager` value from @earendil-works/pi-coding-agent) and exercises
 * the factory + command registration + handler guards with stub contexts.
 *
 * Deep search/ranking behaviour is covered by search.test.ts against pure
 * functions; end-to-end jump is a manual test (PRD §10).
 */

type Cmd = { description?: string; handler: (args: string, ctx: any) => Promise<void> };

function loadCommand(): Cmd {
	const cmds: Record<string, Cmd> = {};
	const pi = { registerCommand: (name: string, opts: Cmd) => (cmds[name] = opts) };
	factory(pi as any);
	return cmds.find;
}

describe("extension wiring", () => {
	it("registers a /find command with a description", () => {
		const find = loadCommand();
		expect(typeof find.handler).toBe("function");
		expect(find.description).toBeTruthy();
	});

	it("no-ops with an info notify when UI is unavailable (print/json)", async () => {
		const find = loadCommand();
		const notes: string[] = [];
		const ctx = { hasUI: false, mode: "print", ui: { notify: (m: string) => notes.push(m) } };
		await find.handler("anything", ctx);
		expect(notes).toHaveLength(1);
		expect(notes[0]).toMatch(/interactive mode/);
	});

	it("prompts for a query when called with no args and cancels cleanly on empty input", async () => {
		const find = loadCommand();
		const ctx = {
			hasUI: true,
			mode: "tui",
			ui: { input: async () => undefined, notify: () => {}, setStatus: () => {} },
		};
		// Empty/cancelled input → handler returns without touching sessions.
		await expect(find.handler("", ctx)).resolves.toBeUndefined();
	});
});
