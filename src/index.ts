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
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { FinderComponent, type FinderEntry } from "./finder.js";
import {
	DEFAULT_CONFIG,
	ago,
	extractSnippet,
	projName,
	rankMatches,
	type RankedMatch,
	type SessionInfoLike,
} from "./search.js";
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** Strip ANSI escape codes (for measuring visible width in debug logging). */
const stripAnsi = (s: string): string =>
	s.replace(
		// eslint-disable-next-line no-control-regex
		/[\u001b\u009b][[\]()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g,
		"",
	);

/** Cap on rows kept after ranking; ranking keeps the best on top (PRD §8.5). */
const MAX_RESULTS = 200;
/** Snippet window for the TUI preview pane (richer than a cramped row). */
const PREVIEW_SNIPPET_CHARS = 220;

/** ISO yyyy-mm-dd for display. */
function day(d: Date): string {
	return d.toISOString().slice(0, 10);
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

			const matches = rankMatches(sessions, query, DEFAULT_CONFIG);
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
				// (an inline ctx.ui.custom component taller than the editor area does).
				//
				// DEBUG INSTRUMENTATION (temporary): logs pi's internal newLines/previousLines
				// state per keypress to ~/.pi/agent/finder-debug.log, to determine whether
				// the full-screen line array grows per keypress (append-stacking) or stays
				// constant (diff/cursor desync). The factory receives the live TUI.
				const dbgPath = join(homedir(), ".pi", "agent", "finder-debug.log");
				targetPath = await ctx.ui.custom<string | null>(
					(tui, theme, _kb, done) => {
						const finder = new FinderComponent({ title, entries, theme });
						finder.onSelect = (path) => done(path);
						finder.onCancel = () => done(null);
						const dt = tui as unknown as {
							render: (w: number) => string[];
							previousLines: string[];
							maxLinesRendered: number;
							terminal?: { columns?: number };
							overlayStack?: unknown[];
							requestRender: () => void;
						};
						const writeDebug = (tag: string) => {
							try {
								const cols = dt.terminal?.columns ?? -1;
								const prevLen = dt.previousLines?.length ?? -1;
								const maxR = dt.maxLinesRendered ?? -1;
								const overlays = dt.overlayStack?.length ?? -1;
								let newLen = -1;
								try {
									newLen = dt.render(cols).length; // preview full-screen newLines
								} catch {
									/* ignore render errors */
								}
								const mine = finder.render(cols);
								const mineVisible = mine.map((l: string) => stripAnsi(l).length);
								const lines = [
									`\n[${new Date().toISOString()}] ${tag}: cols=${cols} prevLines=${prevLen} newScreenLen=${newLen} maxLinesRendered=${maxR} overlays=${overlays} myRenderLen=${mine.length} myVisibleWidths=[${mineVisible.join(",")}]`,
									...mine.map((l: string, i: number) => `   my[${i}] ${JSON.stringify(stripAnsi(l)).slice(0, 100)}`),
								];
								mkdirSync(dirname(dbgPath), { recursive: true });
								appendFileSync(dbgPath, lines.join("\n") + "\n");
							} catch {
								/* never break the UI over logging */
							}
						};
						finder.requestRender = () => {
							writeDebug("requestRender");
							tui.requestRender();
						};
						writeDebug("init");
						return finder;
					},
					{ overlay: true, overlayOptions: { width: "90%", maxHeight: "70%", anchor: "center" } },
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
			const pickName = picked?.title ?? "session";
			const pickProject = projName(
				capped.find((m) => m.info.path === targetPath)?.info.cwd ?? "",
			);

			// FR-4: switch session + cwd + trust in one call. The core re-runs project
			// trust for the target cwd (PRD §2 / OQ1 — resolved affirmative).
			const result = await ctx.switchSession(targetPath, {
				withSession: async (rcx) => {
					rcx.ui.notify(`Resumed "${pickName}" in ${pickProject}`, "info");
				},
			});

			// Only reached with a live old ctx when the switch was vetoed — safe to use.
			if (result.cancelled) {
				ctx.ui.notify("Switch cancelled", "info");
			}
		},
	});
}
