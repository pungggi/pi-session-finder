# PLAN — no-DB `/find` refinements

Three in-scope refinements to `pi-session-finder`. **No DB, cache, or index** —
all run off the existing in-memory `SessionManager.listAll()` scan. Items 1 & 5
share the preview pane; item 6 is independent (ranking, pre-finder).

Supersedes nothing in `PRD.md`; these add behind their own toggles.

## Locked decisions (2026-08)

| # | Decision |
|---|---|
| Peek keys | `>` (forward) / `<` (back), special-cased before the printable→filter branch (stolen from filter input — accepted tradeoff) |
| Cost facet | Include `totalCost` + `totalTokens` in the preview pane |
| RRF default | Stays `heuristic`; `rrf` ships **opt-in**. Flip default only after a PRD §10 gold-set benchmark shows `rrf` ≥ `heuristic` (precision@k / nDCG) with no regression. The benchmark is the trigger — no arbitrary numeric gate |
| File facets | `filesModified` only (from `edit`/`write` toolCalls); **no** `filesRead` |

## Schema facts (verified against real session JSONL)

- Assistant `message`: `provider`, `model`, `usage.cost.total`,
  `usage.totalTokens`; `content[]` includes `{type:"toolCall", name, arguments:{path}}`.
- `filesModified` is extractable from `edit`/`write` toolCalls' `arguments.path`
  **directly** — no `toolResult` parsing needed (cleaner than the
  `samfoy/pi-session-search` parser, which paws through `toolResult.details`).
- `model_change`: `{provider, modelId}` (note: `modelId`, not `model`).

## Preview-pane layout (shared by items 1 & 5)

```
[focused title]
[cwd · modified DATE · N messages]
[Models: minimax/MiniMax-M3]
[Tools: bash(120), edit(27), read(20)…]
[Modified: extract_verses.py, …]
[Cost: $0.42 · 1.2M tokens]
───
[markdown snippet, paged by > / <]
```

Facets are fixed at the top (≤N lines, overflow→ellipsis); the paged snippet
region gets the remaining `snippetBudget`.

---

## Item 1 — Lazy rich preview pane

**Goal:** show models / tool histogram / files-modified / cost for the focused
session, parsed on demand.

**New `src/parse.ts`** (keeps `search.ts` pi-free & pure):

```ts
export interface SessionDetail {
  models: string[];                              // `${provider}/${model}`, deduped, top ~3
  toolCalls: { name: string; count: number }[];  // sorted desc, top 5
  filesModified: string[];                       // edit/write toolCalls, top 10
  totalCost?: number;
  totalTokens?: number;
}
export function parseSessionDetail(path: string): SessionDetail | null
```

- Walk JSONL lines, `JSON.parse` each, skip malformed. Collect from
  `message.role==="assistant"` (models via `provider`/`model`; cost/tokens via
  `usage`; scan `content[]` for `type==="toolCall"` → bump `toolCalls[name]`;
  if `name∈{edit,write}` push `arguments.path`) and `type==="model_change"`
  (`provider`/`modelId`).
- **No `assistantText` extraction** — we already have `allMessagesText` for
  snippets, so this is lighter/faster than the reference parser.
- Return `null` on missing/corrupt/unreadable → caller falls back to
  snippet-only. Never throw.
- Cap lines scanned (e.g. 50k) so a giant session can't stall the pane.

**Wiring (`finder.ts` + `index.ts`):**

- `FinderOptions.loadDetail?: (path: string) => Promise<SessionDetail | null>`.
- Component holds `detailCache: Map<path, SessionDetail | null>` +
  `pending: Set<path>`.
- On focus change (`onSelectionChange`, `refreshFilter`'s `items[0]`, init): if
  cache miss & `loadDetail` set → mark pending, `loadDetail(path).then(d => {
  cache.set(path, d); this.requestRender(); })`.
- `render()`: facets when cache hit; dim `loading…` while
  `pending.has(path)`; snippet-only when `null`/absent. Late resolves just
  populate the cache — harmless.
- Async (not sync `readFileSync`) so focus navigation never blocks input.

**Setting:** `findSession.richPreview` (default `true`).

**Tests (`test/parse.test.ts`):** fixture JSONL → expected models/toolCounts/
filesModified/cost; malformed line skipped; missing file → `null`; `edit`/`write`
captured, `bash`/`read` excluded from filesModified.

---

## Item 5 — Peek / page key

**Goal:** page through more of the focused session's text in-pane before
committing to a jump.

- `FinderEntry.fullText?: string` = `m.info.allMessagesText` in `buildEntries`
  (already resident from `listAll` — no new memory cost).
- `peekOffset: Map<path, number>` (char offset); default/absent = the snippet's
  term-anchor (current `extractSnippet` center). **Reset to anchor whenever
  `focusedEntry` changes.**
- Page step = `window × 0.8` (overlap so context isn't lost at the seam).

**Pure helper (`search.ts`, unit-testable):**

```ts
export function pageOffset(cur: number, delta: number, len: number, window: number): number
// clamps to [0, max(0, len − window)]
```

**Keys:** `>` forward / `<` back, handled in `handleInput` **before** the
printable→filter branch. No-op at bounds.

**Tests (`test/search.test.ts`):** `pageOffset` clamp / overlap / zero-len;
focus-change reset verified via a component test hook.

---

## Item 6 — RRF as a technique, not infrastructure

**Goal:** replace the hand-tuned `(nameMatch, termCount, recency)` lexicographic
sort with rank-fusion of independent in-memory signals via Reciprocal Rank
Fusion.

**`search.ts` additions (pure, no pi imports):**

```ts
export type RankMode = "heuristic" | "rrf" | "bm25";
// SearchConfig.rankMode: RankMode  (default "heuristic")

export function fuseRanks(lists: RankedMatch[][], k = 60): RankedMatch[]
```

- Core rankers (each returns a full ranked list over the matched set):
  1. **name-priority** — name/cwd matches above text-only.
  2. **term-coverage** — distinct matched terms desc (today's signal b).
  3. **recency** — `modified` desc.
  4. *(optional)* **term-frequency** — total query-term occurrences in
     `allMessagesText` (cheap BM25-ish without length norms).
- `fuseRanks`: score `Σ_i 1/(k + rank_i)`, `rank_i` = 1-based position in
  ranker `i` (absent → no contribution); sort desc; final tiebreak `modified`
  desc for determinism. `k=60` is the literature default (Cormack et al. 2009).
- `rankMatches` dispatches on `config.rankMode`.

**Default stays `"heuristic"`.** Flip to `"rrf"` only after benchmarking per
PRD §10 (see locked decisions). Reconciles with PRD's reserved `"bm25"` —
`rankMode` becomes `"heuristic" | "rrf" | "bm25"`.

**Tests (`test/search.test.ts`):** `fuseRanks` on synthetic ranked lists →
expected order; agreement-boosts-agreement (two rankers both ranking X first →
X wins); tiebreak determinism; `k` sensitivity smoke test.

**Risk:** lowest of the three (pure, opt-in, fully unit-testable).

---

## Phasing & ordering

| # | Order | Why | Setting | Version |
|---|---|---|---|---|
| 6 | **1st (or parallel)** | independent of UI; pure; lowest risk | `rankMode:"rrf"` (opt-in) | minor |
| 1 | 2nd | introduces the parser + pane layout that 5 builds on | `richPreview` (default `true`) | minor |
| 5 | 3rd | reuses 1's pane + focus hook | — | patch |

Each ships behind its own toggle and its own version bump — no big-bang.

## Files touched

| File | 1 | 5 | 6 |
|---|---|---|---|
| `src/parse.ts` (new) | ✓ | | |
| `src/finder.ts` | ✓ (facets + async load) | ✓ (peek state + keys) | |
| `src/index.ts` | ✓ (wire `loadDetail`) | ✓ (`fullText` on entry) | |
| `src/search.ts` | `SessionDetail` type only | `pageOffset` | `fuseRanks` + `rankMode` |
| `test/parse.test.ts` (new) | ✓ | | |
| `test/search.test.ts` | | ✓ | ✓ |
| `PRD.md` | §7 pane, §8.2 module | §7 keys | §FR-2, §12 |

---

## Item 7 — Recap-at-landing + match locator (near-term build)

**Scope decision (2026-08, after API verification):** the user asked for
"jump + land at the exact message + recap card." Verified against pi's
extension API:

| Sub-feature | Verdict | Mechanism |
|---|---|---|
| Recap card at landing | ✅ build | `ctx.ui.setWidget("find-recap", lines, { placement: "aboveEditor" })` inside `switchSession({ withSession })` |
| "Previously on…" content | ✅ build | JSONL tail parse: intent (first user msg / compaction summary) → last action (last tool call / assistant text) → outcome badge → heuristic "likely next step" |
| Land at exact message (auto-scroll) | ❌ **blocked** | no `openAt`/`entryId` option on `switchSession`; no `scrollToEntry`/`focusEntry` anywhere in the extension API |

**Salvage for "land at message":** the recap card carries a **match locator** —
the matched message's content + its index (`message #42 of 128`) — so the user
sees the relevant text immediately and knows where to scroll. True auto-scroll
needs an **upstream pi API** (`switchSession(path, { entryId })` or
`ctx.ui.scrollToEntry(id)`); tracked as an open ask (see PRD §12 v2 note).

**Data sources (JSONL, all confirmed present):** `type:"compaction"` `.summary`;
first / last user message; last assistant text; last `toolCall`
(`name`, `arguments`); entry `id` + its position; `messageCount`.

**"Likely next step" is heuristic (no LLM):** last failed tool → "retry X";
last write/edit → "verify/test X"; unanswered trailing user msg →
"continue: <msg>"; else omit. An optional LLM-generated recap is a later
enhancement (would need model access from an extension — out of scope here).

**Builds on item 1's parser:** extend `parseSessionDetail` (or add
`parseSessionRecap`) to also return `{ intent, lastAction, nextStep, outcome,`
`match: { entryId, index, total, text } }` for a given query anchor. Wire in
`index.ts`: after `switchSession`, `withSession(rcx)` builds the card and calls
`rcx.ui.setWidget("find-recap", lines, { placement: "aboveEditor" })`. Clear it
on next user input or after N seconds (avoid stale pinning).

**Setting:** `findSession.recapOnJump` (default `true`).

**Tests:** `test/parse.test.ts` — recap derivation from fixture tails
(compaction vs. first-msg intent; last-action extraction; next-step heuristic
branches; match-locator index); malformed/missing → null.

**Risk:** none of the extension-API variety beyond the blocked auto-scroll;
mainly content-quality of the heuristic next-step (iterate after dogfooding).

---

## Future / horizon (recorded per request; not scheduled)

### H1 — Session-graph view

Model sessions as a tree via `parentSessionPath`. For a project, render the
branches you tried and surface the **successful leaf** (outcome badge ✅ from
the outcome-aware idea). Search traverses the graph: a query match in a parent
resolves to its landed child — turns "find a session" into "find the branch
that worked." Building blocks: `parentSessionPath` (have it), outcome badges
(item 7 / outcome-aware), a tree TUI component (new). `fork(entryId,` `{position})` exists for graph navigation.

### H2 — Proactive jump suggestions

While working in the *current* session, watch the latest user message; if it
matches a past **resolved** session, show a subtle widget: "you solved this in
\<session> (2w ago) — jump?" Ambient, actionable recall — the other ext's
primer only *tells* the agent; this *offers the user a jump* (our moat). Needs
a lightweight background matcher over the current message (in-memory,
debounced) feeding the recap/jump path from item 7. **Cost guard:** must stay
off the critical path — debounce heavily and yield before any scan (cf.
`pi-session-search`'s `setImmediate` TTFT guard).
