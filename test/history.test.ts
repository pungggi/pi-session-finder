import { describe, expect, it } from "vitest";
import {
	MAX_BACK_DEPTH,
	applySessionStart,
	dropMissingTop,
	emptyState,
	popForBack,
	type BackState,
} from "../src/history.js";

/**
 * Unit tests for the pure back-navigation logic (history.ts). Covers push,
 * dedup, depth cap, ping-pong suppression, pop, and stale-entry cleanup — the
 * tricky correctness pieces, independent of the on-disk store.
 */

describe("applySessionStart — recording switches", () => {
	it("records the previous session on a real switch (resume)", () => {
		const s = applySessionStart(emptyState(), "/proj/a/session.jsonl");
		expect(s.stack).toEqual(["/proj/a/session.jsonl"]);
		expect(s.suppressNext).toBe(false);
	});

	it("ignores startup/reload (no previousSessionFile)", () => {
		expect(applySessionStart(emptyState(), undefined)).toEqual(emptyState());
		expect(applySessionStart({ stack: ["x"], suppressNext: false }, null)).toEqual({
			stack: ["x"],
			suppressNext: false,
		});
	});

	it("records new/resume/fork but treats them identically (caller filters reason)", () => {
		// The handler passes previousFile for new/resume/fork; logic doesn't care which.
		let s = applySessionStart(emptyState(), "a");
		s = applySessionStart(s, "b");
		expect(s.stack).toEqual(["a", "b"]);
	});

	it("does not push a repeat of the current top", () => {
		const s0: BackState = { stack: ["a"], suppressNext: false };
		const s = applySessionStart(s0, "a");
		expect(s.stack).toEqual(["a"]); // unchanged
		expect(s).toBe(s0); // same reference — lets the handler skip a pointless write
	});

	it("returns the same reference on a no-op (startup/reload) so callers skip writes", () => {
		const s0: BackState = { stack: ["a"], suppressNext: false };
		expect(applySessionStart(s0, undefined)).toBe(s0);
		expect(applySessionStart(s0, null)).toBe(s0);
	});

	it("caps the stack at MAX_BACK_DEPTH, dropping the oldest", () => {
		let s = emptyState();
		for (let i = 0; i < MAX_BACK_DEPTH; i++) s = applySessionStart(s, `s${i}`);
		expect(s.stack).toHaveLength(MAX_BACK_DEPTH);
		expect(s.stack[0]).toBe("s0");

		// One more pushes the newest and evicts the oldest (bottom).
		s = applySessionStart(s, `s${MAX_BACK_DEPTH}`);
		expect(s.stack).toHaveLength(MAX_BACK_DEPTH);
		expect(s.stack[0]).toBe("s1");
		expect(s.stack[s.stack.length - 1]).toBe(`s${MAX_BACK_DEPTH}`);
	});
});

describe("applySessionStart — ping-pong suppression", () => {
	it("consumes an armed suppressNext and records nothing", () => {
		const armed: BackState = { stack: ["a", "b"], suppressNext: true };
		// /find-back's own switch fires session_start with previous = "c"; it must
		// NOT be recorded, and the flag is cleared.
		const s = applySessionStart(armed, "c");
		expect(s.stack).toEqual(["a", "b"]);
		expect(s.suppressNext).toBe(false);
	});

	it("suppresses even when previousFile is undefined (e.g. /new right after)", () => {
		const armed: BackState = { stack: ["a"], suppressNext: true };
		const s = applySessionStart(armed, undefined);
		expect(s.stack).toEqual(["a"]);
		expect(s.suppressNext).toBe(false);
	});

	it("resumes normal recording after the flag is consumed once", () => {
		let s: BackState = { stack: ["a"], suppressNext: true };
		s = applySessionStart(s, "ignored-by-suppress");
		expect(s.stack).toEqual(["a"]);
		s = applySessionStart(s, "next-real-jump");
		expect(s.stack).toEqual(["a", "next-real-jump"]);
	});
});

describe("popForBack", () => {
	it("pops the most recent entry and arms suppression", () => {
		const s0: BackState = { stack: ["a", "b", "c"], suppressNext: false };
		const popped = popForBack(s0);
		expect(popped).not.toBeNull();
		expect(popped!.target).toBe("c");
		expect(popped!.state.stack).toEqual(["a", "b"]);
		expect(popped!.state.suppressNext).toBe(true);
	});

	it("returns null when the stack is empty", () => {
		expect(popForBack(emptyState())).toBeNull();
	});

	it("does not mutate the input state", () => {
		const s0: BackState = { stack: ["a", "b"], suppressNext: false };
		popForBack(s0);
		expect(s0.stack).toEqual(["a", "b"]);
		expect(s0.suppressNext).toBe(false);
	});
});

describe("dropMissingTop", () => {
	it("removes only missing entries from the top", () => {
		const exists = (p: string) => !p.includes("gone");
		const s0: BackState = { stack: ["a", "gone1", "gone2"], suppressNext: false };
		const s = dropMissingTop(s0, exists);
		expect(s.stack).toEqual(["a"]);
	});

	it("keeps missing entries below an existing one (only trims the top)", () => {
		const exists = (p: string) => p !== "gone";
		const s0: BackState = { stack: ["gone", "b", "c"], suppressNext: false };
		// top "c" exists → stop immediately, even though "gone" sits below.
		expect(dropMissingTop(s0, exists).stack).toEqual(["gone", "b", "c"]);
	});

	it("returns the same reference when nothing was removed (skip pointless write)", () => {
		const s0: BackState = { stack: ["a", "b"], suppressNext: false };
		expect(dropMissingTop(s0, () => true)).toBe(s0);
	});

	it("empties an all-missing stack", () => {
		const s0: BackState = { stack: ["x", "y"], suppressNext: false };
		expect(dropMissingTop(s0, () => false).stack).toEqual([]);
	});
});

describe("end-to-end back flow (pure)", () => {
	it("models a full /find → /find-back → /find-back-again sequence", () => {
		// Start in A; /find jumps to B, then to C.
		let s = emptyState();
		s = applySessionStart(s, "/A.jsonl"); // A→B
		s = applySessionStart(s, "/B.jsonl"); // B→C
		expect(s.stack).toEqual(["/A.jsonl", "/B.jsonl"]);

		// /find-back from C: pop B, arm suppress, then its switch is suppressed.
		let popped = popForBack(s)!;
		expect(popped.target).toBe("/B.jsonl");
		s = applySessionStart(popped.state, "/C.jsonl"); // the back-jump itself
		expect(s.stack).toEqual(["/A.jsonl"]); // C not recorded (suppressed)
		expect(s.suppressNext).toBe(false);

		// /find-back again from B: pop A.
		popped = popForBack(s)!;
		expect(popped.target).toBe("/A.jsonl");
		s = applySessionStart(popped.state, "/B.jsonl");
		expect(s.stack).toEqual([]); // B not recorded (suppressed)

		// Third back: nothing left.
		expect(popForBack(s)).toBeNull();
	});
});
