import { describe, expect, it } from "vitest";
import { parseSessionDetail, parseSessionDetailText } from "../src/parse.js";

type Obj = Record<string, unknown>;
const TS = "2026-01-01T00:00:00Z";

// ── JSONL fixture builders ──────────────────────────────────────────

const header = (id = "sess-1", cwd = "/home/me/project"): string =>
	JSON.stringify({ type: "session", version: 1, id, timestamp: TS, cwd });

const userMsg = (id: string, text: string): string =>
	JSON.stringify({ type: "message", id, timestamp: TS, message: { role: "user", content: text } });

const assistantText = (id: string, text: string): string =>
	JSON.stringify({
		type: "message",
		id,
		timestamp: TS,
		message: { role: "assistant", content: [{ type: "text", text }] },
	});

const assistantToolCall = (id: string, name: string, args: Obj): string =>
	JSON.stringify({
		type: "message",
		id,
		timestamp: TS,
		message: { role: "assistant", content: [{ type: "toolCall", name, arguments: args }] },
	});

const toolResult = (id: string, toolName: string, isError: boolean): string =>
	JSON.stringify({
		type: "message",
		id,
		timestamp: TS,
		message: { role: "toolResult", toolName, isError, content: "ok" },
	});

const compaction = (summary: string): string =>
	JSON.stringify({ type: "compaction", id: "c1", timestamp: TS, summary });

const assistantRich = (
	id: string,
	opts: { provider?: string; model?: string; cost?: number; tokens?: number; text?: string },
): string =>
	JSON.stringify({
		type: "message",
		id,
		timestamp: TS,
		message: {
			role: "assistant",
			provider: opts.provider,
			model: opts.model,
			usage: {
				cost: opts.cost === undefined ? undefined : { total: opts.cost },
				totalTokens: opts.tokens,
			},
			content: opts.text ? [{ type: "text", text: opts.text }] : [],
		},
	});

const modelChange = (provider: string, modelId: string): string =>
	JSON.stringify({ type: "model_change", id: "mc1", timestamp: TS, provider, modelId });

const jl = (...lines: string[]): string => lines.join("\n");

// ── recap ───────────────────────────────────────────────────────────

describe("parseSessionDetailText — recap", () => {
	it("derives intent from the first user message when there is no compaction", () => {
		const raw = jl(
			header(),
			userMsg("m1", "fix the stripe webhook signature"),
			assistantToolCall("m2", "edit", { path: "/p/ApiRouter.cs" }),
			toolResult("m3", "edit", false),
		);
		const d = parseSessionDetailText(raw)!;
		expect(d.recap.intent).toBe("fix the stripe webhook signature");
		expect(d.recap.lastAction).toBe("edit ApiRouter.cs");
		expect(d.recap.lastActionKind).toBe("tool");
		// assistant (tool call) had the last word via the toolResult? no — last entry
		// is a toolResult, so outcome is "open" until an assistant closes it.
	});

	it("prefers the latest compaction summary as intent", () => {
		const raw = jl(
			header(),
			userMsg("m1", "original first question"),
			compaction("Refactored the auth module and added retry logic."),
			assistantText("m2", "done"),
		);
		const d = parseSessionDetailText(raw)!;
		expect(d.recap.intent).toBe("Refactored the auth module and added retry logic.");
	});

	it("marks outcome 'landed' when an assistant turn closes the session", () => {
		const raw = jl(
			header(),
			userMsg("m1", "hi"),
			assistantText("m2", "all done, the tests pass"),
		);
		const d = parseSessionDetailText(raw)!;
		expect(d.recap.outcome).toBe("landed");
		expect(d.recap.lastActionKind).toBe("assistant");
		expect(d.recap.nextStep).toBeUndefined();
	});

	it("marks outcome 'abandoned' on a trailing tool error and suggests a retry", () => {
		const raw = jl(
			header(),
			userMsg("m1", "run the migration"),
			assistantToolCall("m2", "bash", { command: "npm run migrate" }),
			toolResult("m3", "bash", true),
		);
		const d = parseSessionDetailText(raw)!;
		expect(d.recap.outcome).toBe("abandoned");
		expect(d.recap.lastAction).toBe("bash: npm run migrate");
		expect(d.recap.nextStep).toBe("Retry the failed bash");
	});

	it("marks outcome 'open' when ending on an unanswered user message", () => {
		const raw = jl(
			header(),
			userMsg("m1", "first"),
			assistantText("m2", "sure"),
			userMsg("m3", "what about the edge case with empty input?"),
		);
		const d = parseSessionDetailText(raw)!;
		expect(d.recap.outcome).toBe("open");
		expect(d.recap.nextStep).toBe("Resume: what about the edge case with empty input?");
	});

	it("falls back to 'Resume: <latest user msg>' for ordinary multi-turn sessions", () => {
		// Last action is a read (not edit/write), session closed by an assistant —
		// no concrete tool-step, so we surface the latest user intent instead.
		const raw = jl(
			header(),
			userMsg("m1", "first question about the build"),
			assistantToolCall("m2", "read", { path: "/p/README.md" }),
			toolResult("m3", "read", false),
			assistantText("m4", "here is what i found"),
		);
		const d = parseSessionDetailText(raw)!;
		expect(d.recap.outcome).toBe("landed");
		expect(d.recap.nextStep).toBe("Resume: first question about the build");
	});

	it("suggests verifying an edit/write even when it landed cleanly", () => {
		const raw = jl(
			header(),
			userMsg("m1", "add the retry"),
			assistantToolCall("m2", "write", { path: "/p/src/retry.ts" }),
			toolResult("m3", "write", false),
			assistantText("m4", "wrote it"),
		);
		const d = parseSessionDetailText(raw)!;
		expect(d.recap.outcome).toBe("landed");
		expect(d.recap.nextStep).toBe("Verify the write to retry.ts");
	});

	it("renders a bash tool call with its command", () => {
		const raw = jl(
			header(),
			assistantToolCall("m1", "bash", { command: "cd /p && npm test" }),
		);
		const d = parseSessionDetailText(raw)!;
		expect(d.recap.lastAction).toBe("bash: cd /p && npm test");
	});

	it("counts message entries", () => {
		const raw = jl(
			header(),
			userMsg("m1", "a"),
			assistantText("m2", "b"),
			toolResult("m3", "edit", false),
		);
		expect(parseSessionDetailText(raw)!.recap.messageCount).toBe(3);
	});

	it("skips malformed lines without throwing", () => {
		const raw = jl(
			header(),
			"this is not json",
			userMsg("m1", "hello"),
			"{ broken",
		);
		const d = parseSessionDetailText(raw)!;
		expect(d.recap.intent).toBe("hello");
		expect(d.recap.messageCount).toBe(1);
	});

	it("falls back to a placeholder intent when there is nothing to show", () => {
		const d = parseSessionDetailText(header())!;
		expect(d.recap.intent).toBe("(no recorded intent)");
		expect(d.recap.lastActionKind).toBe("none");
	});
});

// ── match locator ───────────────────────────────────────────────────

describe("parseSessionDetailText — locator", () => {
	it("locates the message containing the least-common term", () => {
		const raw = jl(
			header(),
			userMsg("m1", "let's debug the timeout"),
			assistantText("m2", "the timeout is probably the lambda cold start"),
			userMsg("m3", "what about the stripe webhook retries"),
		);
		const d = parseSessionDetailText(raw, ["stripe"])!;
		expect(d.locator).not.toBeNull();
		expect(d.locator!.entryId).toBe("m3");
		expect(d.locator!.index).toBe(3);
		expect(d.locator!.total).toBe(3);
		expect(d.locator!.text).toContain("stripe");
	});

	it("picks the rarest term as the anchor", () => {
		// "rareword" appears once; "the" appears many times → anchor on rareword.
		const raw = jl(
			header(),
			userMsg("m1", "the the the common the the"),
			userMsg("m2", "look at rareword here"),
		);
		const d = parseSessionDetailText(raw, ["the", "rareword"])!;
		expect(d.locator!.entryId).toBe("m2");
		expect(d.locator!.index).toBe(2);
	});

	it("locates terms that appear in tool-call arguments (e.g. a filename)", () => {
		const raw = jl(
			header(),
			userMsg("m1", "fix it"),
			assistantToolCall("m2", "edit", { path: "/p/ApiRouter.cs" }),
		);
		const d = parseSessionDetailText(raw, ["ApiRouter"])!;
		expect(d.locator!.entryId).toBe("m2");
		expect(d.locator!.text).toContain("ApiRouter");
	});

	it("returns null locator when no query terms are given", () => {
		const raw = jl(header(), userMsg("m1", "hello"));
		expect(parseSessionDetailText(raw)!.locator).toBeNull();
	});

	it("returns null locator when no term occurs in any message", () => {
		const raw = jl(header(), userMsg("m1", "hello world"));
		expect(parseSessionDetailText(raw, ["nonexistent"])!.locator).toBeNull();
	});

	it("honors case sensitivity", () => {
		const raw = jl(header(), userMsg("m1", "Find the Stripe integration"));
		const ci = parseSessionDetailText(raw, ["stripe"])!;
		const cs = parseSessionDetailText(raw, ["stripe"], { caseSensitive: true, matchMode: "and", snippetChars: 160, rankMode: "heuristic" })!;
		expect(ci.locator).not.toBeNull(); // case-insensitive matches "Stripe"
		expect(cs.locator).toBeNull(); // case-sensitive: "stripe" ≠ "Stripe"
	});
});

// ── facets (item 1) ─────────────────────────────────────────────

describe("parseSessionDetailText — facets", () => {
	it("collects models from assistant provider/model, deduped (first-seen)", () => {
		const raw = jl(
			header(),
			userMsg("m1", "go"),
			assistantRich("m2", { provider: "anthropic", model: "claude-3.5-sonnet", text: "ok" }),
			assistantRich("m3", { provider: "anthropic", model: "claude-3.5-sonnet", text: "ok2" }), // dup
			assistantRich("m4", { provider: "openai", model: "gpt-4o", text: "ok3" }),
		);
		expect(parseSessionDetailText(raw)!.facets.models).toEqual([
			"anthropic/claude-3.5-sonnet",
			"openai/gpt-4o",
		]);
	});

	it("collects models from model_change entries (uses modelId)", () => {
		const raw = jl(
			header(),
			assistantRich("m1", { provider: "anthropic", model: "claude-3.5-sonnet" }),
			modelChange("openai", "gpt-4o"),
		);
		expect(parseSessionDetailText(raw)!.facets.models).toEqual([
			"anthropic/claude-3.5-sonnet",
			"openai/gpt-4o",
		]);
	});

	it("builds the tool histogram sorted by count desc, capped at 5", () => {
		// bash×3 then five distinct count-1 tools → 6 distinct, cap drops one.
		const calls: [string, Obj][] = [
			["bash", { command: "x" }],
			["bash", { command: "x" }],
			["bash", { command: "x" }],
			["edit", { path: "/p/a.ts" }],
			["write", { path: "/p/b.ts" }],
			["read", { path: "/p/c.ts" }],
			["glob", { pattern: "*.ts" }],
			["grep", { pattern: "foo" }],
		];
		const raw = jl(
			header(),
			...calls.map(([n, a], i) => assistantToolCall(`m${i}`, n, a)),
		);
		const tc = parseSessionDetailText(raw)!.facets.toolCalls;
		expect(tc).toHaveLength(5); // 6 distinct → capped
		expect(tc[0]).toEqual({ name: "bash", count: 3 }); // count desc
	});

	it("filesModified captures edit/write paths deduped; excludes read/bash", () => {
		const raw = jl(
			header(),
			assistantToolCall("m1", "edit", { path: "/p/a.ts" }),
			assistantToolCall("m2", "write", { path: "/p/b.ts" }),
			assistantToolCall("m3", "read", { path: "/p/c.ts" }),
			assistantToolCall("m4", "bash", { command: "rm -rf /" }),
			assistantToolCall("m5", "edit", { path: "/p/a.ts" }), // dup
		);
		expect(parseSessionDetailText(raw)!.facets.filesModified).toEqual(["/p/a.ts", "/p/b.ts"]);
	});

	it("sums cost and tokens across assistant messages", () => {
		const raw = jl(
			header(),
			assistantRich("m1", { provider: "anthropic", model: "x", cost: 0.1, tokens: 1000 }),
			assistantRich("m2", { provider: "anthropic", model: "x", cost: 0.32, tokens: 200000 }),
		);
		const f = parseSessionDetailText(raw)!.facets;
		expect(f.totalCost).toBeCloseTo(0.42, 5);
		expect(f.totalTokens).toBe(201000);
	});

	it("facets default to empty when nothing is collectable", () => {
		const d = parseSessionDetailText(jl(header(), userMsg("m1", "hi")))!;
		expect(d.facets.models).toEqual([]);
		expect(d.facets.toolCalls).toEqual([]);
		expect(d.facets.filesModified).toEqual([]);
		expect(d.facets.totalCost).toBeUndefined();
		expect(d.facets.totalTokens).toBeUndefined();
	});
});

// ── file reader ─────────────────────────────────────────────────────

describe("parseSessionDetail (file)", () => {
	it("returns null for a missing file instead of throwing", () => {
		expect(parseSessionDetail("/does/not/exist.jsonl")).toBeNull();
	});
});
