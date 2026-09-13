# Book Keeper — Project Blueprint (Index)

## What this project is

A personal static website that acts as a long-term memory aid for books you've
read (mostly non-fiction/technical). For each book, an AI generation pipeline
produces a structured summary — synopsis, chapter-by-chapter key points, and a
set of "key claims" for spaced-recall review — which gets rendered as a page
on the site via a fixed template, so every book's page has an identical shape
regardless of the book's own structure.

This is **not** a note-taking app, a CMS, or a book-tracking app. It has one
job: turn "I read this book six months ago and remember it was good but not
the specifics" into "here's the 2-minute refresher."

## How to use this blueprint with Claude Code

Read the parts **in order**, one per work session, to avoid context drift.
Each part is self-contained — it restates just enough context to be worked on
independently, so you don't need the whole blueprint loaded at once.

| Part | File | Covers |
|---|---|---|
| 0 | `00-setup.md` | Devcontainer, Dockerfile, scaffold sequence — environment state before Part 1 starts |
| 1 | `01-schema-and-content.md` | The book data schema, folder layout, example content |
| 2 | `02-generation-pipeline.md` | The multi-stage script that turns a title into validated JSON |
| 3 | `03-astro-frontend.md` | Site structure, routes, components, visual design direction |
| 4 | `04-spaced-repetition-review.md` | The flashcard-style review mode |
| 5 | `05-operations-and-future.md` | Day-to-day workflow + what to build later, not now |

Suggested build order: **0 → 1 → 2 → 3 → 4**, then 5 is reference/workflow
documentation rather than something to "build." Part 0 should already be
done by the time Claude Code opens the repo — it's there for reference, not
as a first task.

## What's already decided (don't relitigate these)

- **Package manager:** pnpm, not npm — see Part 0. Every command in every
  part of this blueprint uses `pnpm`.
- **Frontend:** Astro, using Content Collections, styled with the personal
  `@abumble/design-system` (React + Tailwind + shadcn-ui — see Part 3).
  Components are React but rendered statically with no client directive
  except the review-mode flashcard deck (Part 4), which is the one genuine
  interactive island.
- **LLM provider:** OpenRouter (OpenAI-compatible endpoint), not the
  Anthropic API — see Part 2. Since most OpenRouter models have no built-in
  web search, the generation pipeline does its own explicit search-API call
  before each relevant LLM call, rather than relying on a model tool.
- **Orchestration:** the generation pipeline is a LangGraph state graph, not
  hand-called sequential functions — chapters are generated via a parallel,
  concurrency-capped fan-out (`Send`/map-reduce), and the graph shape leaves
  room to add future stages without restructuring — see Part 2.
- **Hosting:** Cloudflare **Workers** with static assets (not legacy Pages —
  the project was created via Cloudflare's newer Workers product), connected
  to a GitHub repo, building on push to `main`. Build command `pnpm run
  build`, output dir `dist`, deployed via `wrangler deploy` reading
  `wrangler.jsonc`'s `assets.directory`. This is a fully static site (Astro
  `output: "static"`) — no Cloudflare adapter, no Worker entrypoint script
  needed, just `dist/` served as static assets. `wrangler.jsonc` must exist
  in the repo: without it, `wrangler deploy`'s "automatic configuration"
  guesses Astro needs the SSR adapter and tries to `pnpm add
  @astrojs/cloudflare` mid-deploy, which fails once `pnpm-workspace.yaml`
  declares a `packages` field (see Part 0's pnpm-workspace.yaml note) —
  don't delete `wrangler.jsonc` to "simplify" the repo.
- **Review process (v1):** draft-branch based, still no GitHub Actions, no
  bots. The generation script itself creates a `book/<slug>` branch off
  `main` and commits the generated JSON there (`main` stays untouched); you
  preview with `astro dev`, edit the JSON directly if needed, then merge to
  `main` yourself when satisfied. Pushing that branch and opening a PR is a
  manual step for now — Cloudflare will build a preview deployment for the
  pushed branch, no CI required — auto-pushing is a later upgrade (see
  Part 5), don't build it now.
- **Content fidelity (v1):** generation is title-only, using search-API
  grounding — not grounded in the actual book text/PDF. This is a known,
  accepted limitation for v1, not a bug to fix immediately.
- **Data source of truth:** the JSON file per book. The rendered Astro page is
  a pure function of that JSON — if a page looks wrong, the fix is almost
  always editing the JSON, not the template.

## Repo layout (top-level, for orientation)

```
book-keeper/
├── src/
│   ├── content.config.ts      # thin defineCollection wrapper (Part 1)
│   ├── content/
│   │   ├── schema.ts           # the actual Zod schema — plain module, no
│   │   │                       # astro:content import, so both Astro and
│   │   │                       # the generation script can import it (Part 1/2)
│   │   └── books/*.json       # One file per book (Part 1)
│   ├── components/            # BookCard, ChapterBlock, TagPill, ReviewDeck (Parts 3-4)
│   ├── layouts/
│   └── pages/
│       ├── index.astro        # All books
│       ├── books/[slug].astro
│       ├── tags/[tag].astro
│       └── review/[...slug].astro
├── scripts/
│   ├── generate-book.ts       # Generation pipeline: graph + CLI entry (Part 2)
│   ├── lib/                   # model.ts, git.ts, prompts.ts (Part 2)
│   └── search/                # SearchProvider interface + TavilyProvider (Part 2)
├── astro.config.mjs
└── package.json
```

## Definition of done for the whole project

You can run one command with a book title, get a validated JSON file, preview
it locally, push it live, see it on the homepage and its tag page, and flip
through its key claims in review mode. That's the whole loop — resist adding
scope beyond that until it's working end to end.
