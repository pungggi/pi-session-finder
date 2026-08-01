/**
 * pi-session-finder — cross-project session search & jump.
 *
 * Registers `/find [keywords…]`: full-text searches every past session across
 * all projects (via `SessionManager.listAll`), shows matches in a picker, and
 * on confirmation switches to that session **and** its project `cwd` — same
 * outcome as `/resume`, but driven by content search. (PRD §1–§6.)
 *
 * MVP scope (PRD §12): `/find` using `ctx.ui.select`; case-insensitive AND over
 * `allMessagesText` + `name` + `cwd`; jump via `ctx.switchSession`.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_CONFIG,
	ago,
	extractSnippet,
	projName,
	rankMatches,
	type SessionInfoLike,
} from "./search.js";

/** Cap on rendered rows; ranking keeps the best on top (PRD §8.5). */
const MAX_RESULTS = 200;
/** Max snippet length folded into a single picker row. */
const LABEL_SNIPPET_CAP = 90;

/** Truncate to `n` visible chars with an ellipsis. */
function truncate(s: string, n: number): string {
	return s.length <= n ? s : s.slice(0, Math.max(0, n - 1)) + "…";
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

			// ctx.ui.select takes plain string[] — build one-line labels and keep a
			// label→path map to resolve the chosen value back to a session.
			const labelToPath = new Map<string, string>();
			const options: string[] = [];
			for (const m of capped) {
				const title =
					m.info.name?.trim() ||
					m.info.firstMessage.slice(0, 60).trim() ||
					"(untitled session)";
				const meta = `${projName(m.info.cwd)} · ${ago(m.info.modified)} · ${m.info.messageCount} msg`;
				const snippet = truncate(
					extractSnippet(m.info.allMessagesText, m.terms, DEFAULT_CONFIG),
					LABEL_SNIPPET_CAP,
				);
				let label = snippet ? `${title}  —  ${meta}  —  “${snippet}”` : `${title}  —  ${meta}`;

				// Guarantee uniqueness so the chosen string maps back unambiguously.
				if (labelToPath.has(label)) {
					let n = 2;
					while (labelToPath.has(`${label} (#${n})`)) n++;
					label = `${label} (#${n})`;
				}
				labelToPath.set(label, m.info.path);
				options.push(label);
			}

			const more = matches.length > capped.length ? ` · ${matches.length - capped.length} more` : "";
			const choice = await ctx.ui.select(
				`Jump to session (${matches.length} match${matches.length === 1 ? "" : "es"}${more})`,
				options,
			);
			if (!choice) return; // Esc / Ctrl+C — no state change (US6)

			const targetPath = labelToPath.get(choice);
			if (!targetPath) return;

			// Capture only plain data for withSession: the old command `ctx` is stale
			// after replacement (PRD §8.3 / extensions.md "footguns").
			const picked = capped.find((m) => m.info.path === targetPath);
			const pickName =
				picked?.info.name?.trim() ||
				picked?.info.firstMessage.slice(0, 50).trim() ||
				"session";
			const pickProject = projName(picked?.info.cwd ?? "");

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
