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

export interface SearchConfig {
	/** Match case-sensitively. Default false. */
	caseSensitive: boolean;
	/** How multiple terms combine. Default "and". */
	matchMode: MatchMode;
	/** Context-window size (chars) for {@link extractSnippet}. Default 160. */
	snippetChars: number;
}

export const DEFAULT_CONFIG: SearchConfig = {
	caseSensitive: false,
	matchMode: "and",
	snippetChars: 160,
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
 * Ranking: (a) name match first, (b) distinct matched terms desc, (c) modified
 * desc. A hand-tuned IDF analogue — rare terms discriminate better.
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

	matches.sort((a, b) => {
		if (a.nameMatched !== b.nameMatched) return a.nameMatched ? -1 : 1;
		const byTerms = b.matchedTerms.length - a.matchedTerms.length;
		if (byTerms !== 0) return byTerms;
		return b.info.modified.getTime() - a.info.modified.getTime();
	});

	return matches;
}

/** Collapse runs of whitespace (incl. newlines) to single spaces. */
function collapseWhitespace(s: string): string {
	return s.replace(/\s+/g, " ").trim();
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
	return prefix + collapseWhitespace(text.slice(start, end)) + suffix;
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
