# pi-session-finder

> Cross-project session search & jump for [pi](https://pi.dev).
>
> Adds a `/find [keywords…]` command that full-text searches **every** past
> session across **all** projects, shows the matches with the keyword in
> context, and on selection **switches to that session and its project
> directory** — the same outcome as `/resume`, but driven by content search
> instead of a name picker.

## Why

pi's built-in `/resume` picker filters sessions by name / first message only.
There is no way to *"find the session where I worked on X."* This extension
searches the full text of every session (via `SessionManager.listAll()`, which
already pre-extracts `allMessagesText`) and jumps you straight there.

## Install

```bash
pi install npm:pi-session-finder
```

Or load it ad-hoc:

```bash
pi -e ./src/index.ts
```

## Usage

```
/find stripe webhook        # AND-match across name, cwd, and full message text
/find "stripe webhook"      # quoted phrase → matched as a single substring
/find BusinessCentral       # matches by project path too
/find                       # opens a search prompt (type to search)
/find-back                  # jump back to the previous session/project
```

Pick a result with the arrow keys + `Enter` to switch into that session **and**
its working directory (pi re-runs project trust for the target `cwd`, just like
`/resume`). `Esc` / `Ctrl+C` cancels.

Each result shows the session name (or first message), the project folder, how
long ago it was modified, the message count, and a snippet of the matching text.

### Going back: `/find-back`

Every time you switch sessions — via `/find`, `/resume`, `/new`, `/fork`, or
`/clone` — pi fires `session_start` with the file you just left. This extension
records that onto a small navigation stack so **`/find-back`** replays it in
reverse: a browser-style back across sessions **and** projects.

- Repeat `/find-back` to walk further back through the chain.
- Deleted sessions at the top of the stack are skipped automatically.
- A one-shot guard prevents ping-pong: the back-jump itself isn't re-recorded,
  so the next `/find-back` goes one step further, not back to where you were.

The stack lives in `~/.pi/agent/session-finder/backstack.json` (honours
`PI_CODING_AGENT_DIR`). It is **on disk**, not in memory, because a cross-project
jump reloads this extension module and would wipe in-memory state. It is capped
at 50 entries.

### Where it works

`/find` is interactive (TUI and RPC modes). In print / JSON mode it is a no-op
that points you at the (planned) `pi --find` CLI flag.

## How it matches & ranks

- **Scope:** every session, every project.
- **Match targets:** session `name`, `cwd`, and the full `allMessagesText`.
- **Default:** case-insensitive **AND** of all terms (quoted phrases become one
  term). `or` / `phrase` modes are implemented and ready for a settings hook.
- **Snippet:** centered on the **least-common matched term** (a local IDF
  surrogate — rare terms disambiguate better), trimmed to token boundaries,
  whitespace-collapsed.
- **Ranking:** name hit first → more matched terms → more recent.
- **Preview pane:** focusing a match lazily parses that session's JSONL and
  shows the **models** used, a **tool histogram**, **files modified** (from
  edit/write calls), and **cost · tokens** consumed — above the keyword-centered
  snippet. Set `PI_FIND_RICH_PREVIEW=0` to keep the pane snippet-only.
- **Peek:** once a row is focused, `<` / `>` page back/forward through the whole
  session transcript in the preview pane (step ≈ 0.8 of the window so context
  overlaps at the seam). The pane resets to the match anchor whenever you move
  to another row.
- **Experimental RRF:** set `PI_FIND_RANK_MODE=rrf` to fuse four independent
  signals (metadata, term coverage, recency, term frequency) via Reciprocal
  Rank Fusion instead of the hand-tuned order. Off by default — it becomes the
  default only if it beats the heuristic on the gold set. (`bm25` is reserved
  and currently behaves like the default.)

## Configuration

Env-var knobs (pi extensions don't expose a config API yet):

| Variable | Default | Effect |
|---|---|---|
| `PI_FIND_RICH_PREVIEW` | `1` | `0` disables the models/tools/files/cost facet pane (snippet-only). |
| `PI_FIND_RANK_MODE` | `heuristic` | `rrf` fuses four signals via Reciprocal Rank Fusion; `bm25` is reserved. |

## Project layout

```
src/
├── index.ts     # factory: registers /find + /find-back; scan → rank → select → switchSession
├── history.ts   # pure back-navigation logic: record switches, suppress ping-pong, pop for /find-back
├── finder.ts    # custom TUI component: scrollable list + live fuzzy filter + rich preview pane
├── parse.ts     # JSONL parse → recap (intent/last action/outcome) + rich facets + match locator
└── search.ts    # pure helpers: parseQuery / matchSession / rankMatches / extractSnippet (+ projName, ago)
test/
├── history.test.ts   # unit tests for the pure back-navigation logic
├── search.test.ts    # unit tests for the pure search logic
└── wiring.test.ts    # smoke test: real module load + /find + /find-back registration + guards
```

`search.ts` has **no pi imports**, so the core logic is fully unit-testable.

## Development

```bash
npm install
npm run check      # typecheck (tsc --noEmit) + tests (vitest)
npm test
npm run typecheck
```

## Status & roadmap

- **MVP (this release):** `/find` via `ctx.ui.select`; AND matching over
  `allMessagesText` + `name` + `cwd`; jump via `switchSession`. Usable &
  shippable.
- **Shipped beyond MVP:** custom TUI finder with live filter + a **rich preview
  pane** (models / tool histogram / files modified / cost — PLAN item 1),
  `<`/`>` **peek paging** through the transcript (item 5), **RRF rank-fusion**
  opt-in (item 6), **recap-at-landing** + match locator on jump (item 7), and
  **`/find-back`** universal back-navigation across sessions/projects. All
  in-memory (search) / on-disk (back stack), no DB/cache/index. See `PLAN.md`.
- **v1:** richer settings once pi exposes a config API; RRF default flip (gated
  on the gold-set benchmark, PRD §10).
- **v1.1:** `pi --find` CLI flag; `matchMode` (or/phrase) + `rankMode: "bm25"`.
- **v2:** streaming results, fuzzy matching, optional content index.

See `PRD.md` for the full spec and `RESEARCH.md` for the evidence base behind
the design decisions.

## License

MIT
