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
```

Pick a result with the arrow keys + `Enter` to switch into that session **and**
its working directory (pi re-runs project trust for the target `cwd`, just like
`/resume`). `Esc` / `Ctrl+C` cancels.

Each result shows the session name (or first message), the project folder, how
long ago it was modified, the message count, and a snippet of the matching text.

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

## Project layout

```
src/
├── index.ts     # factory: registers /find; scan → rank → select → switchSession
└── search.ts    # pure helpers: parseQuery / matchSession / rankMatches / extractSnippet (+ projName, ago)
test/
├── search.test.ts   # unit tests for the pure search logic
└── wiring.test.ts   # smoke test: real module load + /find registration + handler guards
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
- **v1:** custom TUI finder (live filter, scope toggle, on-progress status),
  `findSession` settings, `(mtime,size)`-keyed cache, richer snippets.
- **v1.1:** `pi --find` CLI flag; `matchMode` (or/phrase) + `rankMode: "bm25"`.
- **v2:** streaming results, fuzzy matching, optional content index.

See `PRD.md` for the full spec and `RESEARCH.md` for the evidence base behind
the design decisions.

## License

MIT
