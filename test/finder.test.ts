import { describe, expect, it } from "vitest";
import { CURSOR_MARKER } from "@earendil-works/pi-tui";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { FinderComponent } from "../src/finder.js";
import type { SessionDetail } from "../src/parse.js";

// The preview renders snippets through pi's Markdown component, whose theme
// functions read the global theme — initialize it once for this suite.
initTheme();

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

	it("render height is stable across navigation (same match set)", () => {
		// Height tracks content, so it's constant while the match set is fixed
		// (navigation) but changes when filtering narrows results. The real
		// invariant — no embedded newlines / control chars — is covered below.
		const f = new FinderComponent({ title: "t", entries, theme, maxVisible: 8 });
		const base = f.render(80).length;
		expect(base).toBeGreaterThan(0);
		f.handleInput("\x1b[B"); // ↓
		expect(f.render(80).length).toBe(base);
		f.handleInput("\x1b[A"); // ↑
		expect(f.render(80).length).toBe(base);
	});

	it("never emits a CURSOR_MARKER (would make ctx.ui.custom redraw leave stale rows)", () => {
		const f = new FinderComponent({ title: "t", entries, theme });
		type(f, "stripe");
		f.handleInput("\x1b[B");
		const out = f.render(80).join("\n");
		expect(out).not.toContain(CURSOR_MARKER);
	});

	it("REGRESSION: collapses embedded newlines in session text to one row per line", () => {
		// Real session text (first user line) can contain blank lines / newlines.
		// A rendered "line" with an embedded \n desyncs pi's differential renderer
		// (it treats each array entry as one physical row) and stacks stale frames.
		const multiline = [
			{
				path: "/m.jsonl",
				header: "check @PRD and @RESEARCH\n\nwhat can we · pkg · 5h · 2 msg",
				title: "check @PRD\nand\t@RESEARCH",
				detail: "/projM\n· 2025-01-04",
				snippet: "line one\n\nline two\tline three",
				terms: ["prD"],
			},
		];
		const f = new FinderComponent({ title: "t", entries: multiline, theme });
		const rows = f.render(80);
		// No single rendered row may contain a newline or other control char.
		for (const row of rows) {
			expect(row).not.toMatch(/[\u0000-\u001f\u007f]/);
		}
		// And the label row keeps the post-newline text on the SAME row.
		const labels = rows.filter((r) => r.includes("what can we"));
		expect(labels.length).toBe(1);
		// Navigation must not drift height once newlines are collapsed.
		const base = rows.length;
		f.handleInput("\x1b[B");
		expect(f.render(80).length).toBe(base);
	});

	it("targetHeight fills the terminal: list + snippet budget == target (nav-stable)", () => {
		const many = Array.from({ length: 50 }, (_, i) => ({
			path: `/p${i}.jsonl`,
			header: `sess ${i} · proj · ${i}m · ${i} msg`,
			title: `session ${i}`,
			detail: `/proj · 2025-01-01 · ${i} messages`,
			snippet: "lorem ipsum ".repeat(200), // plenty to fill the snippet budget
			terms: ["lorem"],
		}));
		const f = new FinderComponent({ title: "t", entries: many, theme, targetHeight: 30 });
		const h = f.render(80).length;
		expect(h).toBe(30); // chrome(6) + list + snippet budget == targetHeight
		f.handleInput("\x1b[B"); // navigation must not drift height
		expect(f.render(80).length).toBe(h);
	});

	it("renders the preview snippet as markdown (headings/lists/tables keep structure)", () => {
		const md = [
			{
				path: "/m.jsonl",
				header: "capacities · proj · 1m · 2 msg",
				title: "Capacities research",
				detail: "/proj · 2025-01-01 · 2 messages",
				snippet:
					"# Capacities object model\n\n" +
					"| You create | It becomes |\n|---|---|\n| Meeting notes | Meeting object |\n\n" +
					"- left sidebar = object types\n- no folder hierarchy\n\n" +
					"**Bottom line:** the PRD is solid.",
				terms: ["capacities"],
			},
		];
		const f = new FinderComponent({ title: "t", entries: md, theme, targetHeight: 30 });
		const rows = f.render(80);
		const out = rows.join("\n");
		expect(out).toContain("Capacities object model"); // heading rendered
		expect(out).toContain("left sidebar = object types"); // list item rendered
		expect(out).toContain("Meeting object"); // table cell rendered
		// Renderer-safe: no array entry may carry an embedded newline (the desync bug).
		for (const row of rows) expect(row).not.toMatch(/[\n\r]/);
	});
});

// ── rich facets (item 1) ─────────────────────────────────────────

describe("FinderComponent — rich facets", () => {
	/** Flush the loadDetail promise chain (.then → .catch → .finally). */
	const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

	const detail: SessionDetail = {
		recap: {
			intent: "x",
			lastAction: "edit a.ts",
			lastActionKind: "tool",
			outcome: "landed",
			messageCount: 2,
		},
		locator: null,
		facets: {
			models: ["anthropic/claude-3.5-sonnet", "openai/gpt-4o"],
			toolCalls: [
				{ name: "bash", count: 5 },
				{ name: "edit", count: 3 },
			],
			filesModified: ["src/retry.ts", "test/retry.test.ts"],
			totalCost: 0.42,
			totalTokens: 1234567,
		},
	};

	it("renders a 'loading' line, then the facet lines once loadDetail resolves", async () => {
		const f = new FinderComponent({
			title: "t",
			entries,
			theme,
			loadDetail: (p) => Promise.resolve(p === "/a.jsonl" ? detail : null),
		});
		f.requestRender = () => {};
		expect(f.render(80).join("\n")).toContain("loading"); // /a.jsonl in flight
		await flush();
		const out = f.render(80).join("\n");
		expect(out).toContain("Models: anthropic/claude-3.5-sonnet, openai/gpt-4o");
		expect(out).toContain("Tools: bash(5), edit(3)");
		expect(out).toContain("Modified: src/retry.ts, test/retry.test.ts");
		expect(out).toContain("$0.42");
		expect(out).toContain("1.2M tokens");
	});

	it("falls back to snippet-only when loadDetail resolves null", async () => {
		const f = new FinderComponent({
			title: "t",
			entries,
			theme,
			loadDetail: () => Promise.resolve(null),
		});
		f.requestRender = () => {};
		expect(f.render(80).join("\n")).toContain("loading");
		await flush();
		const out = f.render(80).join("\n");
		expect(out).not.toContain("Models:");
		expect(out).not.toContain("loading");
		expect(out).toContain("stripe webhook signature"); // snippet still there
	});

	it("renders no facet / loading lines when loadDetail is unset (rich preview off)", () => {
		const f = new FinderComponent({ title: "t", entries, theme });
		const out = f.render(80).join("\n");
		expect(out).not.toContain("Models:");
		expect(out).not.toContain("loading");
	});

	it("caches per path and does not reload on re-focus", async () => {
		let calls = 0;
		const f = new FinderComponent({
			title: "t",
			entries,
			theme,
			loadDetail: (p) => {
				calls++;
				return Promise.resolve(p === "/a.jsonl" ? detail : null);
			},
		});
		f.requestRender = () => {};
		await flush();
		expect(calls).toBe(1); // /a.jsonl on init
		f.handleInput("\x1b[B"); // ↓ → /b.jsonl
		await flush();
		expect(calls).toBe(2); // /b.jsonl loaded
		f.handleInput("\x1b[A"); // ↑ → back to /a.jsonl (cached)
		await flush();
		expect(calls).toBe(2); // not reloaded
	});
});

// ── peek paging (item 5) ──────────────────────────────────────────

describe("FinderComponent — peek paging", () => {
	/** fullText: "stripe" anchor at 0, long filler, then tail markers. Long
	 *  enough that one peek window (< 1007 chars) never shows it all. */
	const fullText = "stripe " + "a".repeat(500) + "midmarker " + "b".repeat(480) + "tailmarker"; // len 1007
	const peeks = [
		{
			path: "/p.jsonl",
			header: "h",
			title: "t",
			detail: "d",
			snippet: "the anchor snippet view here",
			terms: ["stripe"],
			fullText,
		},
		{
			path: "/q.jsonl",
			header: "h2",
			title: "t2",
			detail: "d2",
			snippet: "other",
			terms: ["stripe"], // no fullText → peek unavailable
		},
	];

	it("starts at the anchor (no peek offset) showing the snippet", () => {
		const f = new FinderComponent({ title: "t", entries: peeks, theme });
		expect(f.getPeekOffset("/p.jsonl")).toBeUndefined();
		expect(renderText(f)).toContain("the anchor snippet view here");
	});

	it("`>` enters peek mode and switches the view off the snippet", () => {
		const f = new FinderComponent({ title: "t", entries: peeks, theme });
		expect(renderText(f)).toContain("the anchor snippet view here");
		f.handleInput(">");
		expect(f.getPeekOffset("/p.jsonl")).not.toBeUndefined();
		// now paging fullText, which does not contain the snippet string
		expect(renderText(f)).not.toContain("the anchor snippet view here");
	});

	it("`<` from the anchor is a no-op (stays on the snippet)", () => {
		const f = new FinderComponent({ title: "t", entries: peeks, theme });
		f.handleInput("<");
		expect(f.getPeekOffset("/p.jsonl")).toBeUndefined();
	});

	it("`<` after `>` pages back toward the anchor", () => {
		const f = new FinderComponent({ title: "t", entries: peeks, theme });
		f.handleInput(">");
		const after = f.getPeekOffset("/p.jsonl")!;
		expect(after).toBeGreaterThan(0);
		f.handleInput("<");
		expect(f.getPeekOffset("/p.jsonl")).toBeLessThanOrEqual(after);
	});

	it("focus change resets the peek offset to the anchor", () => {
		const f = new FinderComponent({ title: "t", entries: peeks, theme });
		f.handleInput(">");
		expect(f.getPeekOffset("/p.jsonl")).not.toBeUndefined();
		f.handleInput("\x1b[B"); // ↓ → /q
		f.handleInput("\x1b[A"); // ↑ → back to /p
		expect(f.getPeekOffset("/p.jsonl")).toBeUndefined(); // reset to anchor
	});

	it("`>`/`<` are no-ops when fullText is absent (entry /q)", () => {
		const f = new FinderComponent({ title: "t", entries: peeks, theme });
		f.handleInput("\x1b[B"); // ↓ → /q (no fullText)
		f.handleInput(">");
		expect(f.getPeekOffset("/q.jsonl")).toBeUndefined();
	});

	it("clamps at the tail bound (offset plateaus, can't overshoot)", () => {
		const f = new FinderComponent({ title: "t", entries: peeks, theme });
		renderText(f); // prime lastWidth
		for (let i = 0; i < 8; i++) f.handleInput(">");
		const plateau = f.getPeekOffset("/p.jsonl");
		f.handleInput(">"); // already at the end
		expect(f.getPeekOffset("/p.jsonl")).toBe(plateau);
	});
});
