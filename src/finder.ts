/**
 * pi-session-finder — interactive TUI finder component.
 *
 * A scrollable, filterable session picker (PRD §7 "FinderComponent"). Replaces
 * the flat `ctx.ui.select` list used by the MVP, which is not navigable when a
 * query yields many matches.
 *
 * UX (fzf-like):
 *   - type            → fuzzy-filter the results live (over label + description)
 *   - ↑/↓, PgUp/PgDn  → move selection (the list scrolls within `maxVisible`)
 *   - Enter           → jump to the focused session
 *   - Esc / Ctrl+C    → cancel
 *
 * Built from @earendil-works/pi-tui primitives: `Input` (filter field) +
 * `SelectList` (scrolling list). The list is rebuilt per keystroke so we can use
 * true fuzzy matching (SelectList.setFilter is prefix-on-value only).
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	Container,
	Input,
	SelectList,
	Text,
	fuzzyFilter,
	matchesKey,
	type Component,
	type Focusable,
	type SelectItem,
	type SelectListLayoutOptions,
	type SelectListTheme,
} from "@earendil-works/pi-tui";

/** One row in the finder. */
export interface FinderEntry {
	/** Absolute session path (returned on selection). */
	path: string;
	/** Primary row text — the session title. */
	label: string;
	/** Secondary row text — meta + snippet. */
	description: string;
}

export interface FinderOptions {
	/** Header line, e.g. "Find sessions · 42 matches". */
	title: string;
	entries: FinderEntry[];
	theme: Theme;
	/** Visible rows before scrolling. Default 12. */
	maxVisible?: number;
	/** Cap on the primary (label) column width so the snippet stays visible. */
	maxPrimaryColumnWidth?: number;
}

/**
 * Focusable finder component. Return an instance from `ctx.ui.custom(...)`;
 * wire `onSelect` / `onCancel` and set `requestRender` to the TUI's redraw hook.
 */
export class FinderComponent implements Component, Focusable {
	private readonly theme: Theme;
	private readonly title: string;
	private readonly maxVisible: number;
	private readonly layout: SelectListLayoutOptions;
	private readonly allItems: SelectItem[];
	private readonly container = new Container();
	private readonly input = new Input();
	private list: SelectList;
	private _focused = false;

	onSelect?: (path: string) => void;
	onCancel?: () => void;
	/** Call this (e.g. `() => tui.requestRender()`) so keystrokes redraw. */
	requestRender: () => void = () => {};

	constructor(opts: FinderOptions) {
		this.theme = opts.theme;
		this.title = opts.title;
		this.maxVisible = opts.maxVisible ?? 12;
		this.layout = { maxPrimaryColumnWidth: opts.maxPrimaryColumnWidth ?? 42 };
		this.allItems = opts.entries.map((e) => ({
			value: e.path,
			label: e.label,
			description: e.description,
		}));

		this.container.addChild(new Text(this.theme.fg("accent", this.theme.bold(this.title)), 1, 0));
		this.container.addChild(
			new Text(
				this.theme.fg("dim", "type to filter  ·  ↑↓ navigate  ·  enter jump  ·  esc cancel"),
				1,
				0,
			),
		);
		this.container.addChild(this.input);
		this.list = this.makeList(this.allItems);
		this.container.addChild(this.list);

		// Show the filter cursor immediately (modal owns input for its lifetime).
		this.input.focused = true;
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
		const list = new SelectList(items, visible, this.listTheme(), this.layout);
		list.onSelect = (item) => this.onSelect?.(item.value);
		list.onCancel = () => this.onCancel?.();
		return list;
	}

	/** Recompute the visible list from the current filter text (fuzzy). */
	private refreshFilter(): void {
		const q = this.input.getValue().trim();
		const items = q
			? fuzzyFilter(this.allItems, q, (i) => `${i.label} ${i.description ?? ""}`)
			: this.allItems;
		const next = this.makeList(items);
		const idx = this.container.children.indexOf(this.list);
		if (idx !== -1) this.container.children[idx] = next;
		this.list = next;
	}

	// ── Focusable: propagate focus to the Input so its cursor renders ─────
	get focused(): boolean {
		return this._focused;
	}
	set focused(v: boolean) {
		this._focused = v;
		this.input.focused = v;
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
		} else if (matchesKey(data, "tab") || matchesKey(data, "shift+tab")) {
			// single field — swallow so focus never leaves the filter
		} else {
			this.input.handleInput(data);
			this.refreshFilter();
		}
		this.requestRender();
	}

	render(width: number): string[] {
		return this.container.render(width);
	}

	invalidate(): void {
		this.container.invalidate();
	}
}
