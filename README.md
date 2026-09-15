# Book Keeper

A personal static website that acts as a long-term memory aid for books
you've read. For each book, an AI generation pipeline produces a chapter-by-
chapter summary and a set of key claims for recall practice, rendered on a
fixed page template. Not a note-taking app, a CMS, or a book-tracking app —
the one job is turning "I read this book six months ago and remember it was
good but not the specifics" into "here's the 2-minute refresher."

## Setup

```
pnpm install
cp .env.example .env   # fill in OPENROUTER_API_KEY and TAVILY_API_KEY
pnpm dev
```

`pnpm dev` binds to `0.0.0.0` by default, which matters if you're running
inside a devcontainer (see `AGENTS.md`/`CLAUDE.md` for why).

Generation also requires Docker (see below).

## Adding a book

1. Finish a book. Optionally jot down a few rough notes/highlights as you
   go — informal is fine, they're never published.

2. Generate it — always via the Docker sandbox, never the raw script
   directly, since generation feeds untrusted third-party content (search
   results) into an LLM, and the sandbox is what keeps that away from your
   repo and secrets (see `docs/blueprint/05-operations-and-future.md`):

   ```
   pnpm run generate:sandboxed -- "Fooled by Randomness"
   ```

   Have notes from step 1? Pass them along — they steer which claims the
   generation pipeline treats as most important without ever being quoted
   into the site:

   ```
   pnpm run generate:sandboxed -- "Fooled by Randomness" --notes ./my-notes.txt
   ```

   Already know the exact edition — author, ISBN, publication year, or even
   the real chapter list — from the book itself? Pass it as ground truth
   instead of leaving the outline stage to reconstruct it from web search.
   Any field you supply is treated as fixed; a full `chapters` list skips
   the outline search entirely. Copy `known/example.json` to
   `known/<your-book>.json` (gitignored — see `known/README.md`), fill in
   whatever you actually know, delete the rest, then:

   ```
   pnpm run generate:sandboxed -- "Fooled by Randomness" --known known/fooled-by-randomness.json
   ```

   Every field is optional — supply only what you actually know. `chapters`,
   if given, must be the *complete*, real, ordered list — it's trusted
   outright with no verification, so don't paste in a partial list or leave
   a placeholder entry in it (see `known/README.md` for the full rundown).

   This runs the pipeline (title → outline → per-chapter detail → synthesis
   → validation) inside a locked-down, read-only, no-git-access container,
   then — once the sandbox has produced a validated `book.json` — creates a
   `book/<slug>` branch off `main` on the host and commits it there. `main`
   stays untouched.

3. Preview it — `pnpm dev` and open `/books/<slug>` (you're already on
   `book/<slug>` after the script finishes).

4. Read it over. If something's off — wrong chapter count, a claim that
   isn't actually in the book, an awkward synopsis — **edit the JSON file
   directly**; it's plain data under `src/content/books/<slug>.json`, easier
   to fix a field than to re-prompt and hope. Once you trust what's there,
   flip `"verified": false` to `true` in the same file — it renders as a
   small badge on the book's card and page, so future-you can tell at a
   glance which books were actually reviewed versus raw, unchecked output.

5. Merge it — either a plain local merge:

   ```
   git checkout main && git merge book/<slug>
   ```

   or, if you want to see it on the live site before merging, push the
   branch and open a PR (Cloudflare Workers builds a preview deployment
   automatically):

   ```
   git push -u origin book/<slug>
   gh pr create
   ```

6. Cloudflare rebuilds and redeploys `main` automatically once merged.
   Delete the merged `book/<slug>` branch.

## Reviewing what you've read

- `/review` — a shuffled flashcard deck pulled from every book's key claims.
- `/review/<slug>` — scoped to one book.

Click (or tap) a card to reveal the answer, then Next to advance. No
scoring, no spaced-repetition scheduling — just prompt → flip → next. Last-
reviewed timestamps persist in the browser's `localStorage`, so that history
is per-browser/per-device, not synced (the books and summaries themselves
are safe either way — they're files in this repo).

## Tech stack

Astro (static output) · React islands (only the review deck hydrates) ·
`@abumble/design-system` (Tailwind + shadcn-ui) · LangGraph + OpenRouter +
Tavily for generation (sandboxed in Docker) · Cloudflare Workers for
hosting.

## More detail

`docs/blueprint/` has the full design rationale, the decisions made along
the way, and the reasoning behind things that aren't obvious from the code
alone — worth reading if you're picking this project back up after a while
or extending it further. `00-INDEX.md` is the place to start.
