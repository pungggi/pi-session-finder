/**
 * pi-session-finder — interactive TUI finder component (PRD §7).
 *
 * Layout: a compact, filterable, scrollable list of one-line **headers** with a
 * **detail/preview pane** beneath that shows the focused result's title, its
 * project path / date / message count, and a longer keyword-centered snippet
 * (the search terms highlighted).
 *
 * UX (fzf-like):
 *   - type            → fuzzy-filter the results live (over header + snippet)
 *   - ↑/↓, PgUp/PgDn  → move selection; the preview pane follows the focus
 *   - Enter           → jump to the focused session
 *   - Esc / Ctrl+C    → cancel
 *
 * Implementation note: the filter is tracked as a plain string and rendered as
 * a plain text line — we deliberately do NOT embed a focused `Input` component.
 * A focused Input emits a CURSOR_MARKER and participates in pi's focus/render
 * bookkeeping in a way that, inside `ctx.ui.custom`, makes previous frames
 * persist (rows looked duplicated on navigation). Staying structurally close to
 * pi's `preset.ts` example (SelectList + plain text lines, no Input) avoids it.
 */

import { getMarkdownTheme, type Theme } from "@earendil-works/pi-coding-agent";
import {
	Markdown,
	SelectList,
	fuzzyFilter,
	matchesKey,
	truncateToWidth,
	type Component,
	type MarkdownTheme,
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
	/** Target total component height in rows. When set, the list and preview
	 * snippet are sized to fill it (more matches + more context on tall terms).
	 * Overrides are still honored via maxVisible/snippetLines. */
	targetHeight?: number;
	/** Visible header rows before scrolling. Overrides the target-derived value. */
	maxVisible?: number;
	/** Preview snippet rows. Overrides the target-derived value. */
	snippetLines?: number;
}

export const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n));

/** Collapse all whitespace (incl. newlines/tabs) and strip control chars so the
 * result is a single terminal row. A rendered "line" must NEVER contain embedded
 * newlines: pi's differential renderer treats each array entry as one physical
 * row, and an embedded \n desyncs the hardware cursor so stale frames stack. */
const singleLine = (s: string): string =>
	s.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();

/** True for a key sequence that should be inserted into the filter text. */
function isPrintable(data: string): boolean {
	return (
		data.length > 0 &&
		data[0] !== "\x1b" &&
		data.charCodeAt(0) >= 0x20 &&
		data !== "\x7f" // DEL — handled as backspace
	);
}

/**
 * Finder component. Return an instance from `ctx.ui.custom(...)`; wire `onSelect`
 * / `onCancel` and set `requestRender` to the TUI's redraw hook.
 */
export class FinderComponent implements Component {
	private readonly theme: Theme;
	private readonly title: string;
	private readonly maxVisible: number;
	private readonly maxSnippet: number;
	private readonly targetHeight?: number;
	private readonly entries: FinderEntry[];
	private readonly byPath: Map<string, FinderEntry>;
	private readonly filter: { value: string } = { value: "" };
	private list: SelectList;
	private focusedEntry: FinderEntry | null;
	/** Markdown renderer (pi's own chat renderer) for the preview snippet. */
	private readonly markdownTheme: MarkdownTheme;
	private md: Markdown | null = null;
	private mdText = "";

	onSelect?: (path: string) => void;
	onCancel?: () => void;
	/** Call this (e.g. `() => tui.requestRender()`) so keystrokes redraw. */
	requestRender: () => void = () => {};

	constructor(opts: FinderOptions) {
		this.theme = opts.theme;
		this.title = opts.title;
		this.entries = opts.entries;
		this.byPath = new Map(this.entries.map((e) => [e.path, e]));
		this.focusedEntry = this.entries[0] ?? null;
		// Reuse pi's chat markdown theme so the preview looks like the real chat
		// (tables, headings, code blocks, lists, bold, …).
		this.markdownTheme = getMarkdownTheme();

		// Layout caps. When targetHeight (terminal-derived) is set the picker fills
		// the available rows: the list takes ~55%, the preview snippet fills the
		// rest up to maxSnippet. render() derives the per-frame snippet budget from
		// the actual visible list rows so the total tracks targetHeight closely.
		this.targetHeight = opts.targetHeight;
		this.maxVisible =
			opts.maxVisible ?? (opts.targetHeight ? clamp(Math.floor(opts.targetHeight * 0.55), 6, 30) : 8);
		this.maxSnippet = opts.snippetLines ?? (opts.targetHeight ? clamp(opts.targetHeight - 12, 8, 24) : 4);

		this.list = this.makeList(this.headerItems());
	}

	private headerItems(): SelectItem[] {
		return this.entries.map((e) => ({ value: e.path, label: singleLine(e.header) }));
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
		const q = this.filter.value.trim();
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
		} else if (matchesKey(data, "backspace") || data === "\x7f" || data === "\b") {
			if (this.filter.value.length > 0) {
				this.filter.value = this.filter.value.slice(0, -1);
				this.refreshFilter();
			}
		} else if (matchesKey(data, "tab") || matchesKey(data, "shift+tab")) {
			// swallow — single filter field
		} else if (isPrintable(data)) {
			this.filter.value += data;
			this.refreshFilter();
		}
		this.requestRender();
	}

	render(width: number): string[] {
		const th = this.theme;
		const lines: string[] = [];

		lines.push(th.fg("accent", th.bold(this.title)));
		lines.push(th.fg("dim", "type to filter  ·  ↑↓ navigate  ·  enter jump  ·  esc cancel"));

		// Filter line (plain text — no Input component / no cursor marker).
		const placeholder = th.fg("dim", "type to filter…");
		const filterLine = this.filter.value ? this.filter.value : placeholder;
		lines.push(truncateToWidth(`${th.fg("dim", "filter: ")}${filterLine}`, width, "…"));

		// Scrollable header list — show one row per match (capped at maxVisible by
		// the SelectList scroll window). No list padding: the snippet fills any
		// leftover height instead, so blanks (when any) sit at the bottom.
		const listRows = this.list.render(width);
		lines.push(...listRows);

		// Separator + detail/preview pane for the focused result.
		lines.push(th.fg("dim", "─".repeat(width)));
		const e = this.focusedEntry;
		// chrome = title + help + filter + separator + preview(title, detail) = 6.
		const snippetBudget = this.targetHeight
			? clamp(this.targetHeight - 6 - listRows.length, 4, this.maxSnippet)
			: this.maxSnippet;
		if (e) {
			lines.push(th.fg("accent", th.bold(truncateToWidth(singleLine(e.title), width, "…"))));
			lines.push(th.fg("muted", truncateToWidth(singleLine(e.detail), width, "…")));
			// Preview snippet rendered as MARKDOWN via pi's own chat renderer, so
			// headings, lists, tables and code blocks keep their structure instead of
			// collapsing into a wall of text. Cached per snippet text. Each output line
			// is split on any stray newline / \r-stripped / width-capped, so no array
			// entry ever carries an embedded newline (renderer-safe).
			if (this.mdText !== e.snippet) {
				this.md = new Markdown(e.snippet.trim(), 0, 0, this.markdownTheme);
				this.mdText = e.snippet;
			}
			const mdLines = (this.md?.render(width) ?? [])
				.flatMap((l) => l.split(/\r?\n/))
				.map((l) => truncateToWidth(l.replace(/\r/g, ""), width, "…"))
				.slice(0, snippetBudget);
			while (mdLines.length < snippetBudget) mdLines.push("");
			lines.push(...mdLines);
		} else {
			lines.push(th.fg("warning", "  No matching sessions"));
			lines.push("");
		}

		return lines;
	}

	invalidate(): void {
		this.list.invalidate();
	}

	/** Test/debug hook: current filter text. */
	getFilterValue(): string {
		return this.filter.value;
	}
}
