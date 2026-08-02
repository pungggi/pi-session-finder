# Upstream issue draft — non-destructive "open session at a message" API

> Draft for filing against **pi** (`badlogic/pi-mono`). Not a change to this
> package — recorded here so the ask is precise and traceable. See `PLAN.md`
> item 7 for the local workaround (recap card + match locator) this unblocks.

## Suggested title

`Extension API: open a resumed session already scrolled to a given entry (non-destructive)`

## Problem

Extensions that let users **search session history and jump into a result**
(e.g. [`pi-session-finder`](https://github.com/pungggi/pi-session-finder)) can
switch to a matched session, but **cannot land the viewport on the specific
matched message**. `switchSession` opens the target session at its natural
position (the leaf / latest message); there is no way to say "open session X
positioned at entry Y." Users land at the end of a long conversation and must
scroll up to find the part they searched for.

After switching, there is also no way to scroll programmatically: the extension
`ui` surface (`ExtensionUIContext`) exposes `select` / `input` / `notify` /
`setWidget` / `setFooter` / `custom` / `pasteToEditor` / … but **no
`scrollToEntry` / `focusEntry` / `revealMessage`** of any kind.

## What I checked (pi version: `@earendil-works/pi-coding-agent`, current)

- `switchSession(sessionPath, options?)` — `options` is
  `{ cwdOverride?, withSession?, projectTrustContextFactory? }`. **No entry/anchor target.**
- `ExtensionContext.ui: ExtensionUIContext` — no scroll/focus/reveal method.
- `ReplacedSessionContext` (the `withSession` ctx) — adds `sendMessage` /
  `sendUserMessage`, still no scroll.
- `navigateTree(targetId, { summarize, … })` — this *does* target an entry, but
  it is **destructive**: it moves the active leaf to `targetId`, rewinding /
  branching the session and optionally summarizing the displaced branch. That is
  the wrong semantics for "show me message Y" — it would discard everything
  after Y.
- `fork(entryId, { position })` — also entry-targeted, but it forks (creates a
  new session), not a view scroll.

So pi already has rich **entry-targeted tree navigation** (`navigateTree`,
`fork`) and entries carry stable ids (`sessionManager.getEntry(id)`), but no
**non-destructive view-position** API.

## Proposal (either would unblock us)

1. **`switchSession(path, { entryId })`** — open the target session with the
   viewport initially positioned at `entryId` (no rewind, no branch; purely the
   initial scroll). Smallest surface change; most natural for the "search →
   jump → land on the hit" flow.

2. **`ctx.ui.scrollToEntry(entryId)`** — scroll the current chat view to an
   entry, non-destructively. More general (usable outside of switch flows too),
   but requires the view to already be the right session.

Either should be **non-destructive**: it must not change the session's active
leaf, append entries, or trigger summarization — only the viewport position.

## Use case & impact

- `pi-session-finder` `/find` → jump to the exact message that matched, not the
  session tail.
- Any future "go to message" / "previously on…" / deep-link affordance.
- Aligns with the existing share-URL machinery (`?targetId=<entryId>` in HTML
  export already scrolls to an entry in the exported view) — the concept exists,
  it just isn't exposed to live extensions.

## Workaround (today)

Show a pinned recap widget (`setWidget`) with the matched message's **content
+ its `message #N of M` position** so the user can navigate manually. Works,
but a real scroll API would remove the manual step.
