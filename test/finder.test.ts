import { describe, expect, it } from "vitest";
import { FinderComponent } from "../src/finder.js";

/**
 * Integration test for the TUI finder: exercises the REAL @earendil-works/pi-tui
 * Input (filter field), fuzzyFilter, and SelectList by feeding raw key sequences
 * to handleInput(). Verifies filter-narrowing, navigation, selection and cancel.
 */

// Minimal stub theme: pass text through unstyled.
const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t } as any;

const entries = [
	{ path: "/a.jsonl", label: "stripe webhook debug", description: "projectA · 5 msg" },
	{ path: "/b.jsonl", label: "payments", description: "stripe integration · 3 msg" },
	{ path: "/c.jsonl", label: "unrelated", description: "other work" },
];

/** Type a string into the filter one char at a time (as a real terminal would). */
function type(f: FinderComponent, s: string): void {
	for (const ch of s) f.handleInput(ch);
}

describe("FinderComponent", () => {
	it("Enter selects the top entry by default (no filter)", () => {
		const f = new FinderComponent({ title: "t", entries, theme });
		let picked: string | null = null;
		f.onSelect = (p) => (picked = p);
		f.handleInput("\r"); // Enter
		expect(picked).toBe("/a.jsonl");
	});

	it("typing narrows the list via fuzzy filter", () => {
		const f = new FinderComponent({ title: "t", entries, theme });
		let picked: string | null = null;
		f.onSelect = (p) => (picked = p);
		type(f, "stripe");
		f.handleInput("\r"); // Enter → best fuzzy match for "stripe"
		// "stripe webhook debug" (label prefix) ranks above "payments … stripe"
		expect(picked).toBe("/a.jsonl");
	});

	it("filter can narrow to a non-first entry", () => {
		const f = new FinderComponent({ title: "t", entries, theme });
		let picked: string | null = null;
		f.onSelect = (p) => (picked = p);
		type(f, "payments");
		f.handleInput("\r"); // only /b matches "payments"
		expect(picked).toBe("/b.jsonl");
	});

	it("↓ then Enter selects the second entry", () => {
		const f = new FinderComponent({ title: "t", entries, theme });
		let picked: string | null = null;
		f.onSelect = (p) => (picked = p);
		f.handleInput("\x1b[B"); // ↓
		f.handleInput("\r"); // Enter
		expect(picked).toBe("/b.jsonl");
	});

	it("Esc cancels", () => {
		const f = new FinderComponent({ title: "t", entries, theme });
		let cancelled = false;
		f.onCancel = () => (cancelled = true);
		f.handleInput("\x1b"); // Esc
		expect(cancelled).toBe(true);
	});

	it("a filter that matches nothing yields no selection on Enter", () => {
		const f = new FinderComponent({ title: "t", entries, theme });
		let picked: string | undefined = undefined;
		f.onSelect = (p) => (picked = p);
		type(f, "zzzzz");
		f.handleInput("\r");
		expect(picked).toBeUndefined(); // empty filtered list
	});
});
