/**
 * pi-session-finder — interactive TUI finder component (PRD §7).
 *
 * Layout: a compact, filterable, scrollable list of one-line **headers** with a
 * **detail/preview pane** beneath that shows the focused result's title, its
 * project path / date / message count, and a longer keyword-centered snippet
 * (the search terms highlighted) — so you can scan many results and inspect the
 * right one without the list itself getting cluttered.
 *
 * UX (fzf-like):
 *   - type            → fuzzy-filter the results live (over header + snippet)
 *   - ↑/↓, PgUp/PgDn  → move selection; the preview pane follows the focus
 *   - Enter           → jump to the focused session
 *   - Esc / Ctrl+C    → cancel
 *
 * Built from @earendil-works/pi-tui primitives: `Input` (filter) + `SelectList`
 * (scrolling header list). The list is rebuilt per keystroke so we can use true
 * fuzzy matching (SelectList.setFilter is prefix-on-value only).
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	Input,
	SelectList,
	fuzzyFilter,
	matchesKey,
	truncateToWidth,
	type Component,
	type SelectItem,
	type SelectListTheme,
} from "@earendil-works/pi-tui";

/** One result, carrying everything the list row and the preview pane need. */
export interface FinderEntry {
	/** Absolute session path (returned on selection). */
	path: string;
	/** One-line list label: "title · project · ago · N msg". */
	header: string;
	/** Preview line 1 — the session title (fuller). */
	title: string;
	/** Preview line 2 — "cwd · modified DATE · N messages". */
	detail: string;
	/** Preview line 3+ — longer, keyword-centered snippet. */
	snippet: string;
	/** Effective query terms, for highlighting in the snippet. */
	terms: string[];
}

export interface FinderOptions {
	/** Header line, e.g. "Find sessions · 42 matches". */
	title: string;
	entries: FinderEntry[];
	theme: Theme;
	/** Visible header rows before scrolling. Default 8 (leaves room for preview). */
	maxVisible?: number;
}

const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Wrap matched query terms in the accent color (case-insensitive). */
function highlight(text: string, terms: string[], theme: Theme): string {
	const ts = [...new Set(terms.map((t) => t.trim()).filter(Boolean))].map(escapeRegex);
	if (ts.length === 0) return text;
	try {
		return text.replace(new RegExp(`(${ts.join("|")})`, "gi"), (m) => theme.fg("accent", m));
	} catch {
		return text; // bad regex pattern — fall back to plain
	}
}

/** Word-wrap plain text into at most `maxLines` lines, each ≤ `width`. */
function wrapWords(text: string, width: number, maxLines: number): string[] {
	const words = text.split(/\s+/).filter(Boolean);
	const lines: string[] = [];
	let cur = "";
	for (const w of words) {
		const cand = cur ? `${cur} ${w}` : w;
		if (cand.length <= width) cur = cand;
		else {
			if (cur) lines.push(cur);
			cur = w;
			if (lines.length >= maxLines) break;
		}
	}
	if (cur && lines.length < maxLines) lines.push(cur);
	return lines.slice(0, maxLines);
}

/** Pad/truncate a line array to exactly `n` entries (fixed render height). */
function padTo(lines: string[], n: number): string[] {
	const out = lines.slice(0, n);
	while (out.length < n) out.push("");
	return out;
}

/**
 * Focusable finder component. Return an instance from `ctx.ui.custom(...)`;
 * wire `onSelect` / `onCancel` and set `requestRender` to the TUI's redraw hook.
 */
export class FinderComponent implements Component {
	private readonly theme: Theme;
	private readonly title: string;
	private readonly maxVisible: number;
	private readonly entries: FinderEntry[];
	private readonly byPath: Map<string, FinderEntry>;
	private readonly input = new Input();
	private list: SelectList;
	private focusedEntry: FinderEntry | null;

	onSelect?: (path: string) => void;
	onCancel?: () => void;
	/** Call this (e.g. `() => tui.requestRender()`) so keystrokes redraw. */
	requestRender: () => void = () => {};

	constructor(opts: FinderOptions) {
		this.theme = opts.theme;
		this.title = opts.title;
		this.maxVisible = opts.maxVisible ?? 8;
		this.entries = opts.entries;
		this.byPath = new Map(this.entries.map((e) => [e.path, e]));
		this.focusedEntry = this.entries[0] ?? null;
		this.list = this.makeList(this.headerItems());
		// NOTE: the Input is intentionally left UNFOCUSED. A focused Input emits a
		// CURSOR_MARKER that, inside ctx.ui.custom, breaks the redraw line
		// accounting and makes previous frames persist (duplicate-looking rows).
		// handleInput/getValue work regardless of focus, so the filter still works.
	}

	private headerItems(): SelectItem[] {
		return this.entries.map((e) => ({ value: e.path, label: e.header }));
	}

	private listTheme(): SelectListTheme {
		const th = this.theme;
		return {
			selectedPrefix: (t) => th.fg("accent", t),
			selectedText: (t) => th.fg("accent", t),
			description: (t) => th.fg("muted", t),
			scrollInfo: (t) => th.fg("dim", t),
			noMatch: (t) => th.fg("warning", t),
		};
	}

	private makeList(items: SelectItem[]): SelectList {
		const visible = items.length ? Math.min(items.length, this.maxVisible) : this.maxVisible;
		const list = new SelectList(items, visible, this.listTheme());
		list.onSelect = (item) => this.onSelect?.(item.value);
		list.onCancel = () => this.onCancel?.();
		list.onSelectionChange = (item) => {
			this.focusedEntry = this.byPath.get(item.value) ?? null;
		};
		return list;
	}

	/** Recompute the visible list from the current filter text (fuzzy). */
	private refreshFilter(): void {
		const q = this.input.getValue().trim();
		const all = this.headerItems();
		const items = q
			? fuzzyFilter(all, q, (it) => {
					const e = this.byPath.get(it.value);
					return e ? `${e.header} ${e.snippet}` : it.label;
				})
			: all;
		this.list = this.makeList(items);
		this.focusedEntry = items[0] ? (this.byPath.get(items[0].value) ?? null) : null;
	}

	// ── Input focus is intentionally off (see constructor note) ──────────

	handleInput(data: string): void {
		if (
			matchesKey(data, "up") ||
			matchesKey(data, "down") ||
			matchesKey(data, "pageUp") ||
			matchesKey(data, "pageDown") ||
			matchesKey(data, "home") ||
			matchesKey(data, "end")
		) {
			this.list.handleInput(data);
		} else if (matchesKey(data, "return") || matchesKey(data, "enter")) {
			const sel = this.list.getSelectedItem();
			if (sel) this.onSelect?.(sel.value);
		} else if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.onCancel?.();
		} else if (matchesKey(data, "tab") || matchesKey(data, "shift+tab")) {
			// single field — swallow so focus never leaves the filter
		} else {
			this.input.handleInput(data);
			this.refreshFilter();
		}
		this.requestRender();
	}

	render(width: number): string[] {
		const th = this.theme;
		const lines: string[] = [];

		lines.push(th.fg("accent", th.bold(this.title)));
		lines.push(th.fg("dim", "type to filter  ·  ↑↓ navigate  ·  enter jump  ·  esc cancel"));

		// Filter input, with a dim prompt prefix.
		const prefix = th.fg("dim", "filter: ");
		const [inputLine = ""] = this.input.render(Math.max(1, width - 8));
		lines.push(prefix + inputLine);

		// Scrollable header list — pad to maxVisible so the component height is fixed.
		lines.push(...padTo(this.list.render(width), this.maxVisible));

		// Separator + detail/preview pane for the focused result (fixed height).
		lines.push(th.fg("dim", "─".repeat(width)));
		const e = this.focusedEntry;
		const snippetLines = e ? wrapWords(e.snippet, width, 2) : [];
		if (e) {
			lines.push(th.fg("accent", th.bold(truncateToWidth(e.title, width, "…"))));
			lines.push(th.fg("muted", truncateToWidth(e.detail, width, "…")));
		} else {
			lines.push(th.fg("warning", "  No matching sessions"));
			lines.push("");
		}
		// Always exactly two snippet lines (highlighted) — keeps the frame stable.
		for (let i = 0; i < 2; i++) {
			const l = snippetLines[i] ?? "";
			lines.push(e ? highlight(truncateToWidth(l, width, "…"), e.terms, th) : "");
		}

		return lines;
	}

	invalidate(): void {
		this.input.invalidate();
		this.list.invalidate();
	}
}
