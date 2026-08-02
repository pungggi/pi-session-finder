/**
 * pi-session-finder — cross-project session search & jump.
 *
 * Registers `/find [keywords…]`: full-text searches every past session across
 * all projects (via `SessionManager.listAll`), shows matches in a picker, and
 * on confirmation switches to that session **and** its project `cwd` — same
 * outcome as `/resume`, but driven by content search. (PRD §1–§6.)
 *
 * Picker (PRD §FR-3):
 *   - TUI  → custom `FinderComponent`: scrollable list + live fuzzy filter.
 *   - RPC  → `ctx.ui.select` (headless picker).
 *   - print/json → no-op (point at the planned `pi --find` CLI flag).
 *
 * On jump (item 7, PLAN.md): a "Previously on…" recap widget is pinned above
 * the editor in the resumed session — intent / last action / next step /
 * outcome — plus a match locator (the matched message's content + its
 * `message #N of M` position), since pi exposes no "scroll to message" API.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { FinderComponent, clamp, type FinderEntry } from "./finder.js";
import { parseSessionDetail, type Outcome, type SessionDetail } from "./parse.js";
import {
	DEFAULT_CONFIG,
	ago,
	extractSnippet,
	projName,
	rankMatches,
	type RankedMatch,
	type SearchConfig,
	type SessionInfoLike,
} from "./search.js";

/** Cap on rows kept after ranking; ranking keeps the best on top (PRD §8.5). */
const MAX_RESULTS = 200;
/** Snippet window for the TUI preview pane (richer than a cramped row). */
const PREVIEW_SNIPPET_CHARS = 4000;

/** ISO yyyy-mm-dd for display. */
function day(d: Date): string {
	return d.toISOString().slice(0, 10);
}

/**
 * Resolve the runtime search config. Rank mode is an experimental opt-in via
 * the `PI_FIND_RANK_MODE` env var (`heuristic` | `rrf` | `bm25`); default stays
 * `heuristic` until RRF is benchmarked vs. the gold set (PLAN item 6 / PRD §10).
 * Migrate to a real config layer when item 1 lands one.
 */
function resolveSearchConfig(): SearchConfig {
	const mode = (process.env.PI_FIND_RANK_MODE ?? "").trim().toLowerCase();
	return mode === "rrf" || mode === "bm25" || mode === "heuristic"
		? { ...DEFAULT_CONFIG, rankMode: mode }
		: DEFAULT_CONFIG;
}

/** Build finder rows (header + preview fields) shared by the TUI and RPC pickers. */
function buildEntries(matches: RankedMatch[]): FinderEntry[] {
	const previewCfg = { ...DEFAULT_CONFIG, snippetChars: PREVIEW_SNIPPET_CHARS };
	return matches.map((m) => {
		const title =
			m.info.name?.trim() ||
			m.info.firstMessage.slice(0, 80).trim() ||
			"(untitled session)";
		const project = projName(m.info.cwd);
		const header = `${title}  ·  ${project}  ·  ${ago(m.info.modified)}  ·  ${m.info.messageCount} msg`;
		const detail = `${m.info.cwd || "(unknown project)"}  ·  modified ${day(m.info.modified)}  ·  ${m.info.messageCount} messages`;
		const snippet = extractSnippet(m.info.allMessagesText, m.terms, previewCfg);
		return { path: m.info.path, header, title, detail, snippet, terms: m.terms };
	});
}

/** Item 7: render the landing recap card (intent / last action / next step /
 *  outcome) plus the match locator, since we can't auto-scroll to the message. */
function buildRecapCard(detail: SessionDetail, query: string, sessionName: string): string[] {
	const r = detail.recap;
	const lines: string[] = [];
	lines.push(`Previously on "${sessionName}":`);
	lines.push(`  What you were doing: ${r.intent}`);
	lines.push(`  Last action: ${r.lastAction}`);
	if (r.nextStep) lines.push(`  Next step: ${r.nextStep}`);
	lines.push(`  Outcome: ${outcomeLabel(r.outcome)}`);
	if (detail.locator) {
		lines.push(`  ── match for "${query}" (no auto-scroll; navigate manually) ──`);
		lines.push(`  message #${detail.locator.index} of ${detail.locator.total}:`);
		lines.push(`  ${detail.locator.text}`);
	} else if (query) {
		lines.push(`  (matched session name/project, not the conversation)`);
	}
	return lines;
}

function outcomeLabel(o: Outcome): string {
	if (o === "landed") return "landed (assistant closed it out)";
	if (o === "abandoned") return "abandoned (last action errored)";
	return "open (no closing turn)";
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("find", {
		description: "Search all sessions (all projects) by keyword and jump to a match",
		handler: async (args, ctx) => {
			// FR-5: only dialog-capable modes (tui / rpc). print / json are no-ops.
			if (!ctx.hasUI) {
				ctx.ui.notify("/find needs interactive mode — try: pi --find", "info");
				return;
			}

			// FR-1: free-text args; `/find` with no args opens a search prompt.
			let query = args.trim();
			if (!query) {
				query = (await ctx.ui.input("Find sessions", "search keywords…"))?.trim() ?? "";
				if (!query) return; // cancelled or left empty
			}

			// FR-2 scope: every session, every project. Show progress while scanning.
			ctx.ui.setStatus("find", "Scanning all sessions…");
			let sessions: SessionInfoLike[];
			try {
				sessions = await SessionManager.listAll((loaded, total) => {
					if (total) ctx.ui.setStatus("find", `Scanning all sessions… ${loaded}/${total}`);
				});
			} catch (err) {
				ctx.ui.setStatus("find", undefined);
				ctx.ui.notify(`Failed to list sessions: ${(err as Error).message}`, "error");
				return;
			}
			ctx.ui.setStatus("find", undefined);

			const matches = rankMatches(sessions, query, resolveSearchConfig());
			if (matches.length === 0) {
				ctx.ui.notify(`No sessions matched "${query}"`, "info");
				return;
			}

			const capped = matches.slice(0, MAX_RESULTS);
			const entries = buildEntries(capped);
			const title = `Find sessions · ${matches.length} match${matches.length === 1 ? "" : "es"}`;

			// Pick a session path (or null on cancel) via the mode-appropriate UI.
			let targetPath: string | null = null;
			if (ctx.mode === "tui") {
				// Render as a centered overlay: overlays are redrawn fresh each frame in
				// their own managed box, so navigation/filtering never leaves stale rows
				// (an inline ctx.ui.custom component taller than the editor area can).
				targetPath = await ctx.ui.custom<string | null>(
					(tui, theme, _kb, done) => {
						// Size the picker to fill ~82% of the terminal height: more visible
						// matches and a much larger preview/context pane on tall terms.
						const rows = (tui as { terminal?: { rows?: number } }).terminal?.rows ?? 24;
						const targetHeight = clamp(Math.floor(rows * 0.82), 14, Math.max(14, rows - 2));
						const finder = new FinderComponent({ title, entries, theme, targetHeight });
						finder.onSelect = (path) => done(path);
						finder.onCancel = () => done(null);
						finder.requestRender = () => tui.requestRender();
						return finder;
					},
					{ overlay: true, overlayOptions: { width: "90%", maxHeight: "85%", anchor: "center" } },
				);
			} else {
				// RPC: fall back to the flat select picker. Map each label back to a path.
				const labelToPath = new Map<string, string>();
				const options = entries.map((e) => {
					let label = e.snippet ? `${e.header}  —  ${e.snippet}` : e.header;
					if (labelToPath.has(label)) {
						let n = 2;
						while (labelToPath.has(`${label} (#${n})`)) n++;
						label = `${label} (#${n})`;
					}
					labelToPath.set(label, e.path);
					return label;
				});
				const more = matches.length > capped.length ? ` · ${matches.length - capped.length} more` : "";
				const choice = await ctx.ui.select(`${title}${more}`, options);
				targetPath = choice ? (labelToPath.get(choice) ?? null) : null;
			}

			if (!targetPath) return; // Esc / Ctrl+C — no state change (US6)

			// Capture only plain data for withSession: the old command `ctx` is stale
			// after replacement (PRD §8.3 / extensions.md "footguns").
			const picked = entries.find((e) => e.path === targetPath);
			const pickedMatch = capped.find((m) => m.info.path === targetPath) ?? null;
			const pickName = picked?.title ?? "session";
			const pickProject = projName(pickedMatch?.info.cwd ?? "");
			const terms = pickedMatch?.terms ?? [];

			// FR-4: switch session + cwd + trust in one call. The core re-runs project
			// trust for the target cwd (PRD §2 / OQ1 — resolved affirmative).
			const result = await ctx.switchSession(targetPath, {
				withSession: async (rcx) => {
					rcx.ui.notify(`Resumed "${pickName}" in ${pickProject}`, "info");
					// Item 7: recap-at-landing + match locator (PLAN.md). Best-effort —
					// never let it break the resume. No "scroll to message" API exists,
					// so the card surfaces the matched message content + its position.
					try {
						const detail = parseSessionDetail(targetPath, terms, DEFAULT_CONFIG);
						if (detail) {
							rcx.ui.setWidget("find-recap", buildRecapCard(detail, query, pickName), {
								placement: "aboveEditor",
							});
							// Dismiss as soon as the user starts typing (first keystroke);
							// returning undefined leaves the keystroke unconsumed so it
							// still reaches the editor.
							let off: (() => void) | undefined;
							off = rcx.ui.onTerminalInput((): undefined => {
								try {
									rcx.ui.setWidget("find-recap", undefined);
								} catch {
									/* widget may already be gone */
								}
								try {
									off?.();
								} catch {
									/* already unsubscribed */
								}
								return undefined;
							});
						}
					} catch {
						/* recap is nice-to-have */
					}
				},
			});

			// Only reached with a live old ctx when the switch was vetoed — safe to use.
			if (result.cancelled) {
				ctx.ui.notify("Switch cancelled", "info");
			}
		},
	});
}
