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

// ── file reader ─────────────────────────────────────────────────────

describe("parseSessionDetail (file)", () => {
	it("returns null for a missing file instead of throwing", () => {
		expect(parseSessionDetail("/does/not/exist.jsonl")).toBeNull();
	});
});
