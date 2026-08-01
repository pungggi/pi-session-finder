import { describe, expect, it } from "vitest";
import { FinderComponent } from "../src/finder.js";

/**
 * Integration test for the TUI finder: exercises the REAL @earendil-works/pi-tui
 * Input (filter), fuzzyFilter, and SelectList by feeding raw key sequences to
 * handleInput(). Verifies filter-narrowing, navigation, selection, cancel, and
 * that the preview pane tracks the focused row.
 */

// Minimal stub theme: pass text through unstyled (so assertions can read it).
const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t } as any;

const entries = [
	{
		path: "/a.jsonl",
		header: "stripe webhook debug · A · 1d · 5 msg",
		title: "stripe webhook debug",
		detail: "/projA · 2025-01-01 · 5 messages",
		snippet: "we verified the stripe webhook signature in ApiRouter",
		terms: ["stripe", "webhook"],
	},
	{
		path: "/b.jsonl",
		header: "payments · B · 2d · 3 msg",
		title: "payments",
		detail: "/projB · 2025-01-02 · 3 messages",
		snippet: "stripe integration for local testing",
		terms: ["stripe", "webhook"],
	},
	{
		path: "/c.jsonl",
		header: "unrelated · C · 3d · 1 msg",
		title: "unrelated",
		detail: "/projC · 2025-01-03 · 1 messages",
		snippet: "nothing relevant here",
		terms: ["stripe", "webhook"],
	},
];

/** Type a string into the filter one char at a time (as a real terminal would). */
function type(f: FinderComponent, s: string): void {
	for (const ch of s) f.handleInput(ch);
}

/** Join all rendered lines for substring checks. */
function renderText(f: FinderComponent, width = 80): string {
	return f.render(width).join("\n");
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
		f.handleInput("\r"); // best fuzzy match for "stripe"
		expect(picked).toBe("/a.jsonl"); // header-prefix match beats snippet-only
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

	it("preview pane shows the focused entry and follows ↑/↓", () => {
		const f = new FinderComponent({ title: "t", entries, theme });
		// Initially focused on the first entry → its detail is in the preview.
		expect(renderText(f)).toContain("/projA");
		// Move down → preview switches to the second entry.
		f.handleInput("\x1b[B"); // ↓
		expect(renderText(f)).toContain("/projB");
		expect(renderText(f)).not.toContain("/projA");
	});

	it("preview pane shows the focused entry's title", () => {
		const f = new FinderComponent({ title: "t", entries, theme });
		expect(renderText(f)).toContain("stripe webhook debug"); // entries[0].title
		f.handleInput("\x1b[B"); // ↓
		expect(renderText(f)).toContain("payments"); // entries[1].title
	});

	it("render height is constant across navigation and filtering (no frame drift)", () => {
		const f = new FinderComponent({ title: "t", entries, theme, maxVisible: 8 });
		const base = f.render(80).length;
		expect(base).toBeGreaterThan(0);
		f.handleInput("\x1b[B"); // ↓
		expect(f.render(80).length).toBe(base);
		f.handleInput("\x1b[A"); // ↑
		expect(f.render(80).length).toBe(base);
		type(f, "stripe"); // filter narrows the list below maxVisible
		expect(f.render(80).length).toBe(base);
		type(f, "xyz"); // filter matches nothing (empty list, shorter preview)
		expect(f.render(80).length).toBe(base);
	});
});
