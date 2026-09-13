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

**File name is `src/pages/review/[...slug].astro`, not `[[slug]].astro`** —
confirmed directly: Astro 7 throws `Missing parameter: slug` at build time
for `[[slug]]` when `getStaticPaths` returns `params: { slug: undefined }`
for the base `/review` path; that double-bracket "optional param" syntax
isn't what actually tolerates `undefined` in this Astro version. The rest
param (`[...slug]`, triple dot) does — its generator explicitly falls back
to `""` when the param is missing. Since a review path is always zero or one
segment (a book slug never contains `/`), the rest param's array-ish nature
never actually surfaces here — `Astro.params.slug` is simply `undefined` or
the one slug string.

## Component: `ReviewDeck` (React island)

This is the one place in the project that needs `@astrojs/react` and a
client directive (`client:load` is fine — this component is the whole point
of the page it's on, no need to lazy-load it).

Behavior:
- Shows one card at a time: `prompt` visible, `answer` hidden.
- Click/tap the card itself, or a "Show answer" button, flips it to reveal
  `answer` — **deliberately redundant, not a bug to "fix" by picking one.**
  The card gesture is the natural flashcard metaphor (mouse/touch users);
  the labeled button is what makes it discoverable and operable for
  keyboard/screen-reader users who won't intuit "the whole card is
  clickable." Anki and Quizlet both keep this same redundancy for the same
  reason — removing the button in favor of click-only regresses
  accessibility, which is the opposite of the actual fix needed (see the
  hint below). A small "Click to reveal" hint renders on the card itself
  while unflipped, **only until the reader has flipped any card once this
  session** (tracked via `hasFlippedOnce` state) — teaches the gesture once,
  then gets out of the way rather than cluttering every subsequent card.
- "Next"/"Previous" advance the shuffled deck in either direction (both wrap
  at the ends), resetting flipped state each time. Previous was missing
  from the original v1 draft — user feedback after using the shipped
  version: a deck that only moves forward and wraps isn't actually a
  carousel, and recall practice isn't strictly linear (you double back to
  re-check something). Both also respond to Left/Right arrow keys
  (`window` `keydown` listener, matching the on-screen buttons), not just
  click/tap.
- Prev/Next render as icon-only arrow buttons (`aria-label`, no visible
  text — required for icon-only controls) at reduced visual weight
  (`variant="outline"`, smaller) flanking "Show answer," which stays the
  single visually primary action (`variant="default"`, the only filled
  button) in the center. The original layout had all three controls at
  equal visual weight in one row, which read as an undifferentiated
  cluster rather than "one primary action + peripheral navigation" — this
  is what actually needed fixing, not the click/button redundancy above.
- A plain "N of total" progress counter, mono type. Added post-v1-draft: an
  infinitely-wrapping shuffled deck with zero sense of progress reads as an
  endless scroll, not a study session — this is informational (same
  category as the "Key Claims (N)" count elsewhere), not a scoring
  mechanic, so it doesn't cross the "no gamified UI" line below.
- **On `/review` only** (the all-books deck), each card shows its source
  book title above the prompt, small muted uppercase. Added post-v1-draft:
  once claims are shuffled across the whole library, a prompt with no
  visible book context is disorienting — you often won't know which book a
  claim is testing until well after trying to recall it. `/review/[slug]`
  doesn't need this; you already know which book you're on.
- Keep it simple: no scoring, no "how well did you know this" input in v1 —
  just prompt → flip → next. Recall practice itself is the value; grading
  yourself is an upgrade, not a requirement.

State: plain React `useState` for current index / flipped state / shuffled
order — **with two real, related gotchas, both confirmed directly (the
second caught by an independent code-review pass, not by building/testing
alone).**

1. Shuffling inside the initial `useState(() => shuffle(cards))` runs once
   during Astro's SSR pass (which produces the static HTML for this
   `client:load` island) and again during client hydration —
   `Math.random()` disagreeing between those two passes throws a React
   hydration mismatch (`Hydration failed because the server rendered text
   didn't match the client`), confirmed via a real `pageerror` in a
   headless browser, not just a theoretical concern.
2. The first fix attempted — initialize `order` as the **unshuffled**
   `cards` prop (matches server/first-client-render, no mismatch), then
   shuffle in a mount-only `useEffect` — resolved the mismatch but
   introduced a different, real problem: `index` stays `0` throughout, so
   the *card actually shown* silently changes from `cards[0]` to
   `shuffled[0]` a moment after hydration. That's a visible content swap a
   fast reader could notice mid-read, not just an invisible reorder.

**Actual fix:** initialize `order` as `null` (still identical across SSR
and first client render, so no hydration mismatch), render nothing
meaningful — an empty `.review-card`-classed div, `aria-hidden` — while
`order === null`, and only mount the real deck once the mount-only
`useEffect` has shuffled and called `setOrder`. `.review-card`'s own
`min-height` keeps the layout from jumping once real content lands. This
avoids both problems at once instead of trading one for the other.

## Persistence: last-reviewed tracking

This is a real, deployed website in a real browser — **`localStorage` is
fine here** (the restriction against browser storage applies to Claude.ai
in-chat Artifacts specifically, not to your actual deployed site, so ignore
that constraint for this project).

Stored under a single key (`book-keeper:last-reviewed`):
```json
{ "book-slug": "2026-09-12T00:00:00Z", ... }
```
one timestamp per book slug. **Revised from the original v1 draft:** now
updates whenever *any* card is flipped to reveal its answer, on *either*
`/review` or `/review/[slug]` — not just on visiting the single-book route.
This changed because the timestamp gained a second job (see "All-books deck
sizing" below): it's no longer just a courtesy "last reviewed" readout, it's
also the input the all-books deck uses to decide what to prioritize showing
you next, so it has to reflect engagement wherever it happens. Read+parse is
kept separate from the write (`readLastReviewed`/`writeLastReviewed`
helpers) so a malformed stored value only costs that one write, not
persistence forever — see the independent-review notes in the acceptance
checklist for why that distinction matters.

## All-books deck sizing and prioritization

**Added post-v1, once real scale stopped being hypothetical** (a backlog of
50+ books to add). Two problems surface once a library actually grows past a
handful of books, neither of which matters at 2 books but both of which
become real:

1. **Unbounded size.** `/review`'s deck was every claim from every book,
   shuffled — at 50+ books that's several hundred cards in one "session,"
   with a progress counter reading something like "1 of 847." Fixed with a
   hard cap, `DECK_CAP = 30` in `ReviewDeck.tsx` — a session always finishes
   in a real sitting regardless of library size. The cap is a ceiling, not a
   fixed count: below it, nothing changes (confirmed directly against the
   real 2-book/13-claim library — deck size stays exactly the pool size).
2. **A flat random sample is biased toward books with more claims.** A
   15-claim book is 3x more likely to appear in any given draw than a
   5-claim one, so books get reviewed proportional to how many claims they
   happen to have, not how much they actually need review.

Fix, in `buildDeck()`: group cards by book, sort books by `last-reviewed`
staleness (books with **no** entry — never reviewed — sort first, treated
as epoch 0; then oldest-reviewed next), then pull one card per book in that
order, round-robin, looping back for additional passes until the cap is
reached or every book's claims are exhausted. This **guarantees** every book
gets a card before any book gets a second one (as long as there are ≥ cap
books) — deterministic coverage, not a probabilistic improvement the way
weighted-random sampling would be. Confirmed directly at scale with a
40-book/354-card synthetic pool (not just reasoned about): a 30-card deck
covered 30 distinct books with zero repeats, and never-reviewed books
front-loaded to an average first-appearance index of 9.5 vs. 24.5 for
previously-reviewed ones.

This is **not** SM-2 — no per-card ease factor, interval, or due date, just
book-level "haven't touched you in a while" ordering, built entirely from
data already being collected for the "last reviewed" readout. `buildDeck()`
runs client-side inside the same post-mount `useEffect` that already existed
for the shuffle (same hydration-safety reasoning as before — it can't run
during Astro's SSR pass since `localStorage` doesn't exist there), and it
needs no special-casing for `/review/[slug]`: with only one book in `cards`,
the round-robin degrades to "that book's own shuffled claims, capped" —
same function, confirmed directly against the single-book case too.

## Design for the upgrade path (don't build yet, just don't block it)

When you do want real spaced repetition later, each key claim will likely
need its own persisted state (ease factor, interval, due date — the standard
SM-2 fields), keyed by book slug + claim index. The `localStorage` blob
above is compatible with growing into that shape (one JSON blob, more fields
per entry) — just don't design it in a way that would require a full data
migration to add it (e.g. don't hardcode assumptions that there's only ever
one timestamp per book).

## Visual treatment

Match the "study guide" tone Part 3 settled into post-revision (see its
"Visual direction" section) — a card in the center of the page, a clear but
understated flip affordance. This is a study tool, not a game; avoid
gamified UI (streaks, points, confetti) for v1. The progress counter above
is informational, not gamification — see "Component" above for why that
distinction matters.

Since `@abumble/design-system` (Part 3) is React + shadcn-ui already, prefer
its primitives where they fit — `Button` for Show answer/Next, and
`BackLink` (router-agnostic, chevron icon) for a "← Back to [book]" link on
`/review/[slug]` so the page isn't a dead end, both rendered with no
`client:*` directive since they're purely presentational. **The flashcard
container itself is custom CSS, not the design system's `Card`** — `Card`
ships a small border-radius and a translucent `--card` background, which
would read as a visually distinct object from `.review-banner`'s flat,
bordered, no-radius language on the book page that links here. Matching
that instead (plain `border: 1px solid var(--border)`, no fill) makes the
card feel continuous with the CTA that led to it, rather than introducing a
third visual idiom. This is a deliberate exception to "prefer composing
existing primitives," not an oversight — `.review-banner` itself set this
precedent already.

## Acceptance check for this part

- ✅ `pnpm exec tsc --noEmit` and `pnpm build` both pass, generating
  `/review/index.html` plus one `/review/<slug>/index.html` per book.
- ✅ `/review` pulls claims from at least two different books and shuffles
  across them (confirmed against two real books), each card showing its
  source book title. `/review/[slug]` correctly scopes to just that book,
  no source label shown, with a working back-link to the book page.
- ✅ No React hydration errors — confirmed via a headless-browser
  `pageerror`/console listener, not just "looks fine" (this is what caught
  the shuffle-in-`useState` bug documented under "Component" above).
- ✅ Flip (click the card or the button), Next (advances + resets flipped +
  wraps at the end, confirmed via the progress counter changing), and
  `localStorage` persistence (`book-keeper:last-reviewed`, confirmed by
  reading it back via `page.evaluate` after visiting `/review/[slug]`) all
  verified directly, not assumed from the code.
- ✅ Checked in both light and dark color schemes and at a 390px mobile
  viewport — card and controls hold up, no overflow/clipping.
- ✅ An independent code-review pass (a separate session, no shared
  context — same pattern as Part 3's review, see its own build notes)
  caught 10 further issues, all fixed and re-verified, including two real
  bugs beyond what building/manual testing alone had surfaced: `singleBook`
  on the review page was derived from `books.length === 1` rather than
  `Astro.params.slug`, which would have misidentified `/review` itself as
  a single-book route the moment the library ever shrinks to exactly one
  book (confirmed by actually testing with a temporary 1-book library, not
  just reasoning about it) — wrong title, a spurious back-link, and a
  wrongful `last-reviewed` write for that book on a plain `/review` visit.
  Separately, `ReviewDeck`'s localStorage write had `JSON.parse` inside the
  same `try` as the write itself, so a single malformed stored value
  permanently blocked *every* future write for *every* book, not just that
  visit — read+parse now has its own fallback-to-`{}`, independent of the
  write. Also added: an `<h1>` on both review routes (previously the only
  routes on the site without one), a zero-claims guard on the
  `.review-banner` CTA, `aria-expanded`/`aria-live` on the flip
  interaction, and three CSS de-duplications (`.review-page` merged into
  `.content-page`, `.review-card-answer`/`.key-claim-answer` and
  `.review-card-source`/`.section-label` merged into shared selectors
  instead of copy-pasted-with-drift values).
- ✅ A **second** independent code-review pass, after the Back/Next/hint and
  deck-capping/staleness-prioritization work above, caught 9 more issues in
  `ReviewDeck.tsx`, 7 fixed:
  - `readLastReviewed` now rejects a non-object parse result (e.g. the
    literal string `"null"` parses without throwing) instead of returning it
    as-is — confirmed directly: without this, a corrupted `"null"` value in
    `localStorage` crashed the whole component (`buildDeck`'s
    `lastReviewed[a]` lookup throwing on `null`), not just failing to load
    stale data.
  - The arrow-key handler is now scoped to fire only while focus is inside
    `.review-deck` (a `ref`-based containment check) and ignores any
    keypress with a modifier held — an unscoped `window` listener
    intercepts the same keys a screen reader's virtual-cursor browsing mode
    uses, and (since nothing called `preventDefault`) fired *alongside*
    Alt+Left/Right's browser back/forward navigation rather than staying out
    of its way. Both behaviors confirmed directly (arrow presses with no
    deck focus, and with Alt held, both correctly no-op now).
  - The "click to reveal" hint's dismissal now persists via
    `sessionStorage`, not a plain `useState(false)` — it was resetting (and
    the hint reappearing) on every fresh mount, i.e. every page navigation,
    contradicting "shown once per session" above. Confirmed with a properly
    isolated browser context: dismissed once, then gone across a
    `/review` → `/books/[slug]` → `/review/[slug]` navigation.
  - The keyboard handler now calls `next()`/`prev()` directly instead of
    reimplementing their wrap-around math a second time (both are plain
    function declarations, defined once; hoisting is what lets the
    mount-order-constrained keyboard effect call them despite being
    declared later in the file).
  - `buildDeck`'s round-robin loop is bounded by a precomputed
    "most claims any single book has" instead of a sentinel
    "did this round add anything" flag, and the staleness sort now
    precomputes each book's timestamp once instead of re-parsing it on
    every comparison the sort makes. Both re-verified against the same
    40-book/354-card synthetic scenario used to first validate the
    algorithm — identical output.
  - Two findings declined, with reasoning: a cross-tab `localStorage`
    read-modify-write race (real, but the write is fully synchronous with
    no `await` between read and write, so the actual race window requires
    two tabs' click handlers firing in the same tick — not realistic for a
    single human operating a personal tool; fixing it properly means adopting
    the Web Locks API for a risk this low, which is the kind of complexity
    this project has consistently avoided elsewhere). `writeLastReviewed`
    re-reading the full blob on every flip was flagged as wasteful, but the
    fix (caching a copy between renders) would widen the cross-tab race
    just described, not narrow it, for a save too small to matter at this
    interaction frequency — left as-is deliberately, not an oversight.
- ✅ A **third** independent code-review pass (`/code-review high`, a
  separate `book-keeper-1d` session, coordinated cross-session via
  SendMessage/ListAgents), run against the state left by the second pass
  above, caught 9 more findings in `ReviewDeck.tsx` — 4 correctness, 5
  simplification/efficiency. All 9 addressed:
  - `buildDeck`'s cap (`DECK_CAP = 30`) was being applied unconditionally,
    including on `/review/[slug]` where `cards` is a single book's claims —
    a book with more than 30 key claims (the schema has no upper bound) was
    silently truncated below what its own "Test yourself on N key claims"
    banner on the book page promises. Fixed by only applying the cap once
    there's more than one book in the deck (`bookSlugs.length > 1 ? cap :
    Infinity`) — rationing across books is the cap's actual job, and a
    single book's own deck was never what it was meant to bound. Verified
    with a synthetic 45-claim single book (deck size 45, not 30) and a
    20+20-claim two-book case (still caps at 30).
  - Last-reviewed was only being written on flip-to-reveal, so skimming a
    whole deck via Next/Prev without ever flipping a card left every one of
    those books permanently "most stale" regardless of real engagement.
    Fixed by also writing last-reviewed for the card being left, inside
    `next()`/`prev()`'s shared `advance()`, not just inside `toggleFlip` —
    passing through a card now counts as engagement with its book even if
    the reader already knew the answer and didn't flip.
  - A corrupted (non-date-parseable) stored last-reviewed value produced
    `NaN` in the staleness sort comparator — `NaN - x` comparisons are
    treated as "equal" by `sort()`, so that book's position became
    whatever the engine's sort happened to leave it at rather than
    "never reviewed." Fixed by normalizing any value that doesn't parse to
    a real timestamp to `0` (same bucket as "no entry at all"). Verified
    with a synthetic corrupted-value case: the corrupted book now sorts
    first, same as a never-reviewed one.
  - The hint-seen `sessionStorage` write in `toggleFlip` fired on every
    flip (including hiding the answer again), not just the first —
    harmless (idempotent write of the same `"1"`) but inconsistent with the
    `if (!flipped)` guard right next to it for last-reviewed. Now guarded
    the same way (`if (!hasFlippedOnce)`).
  - Simplification/efficiency, all applied: `next()`/`prev()` collapsed
    into a single `advance(1 | -1)` (was copy-pasted wrap-around math);
    the arrow-key handler moved from a `window`-level listener with a
    `ref`-based focus-containment check to a plain `onKeyDown` on
    `.review-deck` itself, relying on ordinary DOM bubbling for the same
    "only while focus is inside the deck" scoping with less code and no
    `useRef`/cleanup; `readHintSeen`/`writeHintSeen` helpers added so the
    hint's `sessionStorage` access follows the same named-helper idiom as
    `readLastReviewed`/`writeLastReviewed` instead of being inlined
    try/catch at each call site; `byBook.keys()` is now spread once into
    `bookSlugs` and reused (was spread twice — once for the staleness map,
    again for the sort); and the deck-building logic (`shuffle`,
    `readLastReviewed`, `writeLastReviewed`, `buildDeck`, `DECK_CAP`) moved
    out of `ReviewDeck.tsx` into a plain `src/lib/reviewDeck.ts` module —
    no JSX/React in it, so it's independently runnable (this doc's own
    synthetic-data verification, e.g. the 40-book/354-card round-robin
    check and the cases just above, no longer has to go through the
    component to exercise this logic, and it's now what a future automated
    test would import directly rather than needing to render React first).
