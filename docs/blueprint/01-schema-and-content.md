# Part 1 — Schema & Content Structure

**Context:** This is a static Astro site called "Book Keeper." Each book is one
JSON file, validated against a shared schema, rendered by a fixed template.
This part defines that schema and the content folder layout. See `00-INDEX.md`
for full project context if needed.

## Task

1. Set up Astro Content Collections for a `books` collection.
2. Define the Zod schema below in `src/content/config.ts`.
3. Create one fully-filled example book JSON file so later parts have
   something real to render against.

## The schema

```ts
// src/content/config.ts
import { defineCollection, z } from 'astro:content';

const chapterSchema = z.object({
  number: z.number(),
  title: z.string(),
  key_points: z.array(z.string()).min(1).max(6),
  core_claim: z.string(), // one sentence: the chapter's central point
});

const keyClaimSchema = z.object({
  prompt: z.string(),   // a recall cue, e.g. "What is the narrative fallacy?"
  answer: z.string(),   // the answer/explanation, 1-3 sentences
});

const booksCollection = defineCollection({
  type: 'data', // JSON/YAML, no markdown body needed
  schema: z.object({
    title: z.string(),
    author: z.string(),
    year: z.number().optional(),
    tags: z.array(z.string()).min(1),
    date_added: z.string(), // ISO date, when it was added to the site
    one_line_takeaway: z.string(),
    synopsis: z.string(), // 1-3 paragraphs
    chapters: z.array(chapterSchema).min(1),
    key_claims_for_review: z.array(keyClaimSchema).min(3),
  }),
});

export const collections = {
  books: booksCollection,
};
```

Notes on field intent (so the generation pipeline in Part 2 knows what to aim
for, and so you don't quietly redefine these later):

- **`one_line_takeaway`** — the single sentence you'd want to see if you only
  had five seconds. This is what should appear on book list/cards.
- **`synopsis`** — the overall arc/thesis, written *after* all chapters are
  processed (see Part 2), not before.
- **`core_claim`** per chapter — forces every chapter to compress to one
  sentence, which is what actually makes chapter lists scannable across books
  of wildly different lengths (a 6-chapter book and a 40-chapter textbook
  should feel equally quick to skim).
- **`key_claims_for_review`** — deliberately separate from chapter key points.
  These are phrased as prompt/answer pairs specifically because they feed the
  flashcard review mode in Part 4. Aim for 5-15 per book, not one per chapter
  necessarily — pick the claims most worth being able to recall cold.
- **`tags`** — free-form lowercase-kebab strings (e.g. `embedded-systems`,
  `statistics`, `psychology`). No fixed taxonomy for v1 — just be consistent
  with casing so tag pages group correctly.

## Slug / filename convention

Filename = slug = kebab-case `title` (drop subtitle if the title is long).
Example: `src/content/books/fooled-by-randomness.json`.

## Example content file

Create this as a real file so Parts 3 and 4 have something to build against:

```json
{
  "title": "Fooled by Randomness",
  "author": "Nassim Nicholas Taleb",
  "year": 2001,
  "tags": ["statistics", "philosophy", "finance", "decision-making"],
  "date_added": "2026-09-12",
  "one_line_takeaway": "We systematically underestimate the role of luck and overfit stories to random outcomes.",
  "synopsis": "Taleb argues that randomness plays a far larger role in outcomes — especially in markets and careers — than we're willing to admit, and that our brains are wired to construct narratives that erase the role of luck after the fact. The book is less a statistics text than an extended argument for epistemic humility: surviving a risky strategy doesn't validate it, and the visible 'winners' we study are a survivorship-biased sample.",
  "chapters": [
    {
      "number": 1,
      "title": "The Cab Driver and the Economist",
      "key_points": [
        "Introduces the idea that outcomes are misread as skill when they're substantially luck",
        "Sets up the recurring 'alternate histories' thought experiment"
      ],
      "core_claim": "A single observed outcome tells you very little without considering the full distribution of outcomes that could have happened."
    },
    {
      "number": 2,
      "title": "A Bizarre Accounting Method",
      "key_points": [
        "Introduces the trader Nero as a contrast to a flashier, luckier trader",
        "Argues for judging decisions by process, not by outcome"
      ],
      "core_claim": "Judging a decision by its result rather than its process rewards recklessness whenever it happens to pay off."
    }
  ],
  "key_claims_for_review": [
    {
      "prompt": "What is 'survivorship bias' as Taleb uses it?",
      "answer": "The error of drawing conclusions from the visible 'winners' of a random process while ignoring the much larger, invisible population that took similar risks and failed."
    },
    {
      "prompt": "Why does Taleb say judging decisions by outcomes is a mistake?",
      "answer": "Because a good decision can still produce a bad outcome (and vice versa) under randomness — outcome-based judgment rewards luck rather than sound process."
    },
    {
      "prompt": "What is the 'alternate histories' thought experiment for?",
      "answer": "It asks you to imagine the many different ways a random process could have played out, to judge whether a single realized outcome was actually likely or just one lucky path among many."
    }
  ]
}
```

## Acceptance check for this part

- `astro build` (or `astro check`) succeeds with the example file in place.
- Astro rejects the file if you deliberately break the schema (e.g. remove
  `one_line_takeaway`) — confirm the validation is actually enforced, not just
  present.
