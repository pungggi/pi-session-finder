/**
 * pi-session-finder — pure search helpers.
 *
 * No pi imports here on purpose: this module is fully unit-testable and
 * operates on a {@link SessionInfoLike} shape that mirrors the subset of
 * `SessionInfo` (see `session-manager.d.ts`) that we actually search.
 *
 * Responsibilities (PRD §FR-2, §8.4):
 *   - parseQuery: split a query into terms, honoring double-quoted phrases.
 *   - matchSession / rankMatches: case-insensitive AND/OR/phrase matching over
 *     `name` + `cwd` + `allMessagesText`; rank by name-hit, then term count,
 *     then recency.
 *   - rankMatches can fuse independent signals via Reciprocal Rank Fusion
 *     (PLAN item 6): `rankMode: "rrf"` (opt-in; default stays "heuristic").
 *   - extractSnippet: center a ±N char window on the least-common matched term
 *     (a local IDF proxy), trimmed to token boundaries, whitespace-collapsed.
 *   - projName / ago: display helpers.
 */

/** Minimal view of `SessionInfo` that search needs. */
export interface SessionInfoLike {
	path: string;
	id: string;
	/** Working directory. May be "" for very old sessions. */
	cwd: string;
	/** User-defined display name, if any. */
	name?: string;
	created: Date;
	modified: Date;
	messageCount: number;
	firstMessage: string;
	/** Concatenated user + assistant + tool text — the primary search target. */
	allMessagesText: string;
}

export type MatchMode = "and" | "or" | "phrase";

/**
 * Ranking strategy for {@link rankMatches}.
 * - `"heuristic"` — hand-tuned lexicographic order (default).
 * - `"rrf"` — Reciprocal Rank Fusion of independent signals (PLAN item 6).
 * - `"bm25"` — reserved (PRD §10), not yet implemented → behaves as heuristic.
 */
export type RankMode = "heuristic" | "rrf" | "bm25";

export interface SearchConfig {
	/** Match case-sensitively. Default false. */
	caseSensitive: boolean;
	/** How multiple terms combine. Default "and". */
	matchMode: MatchMode;
	/** Context-window size (chars) for {@link extractSnippet}. Default 160. */
	snippetChars: number;
	/** Ranking strategy. Default "heuristic" (PLAN item 6). */
	rankMode: RankMode;
}

export const DEFAULT_CONFIG: SearchConfig = {
	caseSensitive: false,
	matchMode: "and",
	snippetChars: 160,
	rankMode: "heuristic",
};

/** A parsed search query. */
export interface ParsedQuery {
	/** Trimmed original query. */
	raw: string;
	/** Effective terms used for matching (deduped, order preserved). */
	terms: string[];
	mode: MatchMode;
}

/** A ranked hit. */
export interface RankedMatch {
	info: SessionInfoLike;
	/** Effective query terms (post-parse). */
	terms: string[];
	/** Distinct terms that matched somewhere (name/cwd/text). */
	matchedTerms: string[];
	/** Whether any term matched the session name. */
	nameMatched: boolean;
}

const isWs = (ch: string | undefined): boolean => !!ch && /\s/.test(ch);

/**
 * Tokenize a query into terms.
 *
 * - `mode: "phrase"` collapses the whole query into a single term so it is
 *   matched as one substring.
 * - otherwise tokens are whitespace-split, but a double-quoted segment becomes
 *   one term (so `"stripe webhook"` is a single substring term). Quotes are
 *   optional and may be mixed: `"stripe webhook" bug` → ["stripe webhook","bug"].
 *
 * Terms are deduped (case-sensitive identity) and empties are dropped.
 */
export function parseQuery(input: string, mode: MatchMode = "and"): ParsedQuery {
	const raw = input.trim();
	if (mode === "phrase") {
		return { raw, terms: raw ? [raw] : [], mode };
	}

	const terms: string[] = [];
	let cur = "";
	let inQuotes = false;
	const flush = () => {
		const t = cur.trim();
		if (t && !terms.includes(t)) terms.push(t);
		cur = "";
	};

	for (let i = 0; i < raw.length; i++) {
		const ch = raw[i];
		if (ch === '"') {
			inQuotes = !inQuotes;
			continue;
		}
		if (!inQuotes && /\s/.test(ch)) {
			flush();
			continue;
		}
		cur += ch;
	}
	flush();

	return { raw, terms, mode };
}

/** Count non-overlapping occurrences of `needle` in `haystack`. */
export function countOccurrences(haystack: string, needle: string): number {
	if (!needle) return 0;
	let count = 0;
	let i = haystack.indexOf(needle);
	while (i !== -1) {
		count++;
		i = haystack.indexOf(needle, i + needle.length);
	}
	return count;
}

/** Lowercase wrapper honoring caseSensitive. */
function cmp(s: string, caseSensitive: boolean): string {
	return caseSensitive ? s : s.toLowerCase();
}

/**
 * Test a single session against a parsed query. Returns a {@link RankedMatch}
 * on hit, or `null` when the query does not match.
 *
 * Match targets (any one counts): `name`, `cwd`, `allMessagesText`.
 */
export function matchSession(
	info: SessionInfoLike,
	query: ParsedQuery,
	config: SearchConfig = DEFAULT_CONFIG,
): RankedMatch | null {
	if (query.terms.length === 0) return null;

	const cs = config.caseSensitive;
	const nameL = cmp(info.name ?? "", cs);
	const cwdL = cmp(info.cwd, cs);
	const textL = cmp(info.allMessagesText, cs);

	const matchedTerms: string[] = [];
	let nameMatched = false;

	for (const original of query.terms) {
		const t = cmp(original, cs);
		const inName = nameL.includes(t);
		const hit = inName || cwdL.includes(t) || textL.includes(t);
		if (hit) {
			matchedTerms.push(original);
			if (inName) nameMatched = true;
		}
	}

	const ok =
		config.matchMode === "or"
			? matchedTerms.length > 0
			: matchedTerms.length === query.terms.length; // "and" and "phrase" (single term)

	if (!ok) return null;

	return {
		info,
		terms: query.terms,
		matchedTerms,
		nameMatched,
	};
}

/**
 * Filter + rank all sessions for a query. (PRD §FR-2.)
 *
 * Ranking dispatches on {@link SearchConfig.rankMode}; see {@link rank} for the
 * per-mode order.
 */
export function rankMatches(
	sessions: readonly SessionInfoLike[],
	query: string,
	config: SearchConfig = DEFAULT_CONFIG,
): RankedMatch[] {
	const parsed = parseQuery(query, config.matchMode);
	if (parsed.terms.length === 0) return [];

	const matches: RankedMatch[] = [];
	for (const s of sessions) {
		const m = matchSession(s, parsed, config);
		if (m) matches.push(m);
	}

	return rank(matches, config);
}

/**
 * Rank an already-filtered set per {@link SearchConfig.rankMode}.
 *
 * - `"heuristic"` (default) — hand-tuned lexicographic: name match, then
 *   distinct matched terms, then recency. Fast, interpretable, tuned to the
 *   gold set (PRD §10).
 * - `"rrf"` — Reciprocal Rank Fusion of four independent signals
 *   ({@link rankByMeta}, {@link rankByCoverage}, {@link rankByRecency},
 *   {@link rankByFrequency}) via {@link fuseRanks}. Opt-in; flip the default
 *   only after a benchmark shows it ≥ heuristic (PLAN item 6).
 * - `"bm25"` — reserved (PRD §10), not yet implemented → behaves as heuristic.
 */
function rank(matches: RankedMatch[], config: SearchConfig): RankedMatch[] {
	if (config.rankMode === "rrf") {
		return fuseRanks([
			rankByMeta(matches, config),
			rankByCoverage(matches),
			rankByRecency(matches),
			rankByFrequency(matches, config),
		]);
	}
	// "heuristic" and the reserved "bm25" (PRD §10) both use the hand-tuned order.
	matches.sort((a, b) => {
		if (a.nameMatched !== b.nameMatched) return a.nameMatched ? -1 : 1;
		const byTerms = b.matchedTerms.length - a.matchedTerms.length;
		if (byTerms !== 0) return byTerms;
		return finalTiebreak(a, b);
	});
	return matches;
}

/** Deterministic total order for ties: most-recent first, then path asc. */
function finalTiebreak(a: RankedMatch, b: RankedMatch): number {
	const t = b.info.modified.getTime() - a.info.modified.getTime();
	return t !== 0 ? t : a.info.path < b.info.path ? -1 : a.info.path > b.info.path ? 1 : 0;
}

// ── RRF rankers — pure, independent signals over the matched set ─────
// Each returns a fresh ranked copy (input untouched). Used both standalone and
// as the input lists to {@link fuseRanks} (PLAN item 6).

/** Ranker 1: metadata (name or cwd) matches above text-only matches. */
export function rankByMeta(matches: readonly RankedMatch[], config: SearchConfig): RankedMatch[] {
	const cs = config.caseSensitive;
	return [...matches].sort((a, b) => {
		const ma = hasMetaHit(a, cs);
		const mb = hasMetaHit(b, cs);
		if (ma !== mb) return ma ? -1 : 1;
		return finalTiebreak(a, b);
	});
}

/** Does any matched term hit the session name or cwd (not just the body)? */
function hasMetaHit(m: RankedMatch, caseSensitive: boolean): boolean {
	if (m.nameMatched) return true;
	const cwd = cmp(m.info.cwd, caseSensitive);
	return m.matchedTerms.some((t) => cwd.includes(cmp(t, caseSensitive)));
}

/** Ranker 2: distinct matched-term coverage desc (today's primary signal). */
export function rankByCoverage(matches: readonly RankedMatch[]): RankedMatch[] {
	return [...matches].sort((a, b) => {
		const c = b.matchedTerms.length - a.matchedTerms.length;
		return c !== 0 ? c : finalTiebreak(a, b);
	});
}

/** Ranker 3: recency — `modified` desc. */
export function rankByRecency(matches: readonly RankedMatch[]): RankedMatch[] {
	return [...matches].sort((a, b) => finalTiebreak(a, b));
}

/**
 * Ranker 4: total query-term frequency in `allMessagesText` desc — a cheap
 * BM25-ish signal without length normalization.
 */
export function rankByFrequency(matches: readonly RankedMatch[], config: SearchConfig): RankedMatch[] {
	const cs = config.caseSensitive;
	const freqOf = (m: RankedMatch): number => {
		const text = cmp(m.info.allMessagesText, cs);
		return m.matchedTerms.reduce((sum, t) => sum + countOccurrences(text, cmp(t, cs)), 0);
	};
	return [...matches].sort((a, b) => {
		const f = freqOf(b) - freqOf(a);
		return f !== 0 ? f : finalTiebreak(a, b);
	});
}

/**
 * Reciprocal Rank Fusion: combine independent ranked lists into one.
 *
 * `score(m) = Σ_i 1/(k + rank_i)`, where `rank_i` is `m`'s 1-based position in
 * ranker `i`; a match absent from a list contributes nothing (defensive — in
 * normal use every ranker covers the same matched set). Higher score first;
 * ties broken by {@link finalTiebreak} (recency, then path) for determinism.
 * `k=60` is the literature default (Cormack et al. 2009).
 */
export function fuseRanks(lists: RankedMatch[][], k = 60): RankedMatch[] {
	const kk = k > 0 ? k : 60;
	const score = new Map<string, number>();
	const byPath = new Map<string, RankedMatch>();
	for (const list of lists) {
		for (let i = 0; i < list.length; i++) {
			const m = list[i];
			const key = m.info.path;
			if (!byPath.has(key)) byPath.set(key, m);
			score.set(key, (score.get(key) ?? 0) + 1 / (kk + i + 1));
		}
	}
	return [...byPath.values()].sort((a, b) => {
		const s = (score.get(b.info.path) ?? 0) - (score.get(a.info.path) ?? 0);
		return s !== 0 ? s : finalTiebreak(a, b);
	});
}

/** Collapse runs of whitespace (incl. newlines) to single spaces. */
/** Normalize a snippet window for display: collapse inline whitespace to a
 * single space but PRESERVE newlines (and cap blank lines) so downstream markdown
 * rendering keeps headings, lists, tables and code on their own lines — instead
 * of flattening everything into one wrapped paragraph. */
function normalizeForSnippet(s: string): string {
	return s
		.replace(/\r\n?/g, "\n")
		.replace(/[^\S\n]+/g, " ")
		.replace(/ *\n */g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

/**
 * Extract a ±`snippetChars` context window centered on the **least-common**
 * matched term found in `text` (a local IDF surrogate — rare terms
 * disambiguate better; PRD §8.4 D3). Slices the *original* text (preserving
 * case) using a lowercased copy for locating. Trims to token boundaries and
 * collapses whitespace; prefixes/suffixes `…` when truncated.
 *
 * If no matched term occurs in `text` (hit was via name/cwd only), falls back
 * to a leading window of the text so the row still shows context.
 */
export function extractSnippet(
	text: string,
	terms: readonly string[],
	config: SearchConfig = DEFAULT_CONFIG,
): string {
	if (!text) return "";

	const size = Math.max(8, config.snippetChars);
	const textL = cmp(text, config.caseSensitive);

	// Pick the anchor: among terms that occur in text, the rarest (fewest hits).
	let anchor: string | null = null;
	let anchorCount = Infinity;
	for (const original of terms) {
		const t = cmp(original, config.caseSensitive);
		if (!t) continue;
		const c = countOccurrences(textL, t);
		if (c > 0 && c < anchorCount) {
			anchorCount = c;
			anchor = t;
		}
	}

	const len = text.length;
	let center = anchor ? textL.indexOf(anchor) : -1;
	if (center === -1) {
		// No matched term in text → leading window.
		center = 0;
	}

	const half = Math.floor(size / 2);
	let start = Math.max(0, center - half);
	let end = Math.min(len, start + size);
	// Keep the window ~`size` wide when we clamped `end` to len.
	if (end - start < size) start = Math.max(0, end - size);

	// Trim to token boundaries: drop a partial leading/trailing word.
	if (start > 0 && !isWs(text[start]) && !isWs(text[start - 1])) {
		while (start < end && !isWs(text[start])) start++;
		while (start < end && isWs(text[start])) start++;
	}
	if (end < len && !isWs(text[end - 1]) && !isWs(text[end])) {
		while (end > start && !isWs(text[end - 1])) end--;
		while (end > start && isWs(text[end - 1])) end--;
	}

	const prefix = start > 0 ? "…" : "";
	const suffix = end < len ? "…" : "";
	return prefix + normalizeForSnippet(text.slice(start, end)) + suffix;
}

/**
 * Compact project label for a cwd: the last two path segments
 * (`parent/basename`) when available, else the basename. Falls back gracefully
 * for empty/old-session cwds.
 */
export function projName(cwd: string): string {
	if (!cwd) return "(unknown project)";
	const norm = cwd.replace(/\\/g, "/").replace(/\/+$/, "");
	const segs = norm.split("/").filter(Boolean);
	if (segs.length === 0) return cwd;
	if (segs.length === 1) return segs[0];
	return segs.slice(-2).join("/");
}

/** Relative "x ago" string. `now` is injectable for deterministic tests. */
export function ago(date: Date, now: number = Date.now()): string {
	const ms = now - date.getTime();
	if (ms < 0) return "in the future";
	const sec = Math.round(ms / 1000);
	if (sec < 45) return "just now";
	const min = Math.round(sec / 60);
	if (min < 60) return `${min}m ago`;
	const hr = Math.round(min / 60);
	if (hr < 24) return `${hr}h ago`;
	const day = Math.round(hr / 24);
	if (day < 7) return `${day}d ago`;
	const wk = Math.round(day / 7);
	if (wk < 5) return `${wk}w ago`;
	const mon = Math.round(day / 30);
	if (mon < 12) return `${mon}mo ago`;
	return `${Math.round(day / 365)}y ago`;
}
