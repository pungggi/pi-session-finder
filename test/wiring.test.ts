import { afterEach, describe, expect, it } from "vitest";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import factory from "../src/index.js";

/**
 * Wiring smoke test: loads the real extension module (which imports the real
 * `SessionManager` value from @earendil-works/pi-coding-agent) and exercises
 * the factory + command registration + handler guards with stub contexts.
 *
 * Deep search/ranking behaviour is covered by search.test.ts against pure
 * functions; back-stack logic is covered by history.test.ts; end-to-end jump
 * is a manual test (PRD §10).
 */

type Cmd = { description?: string; handler: (args: string, ctx: any) => Promise<void> };

function loadCommands(): Record<string, Cmd> {
	const cmds: Record<string, Cmd> = {};
	const pi = {
		registerCommand: (name: string, opts: Cmd) => (cmds[name] = opts),
		on: () => {
			/* session_start handler registration — exercised manually/integration */
		},
	};
	factory(pi as any);
	return cmds;
}

/** Point PI_CODING_AGENT_DIR at a fresh temp dir so /find-back tests never touch
 *  the real `~/.pi/agent`. Returns the dir; caller restores via the closure. */
function withTempAgentDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
	const dir = mkdtempSync(join(tmpdir(), "pi-find-back-"));
	const prev = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	return fn(dir).finally(() => {
		process.env.PI_CODING_AGENT_DIR = prev;
		rmSync(dir, { recursive: true, force: true });
	});
}

function seedStack(dir: string, stack: string[]): void {
	mkdirSync(join(dir, "session-finder"), { recursive: true });
	writeFileSync(
		join(dir, "session-finder", "backstack.json"),
		JSON.stringify({ stack, suppressNext: false }),
		"utf8",
	);
}

function readStack(dir: string): { stack: string[]; suppressNext: boolean } {
	return JSON.parse(readFileSync(join(dir, "session-finder", "backstack.json"), "utf8"));
}

afterEach(() => {
	// Defensive: never leak the override into another suite if a test threw early.
	delete process.env.PI_CODING_AGENT_DIR;
});

describe("extension wiring", () => {
	it("registers a /find command with a description", () => {
		const find = loadCommands().find;
		expect(typeof find.handler).toBe("function");
		expect(find.description).toBeTruthy();
	});

	it("registers a /find-back command with a description", () => {
		const back = loadCommands()["find-back"];
		expect(typeof back.handler).toBe("function");
		expect(back.description).toMatch(/back/i);
	});

	it("no-ops with an info notify when UI is unavailable (print/json)", async () => {
		const find = loadCommands().find;
		const notes: string[] = [];
		const ctx = { hasUI: false, mode: "print", ui: { notify: (m: string) => notes.push(m) } };
		await find.handler("anything", ctx);
		expect(notes).toHaveLength(1);
		expect(notes[0]).toMatch(/interactive mode/);
	});

	it("prompts for a query when called with no args and cancels cleanly on empty input", async () => {
		const find = loadCommands().find;
		const ctx = {
			hasUI: true,
			mode: "tui",
			ui: { input: async () => undefined, notify: () => {}, setStatus: () => {} },
		};
		// Empty/cancelled input → handler returns without touching sessions.
		await expect(find.handler("", ctx)).resolves.toBeUndefined();
	});
});

describe("/find-back wiring", () => {
	it("no-ops with an info notify when UI is unavailable", async () => {
		const back = loadCommands()["find-back"];
		const notes: string[] = [];
		await back.handler("", { hasUI: false, ui: { notify: (m: string) => notes.push(m) } });
		expect(notes).toEqual([expect.stringMatching(/interactive mode/i)]);
	});

	it("notifies 'No session to go back to' when the stack is empty", async () => {
		const back = loadCommands()["find-back"];
		const notes: string[] = [];
		await withTempAgentDir(async () => {
			const ctx = { hasUI: true, ui: { notify: (m: string) => notes.push(m) } };
			await back.handler("", ctx);
		});
		expect(notes).toEqual([expect.stringMatching(/no session to go back/i)]);
	});

	it("pops the recorded session and switches to it; arms suppression on disk", async () => {
		const back = loadCommands()["find-back"];
		const notes: string[] = [];
		let switchedTo: string | null = null;
		await withTempAgentDir(async (dir) => {
			const target = join(dir, "prev-session.jsonl");
			writeFileSync(target, "", "utf8");
			seedStack(dir, [target]);

			const ctx = {
				hasUI: true,
				ui: { notify: (m: string) => notes.push(m) },
				switchSession: async (t: string, opts: any) => {
					switchedTo = t;
					if (opts?.withSession) await opts.withSession({ ui: { notify: (m: string) => notes.push(m) } });
					return { cancelled: false };
				},
			};
			await back.handler("", ctx);

			expect(switchedTo).toBe(target);
			// Stack committed empty + suppress armed (the real session_start clears it).
			const persisted = readStack(dir);
			expect(persisted.stack).toEqual([]);
			expect(persisted.suppressNext).toBe(true);
		});
		expect(notes).toContain("Back to previous session");
	});

	it("restores the entry and notifies when the switch is vetoed", async () => {
		const back = loadCommands()["find-back"];
		const notes: string[] = [];
		await withTempAgentDir(async (dir) => {
			const target = join(dir, "prev-session.jsonl");
			writeFileSync(target, "", "utf8");
			seedStack(dir, [target]);

			const ctx = {
				hasUI: true,
				ui: { notify: (m: string) => notes.push(m) },
				switchSession: async () => ({ cancelled: true }),
			};
			await back.handler("", ctx);

			// Entry restored, suppress cleared.
			const persisted = readStack(dir);
			expect(persisted.stack).toEqual([target]);
			expect(persisted.suppressNext).toBe(false);
		});
		expect(notes).toContain("Back cancelled");
	});

	it("skips stale (deleted) entries from the top", async () => {
		const back = loadCommands()["find-back"];
		let switchedTo: string | null = null;
		await withTempAgentDir(async (dir) => {
			const live = join(dir, "live.jsonl");
			writeFileSync(live, "", "utf8");
			// Top entry deleted, one below exists.
			seedStack(dir, [live, join(dir, "gone.jsonl")]);

			const ctx = {
				hasUI: true,
				ui: { notify: () => {} },
				switchSession: async (t: string) => {
					switchedTo = t;
					return { cancelled: false };
				},
			};
			await back.handler("", ctx);

			// Skipped the missing top, landed on the live entry.
			expect(switchedTo).toBe(live);
			expect(existsSync(join(dir, "gone.jsonl"))).toBe(false);
		});
	});
});
