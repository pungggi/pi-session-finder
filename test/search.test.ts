import { describe, expect, it } from "vitest";
import {
	DEFAULT_CONFIG,
	ago,
	countOccurrences,
	extractSnippet,
	matchSession,
	parseQuery,
	projName,
	rankMatches,
	type SessionInfoLike,
} from "../src/search.js";

/** Build a SessionInfoLike fixture with sensible defaults. */
function mk(over: Partial<SessionInfoLike> = {}): SessionInfoLike {
	const now = new Date("2025-01-01T00:00:00Z");
	return {
		path: over.path ?? "/s/1.jsonl",
		id: over.id ?? "id-1",
		cwd: over.cwd ?? "/home/me/project",
		name: over.name,
		created: over.created ?? now,
		modified: over.modified ?? now,
		messageCount: over.messageCount ?? 5,
		firstMessage: over.firstMessage ?? "hello",
		allMessagesText: over.allMessagesText ?? "hello world",
	};
}

// ── parseQuery ───────────────────────────────────────────────────────

describe("parseQuery", () => {
	it("splits on whitespace and dedupes", () => {
		const q = parseQuery("stripe stripe webhook");
		expect(q.terms).toEqual(["stripe", "webhook"]);
	});

	it("treats a quoted phrase as one term", () => {
		const q = parseQuery('"stripe webhook" bug');
		expect(q.terms).toEqual(["stripe webhook", "bug"]);
	});

	it("handles a single quoted phrase", () => {
		const q = parseQuery('"stripe webhook"');
		expect(q.terms).toEqual(["stripe webhook"]);
	});

	it("phrase mode collapses the whole query into one term", () => {
		const q = parseQuery("stripe webhook", "phrase");
		expect(q.terms).toEqual(["stripe webhook"]);
	});

	it("returns no terms for empty / whitespace input", () => {
		expect(parseQuery("   ").terms).toEqual([]);
		expect(parseQuery("").terms).toEqual([]);
	});
});

// ── countOccurrences ─────────────────────────────────────────────────

describe("countOccurrences", () => {
	it("counts non-overlapping occurrences", () => {
		expect(countOccurrences("a b a b a", "a")).toBe(3);
		expect(countOccurrences("xxx", "x")).toBe(3);
		expect(countOccurrences("none here", "z")).toBe(0);
		expect(countOccurrences("whatever", "")).toBe(0);
	});
});

// ── matchSession ─────────────────────────────────────────────────────

describe("matchSession", () => {
	it("AND: all terms must match somewhere", () => {
		const q = parseQuery("stripe webhook");
		expect(matchSession(mk({ allMessagesText: "stripe webhook configured" }), q)).not.toBeNull();
		expect(matchSession(mk({ allMessagesText: "only stripe here" }), q)).toBeNull();
	});

	it("matches across name, cwd and text", () => {
		const q = parseQuery("businesscentral");
		expect(matchSession(mk({ name: "BusinessCentral refactor" }), q)).not.toBeNull();
		expect(matchSession(mk({ cwd: "/home/me/BusinessCentral" }), q)).not.toBeNull();
		expect(matchSession(mk({ allMessagesText: "work on businesscentral api" }), q)).not.toBeNull();
	});

	it("is case-insensitive by default", () => {
		const q = parseQuery("Stripe");
		expect(matchSession(mk({ allMessagesText: "configured STRIPE webhook" }), q)).not.toBeNull();
	});

	it("honors caseSensitive config", () => {
		const q = parseQuery("Stripe");
		const cfg = { ...DEFAULT_CONFIG, caseSensitive: true };
		expect(matchSession(mk({ allMessagesText: "configured STRIPE webhook" }), q, cfg)).toBeNull();
		expect(matchSession(mk({ allMessagesText: "configured Stripe webhook" }), q, cfg)).not.toBeNull();
	});

	it("OR mode: any term matches", () => {
		const q = parseQuery("stripe webhook");
		const cfg = { ...DEFAULT_CONFIG, matchMode: "or" as const };
		expect(matchSession(mk({ allMessagesText: "only stripe" }), q, cfg)).not.toBeNull();
		expect(matchSession(mk({ allMessagesText: "only webhook" }), q, cfg)).not.toBeNull();
		expect(matchSession(mk({ allMessagesText: "neither here" }), q, cfg)).toBeNull();
	});

	it("records nameMatched and matchedTerms", () => {
		const q = parseQuery("stripe webhook");
		const m = matchSession(mk({ name: "stripe debug", allMessagesText: "stripe webhook" }), q);
		expect(m).not.toBeNull();
		expect(m!.nameMatched).toBe(true);
		expect(m!.matchedTerms.sort()).toEqual(["stripe", "webhook"]);
	});

	it("returns null for an empty query", () => {
		expect(matchSession(mk(), parseQuery(""))).toBeNull();
	});
});

// ── rankMatches ──────────────────────────────────────────────────────

describe("rankMatches", () => {
	const t0 = new Date("2025-01-01T00:00:00Z");
	const t1 = new Date("2025-01-02T00:00:00Z");
	const t2 = new Date("2025-01-03T00:00:00Z");

	it("returns [] for an empty query", () => {
		expect(rankMatches([mk()], "")).toEqual([]);
	});

	it("ranks a name match above text-only matches", () => {
		const byText = mk({ path: "/a", allMessagesText: "stripe work", modified: t2 });
		const byName = mk({ path: "/b", name: "stripe session", allMessagesText: "no kw", modified: t0 });
		const out = rankMatches([byText, byName], "stripe");
		expect(out.map((m) => m.info.path)).toEqual(["/b", "/a"]);
	});

	it("ranks more matched terms above fewer (OR mode)", () => {
		// Under AND every surviving match has all terms, so the term-count tiebreak
		// only differentiates in OR mode where matches can cover different terms.
		const one = mk({ path: "/a", allMessagesText: "stripe only", modified: t2 });
		const two = mk({ path: "/b", allMessagesText: "stripe webhook both", modified: t0 });
		const cfg = { ...DEFAULT_CONFIG, matchMode: "or" as const };
		const out = rankMatches([one, two], "stripe webhook", cfg);
		expect(out).toHaveLength(2);
		expect(out[0].info.path).toBe("/b"); // matched both terms
		expect(out[1].info.path).toBe("/a"); // matched one term
	});

	it("breaks ties by recency (newer first)", () => {
		const older = mk({ path: "/a", allMessagesText: "stripe", modified: t0 });
		const newer = mk({ path: "/b", allMessagesText: "stripe", modified: t2 });
		const out = rankMatches([older, newer], "stripe");
		expect(out.map((m) => m.info.path)).toEqual(["/b", "/a"]);
	});

	it("does not match sessions lacking all terms (AND default)", () => {
		const out = rankMatches([mk({ allMessagesText: "only stripe" })], "stripe webhook");
		expect(out).toEqual([]);
	});
});

// ── extractSnippet ───────────────────────────────────────────────────

describe("extractSnippet", () => {
	it("centers on the matched term and trims to size", () => {
		const text = "a ".repeat(60) + "stripe webhook here" + " b".repeat(60);
		const snip = extractSnippet(text, ["stripe"], { ...DEFAULT_CONFIG, snippetChars: 40 });
		expect(snip).toContain("stripe");
		expect(snip.startsWith("…")).toBe(true);
		expect(snip.endsWith("…")).toBe(true);
		// collapsed whitespace — no double spaces
		expect(snip).not.toMatch(/ {2,}/);
	});

	it("centers on the rarest matched term (local IDF proxy)", () => {
		const common = "foo ".repeat(20);
		const text = `${common}the rareterm anchor ${common}`;
		const snip = extractSnippet(text, ["foo", "rareterm"], DEFAULT_CONFIG);
		expect(snip).toContain("rareterm");
	});

	it("preserves newlines (structure for markdown) but caps blank lines", () => {
		const text = "line one\n\n\nstripe\nline two";
		const snip = extractSnippet(text, ["stripe"], DEFAULT_CONFIG);
		expect(snip).toContain("\n"); // newlines preserved, not flattened
		expect(snip).toContain("stripe");
		expect(snip).not.toMatch(/\n{3,}/); // 3+ blank lines collapsed to a single blank line
	});

	it("does not slice a word in half at the boundaries", () => {
		const text = "abcdefghijklmnopqrstuvwxyz stripe zyxwvutsrqponmlkjihgfedcba";
		const snip = extractSnippet(text, ["stripe"], { ...DEFAULT_CONFIG, snippetChars: 16 });
		// the surrounding long tokens must be dropped, not truncated
		expect(snip).not.toMatch(/abcdefghij|zyxwvutsrq/);
		expect(snip).toContain("stripe");
	});

	it("is case-insensitive by default but preserves original case", () => {
		const text = "verify the Stripe Webhook signature";
		const snip = extractSnippet(text, ["stripe"], DEFAULT_CONFIG);
		expect(snip).toContain("Stripe");
	});

	it("falls back to a leading window when the term is not in the text", () => {
		const text = "general context with no anchor word at all";
		const snip = extractSnippet(text, ["missing"], DEFAULT_CONFIG);
		expect(snip.length).toBeGreaterThan(0);
		expect(snip.startsWith("the text content" )).toBeFalsy();
		expect(snip).toContain("general");
	});

	it("returns '' for empty text", () => {
		expect(extractSnippet("", ["x"])).toBe("");
	});
});

// ── projName / ago ───────────────────────────────────────────────────

describe("projName", () => {
	it("shows last two segments", () => {
		expect(projName("/home/me/pi/packages/pi-session-finder")).toBe("packages/pi-session-finder");
	});
	it("shows basename when only one segment", () => {
		expect(projName("project")).toBe("project");
	});
	it("normalizes trailing slashes and backslashes", () => {
		expect(projName("C:\\Users\\me\\App")).toBe("me/App");
		expect(projName("/a/b/")).toBe("a/b");
	});
	it("handles empty cwd", () => {
		expect(projName("")).toBe("(unknown project)");
	});
});

describe("ago", () => {
	const now = new Date("2025-01-10T00:00:00Z").getTime();
	it("formats recent and older deltas", () => {
		expect(ago(new Date(now - 30_000), now)).toBe("just now");
		expect(ago(new Date(now - 5 * 60_000), now)).toBe("5m ago");
		expect(ago(new Date(now - 3 * 3_600_000), now)).toBe("3h ago");
		expect(ago(new Date(now - 2 * 86_400_000), now)).toBe("2d ago");
		expect(ago(new Date(now - 20 * 86_400_000), now)).toBe("3w ago");
		expect(ago(new Date(now - 200 * 86_400_000), now)).toBe("7mo ago");
	});
	it("handles future dates", () => {
		expect(ago(new Date(now + 1000), now)).toBe("in the future");
	});
});
