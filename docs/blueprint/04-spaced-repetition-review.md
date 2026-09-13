# Part 4 — Spaced Repetition / Review Mode

**Context:** "Book Keeper" is a static Astro site. Every book's content file
includes a `key_claims_for_review` array of `{ prompt, answer }` pairs (Part
1). This part builds the one interactive feature on the site: a flashcard-
style review deck over those claims. See `00-INDEX.md` for full context.

## Scope for v1 — deliberately simple

Full spaced-repetition scheduling (SM-2 or similar, tracking per-card
intervals and due dates) is **not** v1. That's a real feature with real
complexity (Part 5 lists it as a future upgrade). v1 is: a shuffled flashcard
browser over key claims, with lightweight "last reviewed" tracking so you can
at least see what you haven't looked at in a while. Don't build the full
scheduling algorithm now — build the simple version and make sure the data
shape doesn't block upgrading later (see "Design for the upgrade path"
below).

## Routes

- **`/review`** — deck pulled from **every** book's `key_claims_for_review`,
  shuffled.
- **`/review/[slug]`** — deck scoped to one book, for "I just want to refresh
  this specific book."

Both routes can share the same island component, just fed a different set of
cards as a prop from the Astro page (Astro does the `getCollection` /
filtering server-side at build time; only the flip/shuffle/navigate
interaction needs to be client-side).

## Component: `ReviewDeck` (React island)

This is the one place in the project that needs `@astrojs/react` and a
client directive (`client:load` is fine — this component is the whole point
of the page it's on, no need to lazy-load it).

Behavior:
- Shows one card at a time: `prompt` visible, `answer` hidden.
- Click/tap (or a button) flips the card to reveal `answer`.
- "Next" advances to the next card in the (shuffled) deck; wrap around at the
  end.
- Keep it simple: no scoring, no "how well did you know this" input in v1 —
  just prompt → flip → next. Recall practice itself is the value; grading
  yourself is an upgrade, not a requirement.

State: plain React `useState` for current index / flipped state / shuffled
order. No need for anything heavier.

## Persistence: last-reviewed tracking

This is a real, deployed website in a real browser — **`localStorage` is
fine here** (the restriction against browser storage applies to Claude.ai
in-chat Artifacts specifically, not to your actual deployed site, so ignore
that constraint for this project).

Store something minimal, e.g. under a single key:
```json
{ "book-slug": "2026-09-12T00:00:00Z", ... }
```
one timestamp per book slug, updated whenever a review session for that book
finishes (or simply whenever you visit `/review/[slug]`). This is enough to
later sort/highlight "books you haven't reviewed in the longest" without
committing to a full scheduling algorithm yet.

## Design for the upgrade path (don't build yet, just don't block it)

When you do want real spaced repetition later, each key claim will likely
need its own persisted state (ease factor, interval, due date — the standard
SM-2 fields), keyed by book slug + claim index. The v1 `localStorage` blob
above is compatible with growing into that shape (one JSON blob, more fields
per entry) — just don't design v1 in a way that would require a full data
migration to add it (e.g. don't hardcode assumptions that there's only ever
one timestamp per book).

## Visual treatment

Match the calm/library tone from Part 3 — a card in the center of the page,
generous padding, a clear but understated flip affordance. This is a study
tool, not a game; avoid gamified UI (streaks, points, confetti) for v1.

Since `@abumble/design-system` (Part 3) is React + shadcn-ui already, build
`ReviewDeck` from its primitives directly (its `Card` component for the
flashcard itself, `Button` for next/flip) rather than styling from scratch —
this is the one component in the project where the library's interactivity
(not just its static presentation) is actually relevant, since it's the one
component genuinely hydrated with `client:load`.

## Acceptance check for this part

- `/review` pulls claims from at least two different books and shuffles
  across them (confirm it's not accidentally scoped to one book).
- `/review/[slug]` correctly scopes to just that book.
- Refreshing the page doesn't lose the fact that you've reviewed a book
  before (i.e. `localStorage` write/read actually works, confirmed by
  checking devtools or a visible "last reviewed" indicator somewhere).
