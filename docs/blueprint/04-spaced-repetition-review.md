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
- Click/tap the card itself (or a "Show answer" button — both do the same
  thing) flips it to reveal `answer`.
- "Next" advances to the next card in the (shuffled) deck, resetting flipped
  state; wraps around at the end.
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
