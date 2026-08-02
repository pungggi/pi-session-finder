/**
 * pi-session-finder — lazy session detail parser (PLAN.md item 7).
 *
 * Reads a session JSONL on demand and derives:
 *   - a "Previously on…" recap (intent / last action / outcome / heuristic
 *     next step) shown in a widget after we jump into the session; and
 *   - a match locator: the entry id + 1-based index of the message containing
 *     the least-common query term, plus a text window around it. We can't
 *     auto-scroll to it (no API — see PLAN.md item 7 / the upstream issue), so
 *     the card surfaces the content + position so the user can find it.
 *
 * No pi imports — operates on raw JSONL text + `node:fs`. Fully unit-testable
 * via {@link parseSessionDetailText}.
 *
 * Schema (verified against real session files):
 *   - entry envelope: { type, id, timestamp, message?, summary? }
 *   - message.role ∈ "user" | "assistant" | "toolResult"
 *   - assistant content[] blocks: {type:"text",text} | {type:"toolCall",name,arguments}
 *   - toolResult message: { toolName, isError, content, details }
 *   - compaction entry: { type:"compaction", summary }
 *
 * NB: item 1's rich facets (models / tool histogram / files-modified / cost)
 * are not collected here yet — `SessionDetail` is shaped so they can be added
 * to this same module without changing the recap/locator contract.
 */

import { readFileSync } from "node:fs";
import { extractSnippet, type SearchConfig } from "./search.js";

export type Outcome = "landed" | "abandoned" | "open";

export interface SessionRecap {
	/** What the session was about: latest compaction summary, else first user msg. */
	intent: string;
	/** Human-readable last action (rendered tool call, or trailing text). */
	lastAction: string;
	lastActionKind: "tool" | "assistant" | "user" | "none";
	/** Heuristic suggested next step; omitted when none applies. */
	nextStep?: string;
	/** Coarse terminal-state badge derived from the tail. */
	outcome: Outcome;
	/** Number of `message` entries parsed. */
	messageCount: number;
}

export interface MatchLocator {
	/** Entry id of the message containing the anchor term (for a future scrollTo). */
	entryId: string;
	/** 1-based position among message entries. */
	index: number;
	total: number;
	/** ±window snippet of that message centered on the least-common matched term. */
	text: string;
}

export interface SessionDetail {
	recap: SessionRecap;
	locator: MatchLocator | null;
}

const INTENT_MAX = 300;
const ACTION_MAX = 120;
const STEP_MAX = 100;
const LOCATOR_WINDOW = 320;

type Obj = Record<string, unknown>;
interface ToolCallInfo {
	name: string;
	args: Obj;
}

/** Read + parse a session file. Returns null on missing/unreadable. Never throws. */
export function parseSessionDetail(
	path: string,
	queryTerms?: readonly string[],
	config?: SearchConfig,
): SessionDetail | null {
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch {
		return null;
	}
	return parseSessionDetailText(raw, queryTerms, config);
}

/** Parse session JSONL text. Pure + unit-testable (no fs). */
export function parseSessionDetailText(
	raw: string,
	queryTerms?: readonly string[],
	config?: SearchConfig,
): SessionDetail | null {
	const caseSensitive = config?.caseSensitive ?? false;
	const lower = (s: string): string => (caseSensitive ? s : s.toLowerCase());

	const messages: { id: string; text: string }[] = [];
	let firstUserMessage = "";
	let lastCompactionSummary = "";
	let lastToolCall: ToolCallInfo | null = null;
	let lastToolResultIsError: boolean | null = null;
	let lastAssistantText = "";
	let lastUserMessage = "";
	let lastEntryRole: "user" | "assistant" | "toolResult" | null = null;

	for (const line of raw.split("\n")) {
		const cleaned = line.replace(/^\uFEFF/, "").trim();
		if (!cleaned) continue;
		let obj: Obj;
		try {
			obj = JSON.parse(cleaned) as Obj;
		} catch {
			continue; // skip malformed lines
		}

		if (obj.type === "compaction") {
			const s = obj.summary;
			if (typeof s === "string" && s) lastCompactionSummary = s; // latest wins
			continue;
		}
		if (obj.type !== "message") continue;

		const msg = obj.message as Obj | undefined;
		if (!msg || typeof msg !== "object") continue;
		const id = typeof obj.id === "string" ? obj.id : "";
		const role = typeof msg.role === "string" ? (msg.role as string) : "";
		const text = extractMessageText(msg);
		messages.push({ id, text });

		if (role === "user") {
			const u = extractTextContent(msg.content);
			if (u) {
				if (!firstUserMessage) firstUserMessage = u;
				lastUserMessage = u;
			}
		} else if (role === "assistant") {
			const a = extractTextContent(msg.content);
			if (a) lastAssistantText = a;
			const tc = lastToolCallIn(msg.content);
			if (tc) lastToolCall = tc;
		} else if (role === "toolResult") {
			if (typeof msg.isError === "boolean") lastToolResultIsError = msg.isError;
		}
		if (role === "user" || role === "assistant" || role === "toolResult") {
			lastEntryRole = role;
		}
	}

	const intent =
		(lastCompactionSummary && truncate(collapse(lastCompactionSummary), INTENT_MAX)) ||
		(firstUserMessage && truncate(collapse(firstUserMessage), INTENT_MAX)) ||
		"(no recorded intent)";

	let lastAction: string;
	let lastActionKind: SessionRecap["lastActionKind"];
	if (lastToolCall) {
		lastAction = truncate(renderToolCall(lastToolCall), ACTION_MAX);
		lastActionKind = "tool";
	} else if (lastAssistantText) {
		lastAction = truncate(collapse(lastAssistantText), ACTION_MAX);
		lastActionKind = "assistant";
	} else if (lastUserMessage) {
		lastAction = truncate(collapse(lastUserMessage), ACTION_MAX);
		lastActionKind = "user";
	} else {
		lastAction = "(none)";
		lastActionKind = "none";
	}

	// Coarse terminal-state heuristic:
	//   - trailing tool error        → abandoned
	//   - assistant had the last word → landed
	//   - ended on an unanswered user → open
	const outcome: Outcome =
		lastToolResultIsError === true
			? "abandoned"
			: lastEntryRole === "assistant"
				? "landed"
				: "open";

	const nextStep = deriveNextStep({ outcome, lastToolCall, lastUserMessage });

	const recap: SessionRecap = {
		intent,
		lastAction,
		lastActionKind,
		nextStep,
		outcome,
		messageCount: messages.length,
	};

	const locator = buildLocator(messages, queryTerms, caseSensitive);
	return { recap, locator };
}

// ── content extraction ──────────────────────────────────────────────

/** Join `text` blocks of a message `content` (string or block array). */
function extractTextContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (block && typeof block === "object") {
			const b = block as Obj;
			if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
		}
	}
	return parts.join("\n");
}

/** Searchable text for a message incl. rendered tool calls (so terms in tool
 *  args — e.g. a filename — are locatable). */
function extractMessageText(msg: Obj): string {
	const role = typeof msg.role === "string" ? (msg.role as string) : "";
	const textual = extractTextContent(msg.content);
	if (role === "assistant") {
		const calls = toolCallsIn(msg.content);
		if (calls.length) return `${textual}\n${calls.map(renderToolCall).join("\n")}`;
	}
	return textual;
}

function toolCallsIn(content: unknown): ToolCallInfo[] {
	if (!Array.isArray(content)) return [];
	const out: ToolCallInfo[] = [];
	for (const block of content) {
		if (block && typeof block === "object") {
			const b = block as Obj;
			if (b.type === "toolCall" && typeof b.name === "string") {
				const args = (b.arguments && typeof b.arguments === "object"
					? b.arguments
					: {}) as Obj;
				out.push({ name: b.name, args });
			}
		}
	}
	return out;
}

function lastToolCallIn(content: unknown): ToolCallInfo | null {
	const calls = toolCallsIn(content);
	return calls.length ? calls[calls.length - 1] : null;
}

function renderToolCall(tc: ToolCallInfo): string {
	const { name, args } = tc;
	const path = typeof args.path === "string" ? args.path : "";
	const base = path ? basename(path) : "";
	if ((name === "edit" || name === "write" || name === "read") && base) {
		return `${name} ${base}`;
	}
	if (name === "bash") {
		const cmd = typeof args.command === "string" ? args.command : "";
		return cmd ? `bash: ${truncate(collapse(cmd), 60)}` : "bash";
	}
	return name;
}

// ── match locator ───────────────────────────────────────────────────

function buildLocator(
	messages: readonly { id: string; text: string }[],
	terms: readonly string[] | undefined,
	caseSensitive: boolean,
): MatchLocator | null {
	const effective = (terms ?? []).filter((t) => t.length > 0);
	if (effective.length === 0 || messages.length === 0) return null;

	const lower = (s: string): string => (caseSensitive ? s : s.toLowerCase());

	// Anchor = least-common term occurring in ≥1 message (local IDF proxy),
	// mirroring extractSnippet's rarest-term choice in search.ts.
	let anchor: string | null = null;
	let anchorTotal = Infinity;
	for (const t of effective) {
		let total = 0;
		for (const m of messages) total += countSubstrings(lower(m.text), lower(t));
		if (total > 0 && total < anchorTotal) {
			anchorTotal = total;
			anchor = t;
		}
	}
	if (!anchor) return null; // no term in any message → match was via name/cwd only

	let idx = -1;
	for (let i = 0; i < messages.length; i++) {
		if (lower(messages[i].text).includes(lower(anchor))) {
			idx = i;
			break;
		}
	}
	if (idx === -1) return null; // defensive — anchor occurred, so unreachable

	const m = messages[idx];
	const text = extractSnippet(m.text, effective, {
		caseSensitive,
		matchMode: "and",
		snippetChars: LOCATOR_WINDOW,
	});
	return { entryId: m.id, index: idx + 1, total: messages.length, text };
}

function countSubstrings(haystack: string, needle: string): number {
	if (!needle) return 0;
	let count = 0;
	let i = haystack.indexOf(needle);
	while (i !== -1) {
		count++;
		i = haystack.indexOf(needle, i + needle.length);
	}
	return count;
}

// ── small helpers ───────────────────────────────────────────────────

function deriveNextStep(opts: {
	outcome: Outcome;
	lastToolCall: ToolCallInfo | null;
	lastUserMessage: string;
}): string | undefined {
	const { outcome, lastToolCall, lastUserMessage } = opts;
	if (outcome === "abandoned" && lastToolCall) {
		return `Retry the failed ${lastToolCall.name}`;
	}
	if (lastToolCall && (lastToolCall.name === "edit" || lastToolCall.name === "write")) {
		const base = basename(
			typeof lastToolCall.args.path === "string" ? lastToolCall.args.path : "",
		);
		return base ? `Verify the ${lastToolCall.name} to ${base}` : "Verify the change";
	}
	// Fallback: a substantive latest user message is the best re-entry cue for
	// multi-turn sessions (intent above is the *first* message; this is the
	// *latest*). Skipped for trivial single-turn sessions (e.g. "hi").
	if (lastUserMessage.trim().length > 10) {
		return `Resume: ${truncate(collapse(lastUserMessage), STEP_MAX)}`;
	}
	return undefined;
}

function basename(p: string): string {
	const segs = p.replace(/\\/g, "/").split("/").filter(Boolean);
	return segs.length ? segs[segs.length - 1] : p;
}

function truncate(s: string, max: number): string {
	return s.length <= max ? s : s.slice(0, Math.max(1, max - 1)) + "…";
}

function collapse(s: string): string {
	return s.replace(/\s+/g, " ").trim();
}
