# PRD: `pi-find-session` — Cross-Project Session Search & Jump

| Field | Value |
|---|---|
| **Package name** | `pi-find-session` (proposed npm: `@<you>/pi-find-session`) |
| **Type** | pi package (single TypeScript extension) |
| **Status** | Draft v0.2 (research evidence applied) |
| **Author** | _ |
| **pi keyword** | `pi-package` |
| **Research basis** | `RESEARCH.md` (structured lit review) + Appendix E (decision→source map) |

---

## 1. TL;DR

A pi extension that adds a `/find [keyword…]` command. It full-text searches **every** past session across **all** projects, shows matching sessions with the keyword in context, and on selection **switches to that session and its project directory** — same outcome as `/resume`, but driven by content search instead of a name picker.

> **Why now:** pi's built-in `/resume` picker uses `SessionManager.listAll()` but only filters by session name / first message. There is no way to "find the session where I worked on X." Users currently `rg` the `~/.pi/agent/sessions/` JSONL tree by hand (83 project subfolders on this machine).

---

## 2. Background

- Sessions are JSONL files under `~/.pi/agent/sessions/--<encoded-cwd>--/<timestamp>_<uuid>.jsonl`, one folder per working directory. The first line (`SessionHeader`) stores the real `cwd`.
- `SessionManager.listAll()` already enumerates **all** sessions across all projects and returns a `SessionInfo[]` (see Appendix A). Crucially it pre-extracts **`allMessagesText`**, so full-text keyword matching requires **no JSONL parsing** by the extension.
- Switching to a session via `ctx.switchSession(path)` opens that session and adopts its `cwd`, re-running **project trust** for the new project (verified in `agent-session-runtime.js`: `SessionManager.open(path)` → `getCwd()` → `projectTrustContextFactory(cwd)`). So a single API call moves both the conversation **and** the working directory.

**The gap:** `/resume` exposes `listAll()` but filters only on name/first-line. There is no content (keyword) search and no `/find` command.

---

## 3. Goals

- **G1** — Search the full text of **all** sessions (all projects) for one or more keywords.
- **G2** — Return matches ranked by relevance/recency with the keyword shown in context (snippet).
- **G3** — One action to jump to the chosen session **and** its project `cwd`, honoring project trust.
- **G4** — Feel native: same UX affordances as `/resume` (fuzzy filter, project name, timestamps, Esc to cancel), no external CLIs required.
- **G5** — Work as a distributable `pi-package` (`pi install npm:@<you>/pi-find-session`), no bundled deps beyond pi peer packages.

## 4. Non-Goals

- Full-text search *engine*/indexing service, embeddings, or semantic search (v2+ at most). Searching **raw** `allMessagesText` rather than summaries/extractions is an intentional, evidence-backed choice — retrieval quality outranks write-time summarisation (LoCoMo diagnostic study; see RESEARCH.md §2.6, Appendix E D6).
- Editing or merging sessions.
- Searching **within** a session's tree branches in detail (we match flat `allMessagesText`).
- Replacing `/resume`; `/find` is additive.
- Network/cloud sync.

---

## 5. User Stories

| # | As a… | I want to… | So that… |
|---|---|---|---|
| US1 | returning user | type `/find stripe webhook` | I instantly find the session/project where I debugged that, even weeks later. |
| US2 | multi-project dev | see the **project path** for each match | I know where I'll land before I jump. |
| US3 | returning user | pick a result and be dropped into that session **and** folder | I don't have to manually `cd` + `/resume` separately. |
| US4 | returning user | narrow results by typing more | I don't drown in matches on common words. |
| US5 | returning user | see the matching line/snippet | I can tell which hit is the right one. |
| US6 | returning user | cancel safely with `Esc` | nothing changes if I was just browsing. |
| US7 | CLI user | run `pi --find "stripe webhook"` | I can jump straight from a fresh shell. |

---

## 6. Functional Requirements

### FR-1  Command surface
- Register command **`/find`** via `pi.registerCommand("find", { description, handler })`.
- Accept free-text args: the remainder of the line is the search query (one or more keywords). Quoted phrases supported (`/find "stripe webhook"`).
- `/find` with **no args** opens an empty search prompt (type to search), mirroring `/resume`'s empty-open behavior.

### FR-2  Search semantics
- **Scope:** every session returned by `SessionManager.listAll()`.
- **Match targets (any hit counts):**
  - `SessionInfo.name` (display name)
  - `SessionInfo.cwd` (project path — lets `/find BusinessCentral` match by project)
  - `SessionInfo.allMessagesText` (concatenated user + assistant + tool text)
- **Default mode:** case-insensitive **AND** of all query terms (all terms must appear somewhere).
- **Snippet:** for each match, locate the **least-common (highest-IDF) matched query term** occurrence in `allMessagesText` (better disambiguation than the first term — Käki 2006; Manning et al. 2008 §8.7) and extract ±N chars (default 160) around it, trimming to token boundaries; collapse newlines. Single-term queries fall back to the first occurrence.
- **Ranking (MVP heuristic):** (a) name match first, then (b) number of distinct query terms matched desc, then (c) `modified` desc. A hand-tuned analogue of the IDF intuition — rare terms discriminate better (Spärck Jones 1972; Robertson & Zaragoza 2009).
- **Ranking (v1.1, opt-in `rankMode: "bm25"`):** score by **BM25-lite** — `Σ_t IDF(t) · (tf·(k₁+1))/(tf+k₁·(1−b+b·dl/avgdl))` with a recency tiebreak. Saturation-bounded + length-normalised; pays off as the corpus grows (Appendix E, D2).

### FR-3  Results & selection (TUI)
- Present results in an interactive list (see §7). Each row shows: **session name or first message** · **project folder (basename + parent)** · **modified date** · **message count**. The snippet is shown as a secondary line under the focused row.
- Left/right or a toggle key flips between "all projects" and "current project only" results.
- Confirm selects → call `ctx.switchSession(selected.path)`.
- `Esc`/`Ctrl+C` cancels (no state change).
- If **zero matches**: notify "No sessions matched '<query>'" and return.
- If **exactly one match** (configurable): offer auto-jump or still open the list with that row focused. Default: open the list.

### FR-4  Jump behavior
- On confirm: `await ctx.switchSession(match.path)`. This switches the session **and** the working directory and re-runs project trust for the target `cwd` (verified mechanism).
- Post-switch, surface a short confirmation in the replacement-session context, e.g. notify "Resumed '<name>' in <cwd basename>".
- If the switch returns `{ cancelled: true }` (an extension vetoed via `session_before_switch`), notify and abort.

### FR-5  Modes
- **TUI (`ctx.mode === "tui"`):** full interactive experience (FR-3).
- **RPC (`ctx.mode === "rpc"`):** fall back to `ctx.ui.select(...)` for a headless/rpc picker; same search + jump.
- **Print / JSON (`-p`, `--json`):** the command is a no-op (notify "use /find in interactive mode"); document the `pi --find` CLI flag (§11) as the print-mode path.

### FR-6  Configurability (settings)
Optional keys under a `findSession` object in `settings.json`:
| Key | Default | Purpose |
|---|---|---|
| `caseSensitive` | `false` | match case |
| `matchMode` | `"and"` | `"and"` \| `"or"` \| `"phrase"` |
| `snippetChars` | `160` | context window around hit |
| `autoJumpOnSingle` | `false` | jump immediately if one match |
| `scope` | `"all"` | `"all"` \| `"current"` default result scope |

---

## 7. UX Design (TUI)

Layout (custom component via `ctx.ui.custom`, consistent with pi theming):

```
┌ Find sessions: stripe webhook ──────────────────────────── (Ctrl+P: scope: all) ─┐
│                                                                                   │
│ ▸ Refactor auth module        BusinessCentral  · 2d ago · 128 msg                 │
│   …verified the **stripe webhook** signature in ApiRouter.cs and added retry…     │
│                                                                                   │
│   Payments POC                 ngTradr         · 9d ago ·  42 msg                 │
│   …stripe webhook listener for local testing…                                    │
│                                                                                   │
│   (3 matches · 83 projects scanned)                                              │
├───────────────────────────────────────────────────────────────────────────────────┤
│ filter: stripe webhook_        ↑↓ navigate  Enter jump  Esc cancel                │
└───────────────────────────────────────────────────────────────────────────────────┘
```

Keybindings (mirror `/resume` conventions):
| Key | Action |
|---|---|
| type | live-filter results (incremental AND over current result set) |
| `↑`/`↓` | navigate |
| `Enter` | jump to session |
| `Ctrl+P` | toggle scope: all projects ⇄ current project |
| `Ctrl+R` | re-run search (e.g. after editing the query box) |
| `Esc` / `Ctrl+C` | cancel |

Progress: `SessionManager.listAll(onProgress)` drives a footer status while scanning ("Scanning projects… 12/83").

---

## 8. Technical Design

### 8.1  Data flow

```
/find <query>
   │
   ▼
SessionManager.listAll(onProgress)        ← pi core: reads all sessions, all projects
   │  returns SessionInfo[]  (incl. allMessagesText, cwd, name, modified, …)
   ▼
matcher(query, sessions, config)          ← extension: filter + rank + snippet
   │  returns RankedMatch[]
   ▼
FinderComponent (ctx.ui.custom)           ← extension: interactive list + live filter
   │  user picks one
   ▼
ctx.switchSession(match.path)             ← pi core: switches session + cwd + trust
   │
   ▼
withSession(ctx => ctx.ui.notify(...))    ← replacement-session context
```

### 8.2  Core modules
- `index.ts` — factory; registers `/find` command + optional `--find` flag.
- `search.ts` — pure functions: `parseQuery`, `matchSession(info, query, config)`, `rankMatches`, `extractSnippet`. Fully unit-testable, no pi imports.
- `finder.tsx` — the TUI component (uses `@earendil-works/pi-tui`).
- `config.ts` — read/merge `findSession` settings with defaults.

### 8.3  Reuse the resume switch path (key recommendation)
`ctx.switchSession(path)` handles cwd + trust + `session_before_switch` veto + `session_shutdown`/`session_start` lifecycle for us. **Do not** re-implement session loading. The only thing `/find` owns is *which* session to switch to. If, during implementation, the extension-command `ctx.switchSession` path turns out **not** to re-run project trust for the new cwd the way `/resume` (`handleResumeSession`) does, fall back to one of:
1. Check `ctx.isProjectTrusted()` semantics for the target cwd before switching and prompt; or
2. Surface the standard trust prompt after switch via `session_start`.

> **Action item (Open Q1):** verify extension-command `switchSession` wires `projectTrustContextFactory`. The interactive resume path passes it explicitly; the extension `ctx.switchSession` signature only exposes `withSession`.

### 8.4  Snippet extraction detail
- Lowercase-compare on a lowercased copy of `allMessagesText`; slice on the **original** string to preserve case in the display.
- Collapse runs of whitespace/newlines to single spaces; append `…` if truncated at either end.
- **Term selection (now default, was "optional"):** center the snippet on the **least-common (highest-IDF) matched term**, not the first. *MVP proxy:* among matched terms pick the one with the fewest occurrences in that session's `allMessagesText` (a local IDF surrogate); v1.1 can switch to true collection IDF once the §8.5 cache exists. A good KWIC fragment must be (i) maximally informative, (ii) self-contained/readable, (iii) short (Manning et al. 2008 §8.7); Käki (2006) showed frequency-based selection improves result filtering (Appendix E, D3).
- Snippets must be fast (generated per result): build on demand from the cached text only; never re-parse the JSONL at render time (Bast & Celikik 2014).

### 8.5  Performance
- `listAll()` already reads every file to build `allMessagesText`; that cost is paid by pi regardless. With many large sessions this can take seconds. Mitigations:
  - Show `onProgress` status immediately.
  - Search in-memory once `listAll` resolves; live filtering afterwards is O(results), cheap.
  - Optional **session-level cache** keyed by file `mtime`+`size` (store `{mtime, size, allMessagesText, name, cwd, modified, messageCount}` in `~/.pi/agent/find-cache.json`). Re-scan only changed files. This is **selective per-file invalidation** (Baeza-Yates et al. 2010): because sessions are append-only, `(mtime,size)` is a sound staleness signature — a changed file always changes at least one of the two — so invalidate only the affected entry, never the whole cache.
  - Store a **fixed-size prefix** (e.g. 10k chars) of `allMessagesText` in the cache; matches beyond the prefix degrade gracefully (Manning et al. 2008, prefix-caching).
  - **Latency budget:** post-scan live filtering must stay **<100 ms** (O(results) string scans — trivially achievable). Latency beyond ~1 s measurably degrades search behaviour even before users notice (Arapakis et al. 2014).
  - Cap displayed results (e.g. 200) with a "more matches…" footer; ranking ensures the best stay on top.
- Streaming: consider yielding results as `listAll(onProgress)` reports batches, so the first hits render while later projects still scan (v2).

### 8.6  Trust & safety
- Switching into an untrusted project relies on pi's trust flow (do not bypass).
- The extension only **reads** sessions and calls a documented switch API — no writes to sessions.
- No keyword data leaves the machine; no telemetry.

---

## 9. Edge Cases & Error Handling

| Case | Behavior |
|---|---|
| No args | Open empty finder; type to search. |
| No matches | Notify `No sessions matched "<query>"`. |
| One match | Open list focused on it (or auto-jump if `autoJumpOnSingle`). |
| Query matches only in deleted/trashed files | Not listed (`listAll` reflects disk). |
| Target session's `cwd` missing/stale (`MissingSessionCwdError`) | pi prompts for cwd; we let that flow run. If command-path can't surface it, notify with a hint to use `/resume`. |
| Target project untrusted | pi trust prompt runs after switch. |
| `switchSession` returns `{ cancelled: true }` | Notify "Switch cancelled" and stay. |
| `ctx.mode` is `print`/`json` | No-op + notify; point to `pi --find`. |
| Very large `allMessagesText` (huge sessions) | Snippet caps prevent UI blowup; list row shows message count. |
| Duplicate query terms | De-duped before matching. |
| Regex/special chars | Treat query as plain substrings by default; add `matchMode: "regex"` later. Deferring fuzzy/approximate matching is IR-sanctioned: it is ≥O(m·n) per comparison without dedicated index structures (Navarro 2001). |

---

## 10. Testing Plan

- **Unit (`search.ts`):** query parsing (AND/OR/phrase, quotes, case), matching across `name`/`cwd`/`allMessagesText`, ranking order, snippet boundaries/trimming/ellipsis, empty + single-term + multi-term, Unicode.
- **Unit (cache):** hit/miss by `mtime`+`size`, corrupt-cache recovery.
- **Integration (manual):** create sessions in 2+ folders; `/find` across projects; jump verifies cwd changed (run `!pwd` after) and conversation restored; trust prompt appears for untrusted target.
- **Regression:** ensure `/resume` still works unchanged (we add, don't modify).

---

## 11. CLI Flag (stretch / v1.1)

Add a flag so launching pi can jump directly:

```bash
pi --find "stripe webhook"        # scans, picks best match or opens picker, then runs
```

Implemented via `pi.registerFlag("find", {...})`. If exactly one match, switch + start; if many, open the interactive finder after startup. Print mode prints the ranked list and exits.

---

## 12. Phasing

| Phase | Scope | Outcome |
|---|---|---|
| **MVP** | `index.ts` + `search.ts`; `/find <q>` using `ctx.ui.select` for the picker (no custom TUI); AND matching over `allMessagesText`+`name`+`cwd`; jump via `switchSession`. | Usable, shippable. |
| **v1** | Custom `FinderComponent` (§7): snippets, live filter, scope toggle, `onProgress` status. Tests. **Shipped: rich preview pane ✅ (item 1), peek `>`/`<` paging ✅ (item 5), recap-at-landing ✅ (item 7).** Settings are env-var knobs (`PI_FIND_*`) until pi exposes a config API. See `PLAN.md`. | Production polish. |
| **v1.1** | `pi --find` CLI flag. `matchMode` (or/phrase). **RRF rank-fusion shipped ✅ as opt-in** (`PI_FIND_RANK_MODE=rrf`, PLAN item 6; default flip still gated on §10 benchmark). `bm25` reserved. |
| **v2** | Streaming results, fuzzy match scoring (Navarro 2001), optional content index for very large histories, session-graph view + proactive jump suggestions (horizon H1/H2 — see `PLAN.md`). *Anchored "land at message" is API-blocked (PLAN.md item 7): no `openAt`/`entryId` on `switchSession`, no `scrollToEntry` in the extension API — recap-at-landing ships the feasible subset now; true auto-scroll needs an upstream pi API.* *If* semantic recall is ever requested, follow the hierarchical/graph-memory trajectory (HiGMem — Cao et al. 2026; MemORAI — Pham Van et al. 2026); explicitly a non-goal until then (D7). |

---

## 13. Open Questions

1. **OQ1 (must verify):** Does the extension-command `ctx.switchSession` path re-run project trust for the new cwd like `/resume` does? (See §8.3.) Determines whether we need a manual trust prompt.
2. **OQ2:** Command name collision — confirm no built-in `/find`. Candidate fallbacks: `/find-session`, `/f`, `/js` (jump-to-session).
3. **OQ3:** Should we also surface **fork** (jump-and-branch) vs pure **resume** from a result? (Probably v2; keep MVP to resume.)
4. **OQ4:** Indexing threshold — at how many sessions/MB does a cache/index become mandatory? **Resolution path:** measure cold-cache p50/p95 `listAll()` latency vs. session count/MB on the real machine + a 10k-session synthetic set; the §8.5 cache becomes mandatory where p95 crosses ~1 s (Arapakis et al. 2014). Full protocol in RESEARCH.md §3.3.
5. **OQ5:** Search tool-call **inputs/outputs** too, or only message text? `allMessagesText` already includes rendered tool content — confirm coverage during MVP.
6. **OQ6 (resolved — no action):** *Should `/find` also scan an archive directory (`~/.pi/agent/sessions-archive/`)?* **No — there is no archive in this pi version.** Verified against pi core: `SessionManager.listAll()` reads only `getSessionsDir()`, and pi has no `/archive` command, no `archiveDir` setting, no `PI_SESSION_ARCHIVE_DIR` env var, and never writes a `sessions-archive/` dir. `listAll()` therefore already returns the **complete** set of sessions. The `sessions-archive/` coverage advertised by `samfoy/pi-session-search` is that package's **own convention** (it honours an env var it defines itself), not a pi feature here. Revisit only if a future pi — or a rotation/memory package — introduces real session archival; until then, archive support would be speculative dead code (YAGNI).

---

## 14. Out of Scope

- Semantic/embedding search.
- Cross-machine / cloud session sync.
- Editing, deleting, or merging sessions (deletion stays in `/resume`).
- Per-branch tree search inside a session.

---

## Appendix A — `SessionInfo` (from `session-manager.d.ts`)

Returned by `SessionManager.listAll(onProgress?: SessionListProgress): Promise<SessionInfo[]>` and `SessionManager.list(cwd, sessionDir?, onProgress?)`.

```ts
interface SessionInfo {
  path: string;            // absolute .jsonl path  ← pass to ctx.switchSession()
  id: string;              // session UUID
  cwd: string;            // project working dir ("cwd" for old sessions)
  name?: string;          // display name (from session_info entries)
  parentSessionPath?: string;
  created: Date;
  modified: Date;
  messageCount: number;
  firstMessage: string;
  allMessagesText: string; // ← pre-extracted full text; search target
}
```

## Appendix B — Key APIs used

| API | Where | Role |
|---|---|---|
| `pi.registerCommand("find", { description, handler })` | extensions.md | register `/find` |
| `SessionManager.listAll(onProgress)` | session-format.md | enumerate all sessions, all projects |
| `ctx.ui.select(items)` / `ctx.ui.custom(builder)` | extensions.md (Custom UI) | picker (MVP / v1) |
| `ctx.switchSession(path, { withSession })` | extensions.md (ExtensionCommandContext) | jump + cwd + trust |
| `ctx.ui.notify(msg, level)` | extensions.md | feedback |
| `pi.registerFlag("find", {...})` | extensions.md | `pi --find` (v1.1) |

## Appendix C — File layout (proposed package)

```
pi-find-session/
├── package.json          # { name, keywords:["pi-package"], pi:{ extensions:["./src/index.ts"] } }
├── README.md
├── src/
│   ├── index.ts          # factory: registerCommand + registerFlag
│   ├── search.ts         # pure: parseQuery / matchSession / rankMatches / extractSnippet
│   ├── finder.tsx        # TUI component (v1)
│   └── config.ts         # settings merge
└── test/
    └── search.test.ts    # unit tests for matcher/ranker/snippet
```

## Appendix D — MVP pseudocode

```ts
import { SessionManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("find", {
    description: "Search all sessions and jump to a match",
    handler: async (args, ctx) => {
      const query = args.trim();
      if (ctx.mode !== "tui" && ctx.mode !== "rpc") {
        ctx.ui.notify("/find needs interactive mode — try: pi --find", "info");
        return;
      }

      const sessions = await SessionManager.listAll(() => {
        ctx.ui.setStatus("find", "Scanning all sessions…");
      });
      ctx.ui.setStatus("find", "");

      const matches = rankMatches(sessions, query);   // filter name+cwd+allMessagesText
      if (matches.length === 0) {
        ctx.ui.notify(`No sessions matched "${query}"`, "info");
        return;
      }

      const choice = await ctx.ui.select(
        `Jump to session (${matches.length} match${matches.length > 1 ? "es" : ""})`,
        matches.map(m => ({
          label: `${m.name ?? m.firstMessage.slice(0, 60)}  ·  ${projName(m.cwd)}  ·  ${ago(m.modified)}`,
          value: m.path,
          hint: extractSnippet(m.allMessagesText, query),
        })),
      );
      if (!choice) return; // cancelled

      await ctx.switchSession(choice, {
        withSession: async (rcx) => {
          const m = matches.find(x => x.path === choice);
          rcx.ui.notify(`Resumed "${m?.name ?? "session"}" in ${projName(m?.cwd ?? "")}`, "info");
        },
      });
    },
  });
}
```

## Appendix E — Research basis (decision → evidence)

Every load-bearing design choice in this PRD is traceable to a primary source. Full annotated review: `RESEARCH.md` (Introduction · Literature Review · Methodology · References). Inline citations below resolve to `RESEARCH.md` §4.

| ID | Design decision | Grounded in (source) | PRD section |
|---|---|---|---|
| **D1** | Default to exact, case-insensitive substring AND-matching; keep fuzzy/regex opt-in `matchMode`. | Navarro 2001; comparative study (IFAC 2020) | §FR-2, §FR-6, §9 |
| **D2** | MVP uses heuristic term-count ranking; v1.1 adds opt-in **BM25-lite** (`rankMode`) with recency tiebreak. | Spärck Jones 1972; Robertson & Zaragoza 2009; Robertson & Spärck Jones 1994 | §FR-2, §12 |
| **D3** | Snippet centers on the **least-common (highest-IDF)** matched term, not the first; honors KWIC criteria (informative / readable / short). MVP uses a local occurrence-count proxy. | Manning et al. 2008 §8.7; Käki 2006; Bast & Celikik 2014 | §FR-2, §8.4 |
| **D4** | Run `listAll()` once with `onProgress`; stream first hits; keep post-scan filtering <100 ms. | Arapakis et al. 2014 (latency↔behaviour); Ruotsalo et al. 2020 | §7, §8.5 |
| **D5** | `(mtime,size)`-keyed per-file cache; **selective** invalidation (never drop the whole cache); prefix-cache `allMessagesText`. | Brown et al. 1994; Baeza-Yates et al. 2010; Manning et al. 2008 | §8.5 |
| **D6** | Search **raw** `allMessagesText`, not summaries/extractions, for keyword recall. | LoCoMo diagnostic study (retrieval > write-strategy) | §FR-2, §4 |
| **D7** | Keep semantic/graph memory explicitly out of v1; document HiGMem/MemORAI as the v2+ trajectory. | Cao et al. 2026 (HiGMem); Pham Van et al. 2026 (MemORAI) | §4, §12 |

### Evaluation protocol (proposed — RESEARCH.md §3.3)
- **Effectiveness:** Precision@k / Recall on a hand-labelled `(query → session)` gold set; snippet A/B (first- vs least-common-term, cf. Käki 2006); nDCG for heuristic vs BM25-lite (D2).
- **Efficiency:** cold-cache p50/p95 `listAll()` latency vs. session-count/MB (resolves **OQ4**); warm-cache query latency (<100 ms target, D4); cache hit rate + verify zero false-fresh entries on the append-only workload (D5).
- **Interaction:** time-to-result and keystrokes-to-jump in a small user test, incremental-search style (Arapakis et al. 2014).
