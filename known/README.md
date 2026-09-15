# `--known` files

Ground truth for a specific book/edition, fed to `scripts/generate-book.ts`
via `--known <path>` so the outline stage treats it as fixed instead of
reconstructing it from web search. See `docs/blueprint/02-generation-pipeline.md`
("Also optionally: `--known <path>`") for the full mechanics.

## Usage

1. Copy `example.json` to a new file here, named after the book, e.g.
   `known/my-book.json` — the filename becomes the book's slug (see below).
2. Fill in whatever you actually know; **delete any field you don't** —
   every field is optional, and a genuinely unknown field should be left out
   entirely rather than guessed at.
3. Pass it to generation:

   ```
   pnpm run generate:sandboxed -- --known known/my-book.json
   ```

   The title argument is optional here — omitting it, as above, falls back
   to the known file's own basename (`my-book.json` → slug `my-book`). Pass
   one explicitly (`... "My Book" --known known/my-book.json`) if you want
   the slug to be something other than the filename.

Files you add here besides `example.json` are gitignored (see
`../.gitignore`) — they're per-book generation input, not site content.

## Fields

| Field        | Type       | Notes |
|--------------|------------|-------|
| `title`      | string     | The exact published title of this edition. |
| `author`     | string     | Full name — author or translator. |
| `year`       | number     | Publication year of this edition. |
| `isbn`       | string     | Used to fetch the cover image and page count directly, skipping search. |
| `page_count` | number     | Kept as-is even if no ISBN/cover match is found. |
| `chapters`   | string[]   | See below — the highest-stakes field. |
| `notes`      | string     | Your own rough reading notes — a weighting signal for the synopsis/key claims, never quoted verbatim. Combines with `--notes` if both are given. |

### `chapters` — read this before filling it in

If given, **it must be the complete, real, ordered chapter/section list** —
generation trusts it outright and skips outline search/consensus entirely
(one narrow verification check still runs first — see below, and it's not a
substitute for getting this right). That means:

- **List every chapter**, in the book's actual order. A partial list is
  worse than no list — generation would treat it as the whole book.
- **Just the title text** — e.g. `"If You're So Rich, Why Aren't You So
  Smart?"`, not `"Chapter 1: If You're So Rich..."`. The chapter *number*
  comes from each entry's position in this array, not from the text, and
  the site renders the number and title as separate elements — a `"Chapter
  1:"` prefix in the text shows up as a redundant duplicate next to it.
- **Use the real published titles**, not a paraphrase or a generic
  "Chapter 1" placeholder.
- **Don't leave placeholder or `"..."` entries in the array.** If you're not
  sure of the full list, delete the `chapters` field entirely instead —
  generation falls back to its normal search-and-consensus outline stage,
  which is exactly what that path is for.
- **Also fill in `title`** (or `isbn`, or type a title on the command line)
  when giving `chapters` — this path has no search step to fall back on for
  the title the way the normal outline stage does, so generation refuses to
  guess and errors out if none of those three are available.

### Verification

Because `chapters` skips outline search entirely, it's the one field with no
other check — so whenever it's given, generation runs one extra search and
a single model critique first, comparing your list against what search
turns up. It's deliberately narrow: it only flags a *specific, direct*
contradiction (wrong book/edition, an author that doesn't match, a
placeholder entry left over from the template) and explicitly ignores thin
or inconclusive search results, since chapter-level web coverage is often
sparse and you likely know this book better than what's indexed online.

If it does flag something and you've reviewed the concern and are confident
your file is actually correct (a bad search, not a real mistake), re-run
with `--trust-known` to skip the check and proceed anyway:

```
pnpm run generate:sandboxed -- "Book Title" --known known/my-book.json --trust-known
```
