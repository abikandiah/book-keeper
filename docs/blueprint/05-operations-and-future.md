# Part 5 — Operations & Future Enhancements

**Context:** This part isn't something to "build" — it's the documented
day-to-day workflow for using Book Keeper once Parts 1-4 exist, plus a
deliberately-parked list of upgrades. Keep this list around so scope-creep
ideas have somewhere to go that isn't "the v1 build."

## Day-to-day workflow (v1, draft-branch based)

1. Finish a book.
2. `pnpm run generate -- "Book Title"` (Part 2's script). Watch stage-by-stage
   progress in the terminal. The script creates a `book/<slug>` branch off
   `main`, runs the pipeline, and commits the generated JSON there —
   `main` is untouched.
3. `astro dev`, open `/books/<slug>` locally (you're already on `book/<slug>`
   after the script finishes), read it over.
4. If something's off (wrong chapter count, a claim that's not actually in
   the book, an awkward synopsis), **edit the JSON file directly** — it's
   plain data, easier to fix a field than to re-prompt and hope. Re-check in
   `astro dev`, amend or add a commit on the branch as needed.
5. When you're satisfied, merge it: either a plain local merge
   (`git checkout main && git merge book/<slug>`), or, if you want to see it
   on the actual deployed site before merging, `git push -u origin
   book/<slug>` and open a PR (`gh pr create`) — Cloudflare Workers, once
   connected to the repo, builds a preview deployment for pushed
   branches/PRs automatically, no CI workflow needed for that. Merge to
   `main` when satisfied.
6. Cloudflare rebuilds and redeploys `main` automatically (see Part 0 for
   the Workers/`wrangler.jsonc` setup); check the live site once it's
   deployed. Delete the merged `book/<slug>` branch.

That's the whole loop. The draft-branch step is the review gate — if it
ever stops feeling like enough (e.g. you want the push/PR-open step
automated too), that's a small, deliberate upgrade (see below), not a sign
v1 was built wrong.

## Future enhancements (explicitly not v1 — revisit only once v1 is solid)

- **Auto-push the draft branch and open the PR.** Part 2's script currently
  stops after committing locally to `book/<slug>` — pushing
  (`git push -u origin book/<slug>`) and opening a PR are manual steps.
  Automating that tail end is a small addition once you're comfortable with
  the branch-based flow and just want one less manual command per book, not
  a sign the manual version was wrong.
- **GitHub Actions automation.** `workflow_dispatch` triggered with a title
  input, runs Part 2's script in CI instead of locally. A heavier lift than
  the auto-push option above, and only worth it if running the script
  locally ever becomes real friction — not before.
- **Text-grounded generation.** Feed the actual PDF/EPUB (when you have one —
  e.g. your embedded systems textbooks) into the generation pipeline instead
  of relying on web search, for higher fidelity on technical books where
  chapter-level accuracy matters more than for general non-fiction.
- **Real spaced-repetition scheduling** (SM-2-style intervals/due dates) in
  place of the v1 shuffled-deck review mode — see Part 4's "design for the
  upgrade path" note; the data shape should already be compatible.
- **Static search** via Pagefind (Astro-friendly, fully static, no backend)
  once there are enough books that tag-browsing alone isn't fast enough to
  find something.
- **RSS/JSON feed** of newly added books, if you ever want to reference "what
  did I read recently" from outside the site itself.
- ~~Accordion/collapse for long chapter lists on the book page~~ — done: a
  6+ chapter book made the fully-expanded list unwieldy sooner than
  expected, so each `ChapterBlock` is now a collapsed-by-default native
  `<details>` (see Part 3).

## Explicitly not planned

- No multi-user features, no accounts, no CMS. This is a single-reader tool
  and should stay simple accordingly — resist building infrastructure for
  hypothetical future needs (sharing, comments, etc.) that aren't part of the
  stated goal (personal recall/refresh).

## "Weekend project done" checklist

- [ ] Schema + example content in place, Astro build validates it
- [ ] Generation script produces a valid new book JSON end to end
- [ ] Home, book detail, and tag pages render correctly for 2+ books
- [ ] Review mode works across books and per-book, with basic last-reviewed
      persistence
- [ ] Site is live on a Cloudflare Workers URL, connected to `main`
- [ ] You've personally added at least one *real* book you've actually read
      and confirmed the summary is accurate enough to trust
