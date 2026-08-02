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
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { FinderComponent, clamp, type FinderEntry } from "./finder.js";
import {
	applySessionStart,
	dropMissingTop,
	emptyState,
	popForBack,
	type BackState,
} from "./history.js";
import { parseSessionDetail, type Outcome, type SessionDetail } from "./parse.js";
import {
	DEFAULT_CONFIG,
	ago,
	extractSnippet,
	projName,
	rankMatches,
	type RankedMatch,
	type RankMode,
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

/** Runtime finder config (the "config layer" PLAN items 1 & 6 share). pi's
 *  ExtensionAPI exposes no config accessor, so these are env-var knobs — the
 *  only API-free surface. Migrate to a `.pi/`-file layer if richer per-project
 *  settings are ever needed. */
interface FindConfig {
	/** Rich preview pane (item 1). Default `true`; `PI_FIND_RICH_PREVIEW=0` off. */
	richPreview: boolean;
	/** Ranking strategy (item 6). Default `heuristic`; opt-in `rrf` / `bm25`. */
	rankMode: RankMode;
}

function resolveFindConfig(): FindConfig {
	return {
		richPreview: parseBoolEnv(process.env.PI_FIND_RICH_PREVIEW, true),
		rankMode: parseRankMode(process.env.PI_FIND_RANK_MODE),
	};
}

/** Empty/blank → `dflt`; `0|false|no|off` → false; anything else → true. */
function parseBoolEnv(v: string | undefined, dflt: boolean): boolean {
	const s = (v ?? "").trim().toLowerCase();
	if (!s) return dflt;
	return !["0", "false", "no", "off"].includes(s);
}

function parseRankMode(v: string | undefined): RankMode {
	const s = (v ?? "").trim().toLowerCase();
	return s === "rrf" || s === "bm25" ? s : "heuristic";
}

/** Item 1: defer a facet parse off the input path via setImmediate so arrow-key
 *  navigation never blocks. The read is fast (tens of ms) but yielding keeps the
 *  filter loop responsive. */
function loadDetailDeferred(path: string): Promise<SessionDetail | null> {
	return new Promise((resolve) =>
		setImmediate(() => {
			try {
				resolve(parseSessionDetail(path));
			} catch {
				resolve(null);
			}
		}),
	);
}

/**
 * Back-navigation persistence (see history.ts). Lives under the pi agent dir
 * so it survives the cross-cwd module reload that `/find` jumps trigger.
 * `PI_CODING_AGENT_DIR` overrides the default `~/.pi/agent`.
 */
function agentDataDir(): string {
	return process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent");
}

function backStatePath(): string {
	return join(agentDataDir(), "session-finder", "backstack.json");
}

function readBackState(): BackState {
	try {
		const parsed = JSON.parse(readFileSync(backStatePath(), "utf8")) as Partial<BackState>;
		if (Array.isArray(parsed.stack)) {
			return {
				stack: parsed.stack.filter((s): s is string => typeof s === "string"),
				suppressNext: Boolean(parsed.suppressNext),
			};
		}
	} catch {
		/* missing / corrupt → start fresh */
	}
	return emptyState();
}

function writeBackState(state: BackState): void {
	const file = backStatePath();
	try {
		mkdirSync(dirname(file), { recursive: true });
		// Direct truncate+write — NOT temp-file + rename. On Windows, rename-over-an-
		// existing-file can raise EPERM when the destination is briefly locked (AV
		// scan, indexer, …); the catch below would swallow it and silently drop the
		// just-recorded jump, leaving /find-back with an empty stack. A direct
		// overwrite is far more reliable here, and atomicity is irrelevant: single
		// writer, ~30-byte file, no concurrent readers.
		writeFileSync(file, JSON.stringify(state), "utf8");
	} catch {
		/* best-effort: back nav degrades if persist fails */
	}
}

/** Optional diagnostics: set PI_FIND_BACK_DEBUG=1 to append one line per event
 *  to `session-finder/debug.log`. Off by default. Never throws. */
function debugLog(message: string): void {
	if (!parseBoolEnv(process.env.PI_FIND_BACK_DEBUG, false)) return;
	try {
		const file = join(agentDataDir(), "session-finder", "debug.log");
		mkdirSync(dirname(file), { recursive: true });
		appendFileSync(file, `${new Date().toISOString()} ${message}\n`, "utf8");
	} catch {
		/* diagnostics must never break a session */
	}
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
		return { path: m.info.path, header, title, detail, snippet, terms: m.terms, fullText: m.info.allMessagesText };
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
	// Universal "back" navigation: record every real session switch (new / resume /
	// fork) so `/find-back` can replay it. Bookkeeping only — never notify, never
	// throw. See history.ts for why this state lives on disk, not in memory.
	pi.on("session_start", async (event) => {
		const previous =
			event.reason === "new" || event.reason === "resume" || event.reason === "fork"
				? event.previousSessionFile
				: undefined;
		try {
			// applySessionStart returns the SAME reference when nothing changed
			// (startup/reload/dedup), so we only touch disk on a real state change —
			// less churn, fewer chances to hit a transient fs error.
			const before = readBackState();
			const next = applySessionStart(before, previous);
			if (next !== before) writeBackState(next);
			debugLog(`session_start reason=${event.reason} previous=${previous ?? "(none)"} stackLen=${next.stack.length} suppress=${next.suppressNext}`);
		} catch {
			/* never break a session start over back-stack bookkeeping */
		}
	});

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

			const cfg = resolveFindConfig();
		const searchCfg: SearchConfig = { ...DEFAULT_CONFIG, rankMode: cfg.rankMode };
		const matches = rankMatches(sessions, query, searchCfg);
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
						const finder = new FinderComponent({
							title,
							entries,
							theme,
							targetHeight,
							loadDetail: cfg.richPreview ? loadDetailDeferred : undefined,
						});
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

	// `/find-back`: jump to the previous session/project. Universal — undoes not
	// just `/find` but any `/resume`, `/new`, `/fork`, or `/clone` (anything that
	// fired `session_start` with a `previousSessionFile`). See history.ts.
	pi.registerCommand("find-back", {
		description:
			"Jump back to the previous session/project (undo /find, /resume, /new, /fork, …)",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("/find-back needs interactive mode", "info");
				return;
			}

			// Drop deleted sessions from the top, then pop the most recent survivor.
			// `before` (same ref as state0 unless stale cleanup happened) gates a write.
			const before = readBackState();
			const state0 = dropMissingTop(before, (p) => existsSync(p));
			const popped = popForBack(state0);
			debugLog(`find-back start stackLen=${before.stack.length} popped=${popped ? popped.target : "(none)"}`);
			if (!popped) {
				if (state0 !== before) writeBackState(state0); // persist stale cleanup only if it changed
				ctx.ui.notify("No session to go back to", "info");
				return;
			}

			// Commit the pop and arm the suppress flag before switching: the switch
			// we're about to make must not be recorded again (ping-pong guard).
			writeBackState(popped.state);

			const result = await ctx.switchSession(popped.target, {
				withSession: async (rcx) => {
					rcx.ui.notify("Back to previous session", "info");
				},
			});

			// Vetoed: we never actually left — restore the popped entry and clear the
			// suppress flag so the next real switch records normally.
			if (result?.cancelled) {
				writeBackState({ stack: [...popped.state.stack, popped.target], suppressNext: false });
				ctx.ui.notify("Back cancelled", "info");
			}
		},
	});
}
