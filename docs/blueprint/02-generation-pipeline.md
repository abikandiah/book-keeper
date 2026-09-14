# Part 2 — Generation Pipeline

**Context:** "Book Keeper" is a static Astro site (see `00-INDEX.md`). Part 1
defined the target schema, which — see "A schema-location correction" below —
actually lives in `src/content/schema.ts`, not `src/content.config.ts`. This
part is the script that produces that JSON from just a book title, using an
LLM via OpenRouter, with Tavily for search grounding, orchestrated as a
**LangGraph** state graph with a parallel, concurrency-capped fan-out over
chapters — see "Orchestration: LangGraph" below for why the graph shape earns
its keep here, not just as a stylistic choice.

This part has been built and run against real LangGraph/OpenRouter/Tavily
APIs (schema binding, HTTP auth, and the graph wiring were all exercised
directly — only live LLM/search *content* generation is untested, since that
needs real API keys). The code samples below reflect what actually shipped,
including a few corrections that only surfaced once it was wired up for real.

## Goal

A CLI script: `pnpm run generate -- "Fooled by Randomness"` (or similar) that
runs a multi-stage pipeline, writes a schema-valid JSON file to
`src/content/books/<slug>.json`, and commits it to a fresh draft branch
(`book/<slug>`) off `main`. It does **not** push that branch or open a PR —
that stays a manual step for now (see Part 5). Reviewing, editing, and
merging the branch is entirely up to you.

Optionally: `pnpm run generate -- "Fooled by Randomness" --notes ./my-notes.txt`.
`--notes <path>` reads a local text file of your own rough notes/highlights
from actually reading the book and feeds it into the Synthesis stage prompt
(see Stage 3) as a *weighting signal only* — it biases which claims/themes
the model treats as important, it is never quoted or persisted. The notes
file itself is never written into the book JSON or committed anywhere; it's
a pure generation-time input, gone once the run finishes. This exists
because generic AI-picked "most important claims" don't necessarily match
what actually struck *you* when reading — the notes are a lightweight way to
ground the summary in your own reading experience without turning your raw
(possibly messy) notes into published site content.

## Why multiple stages instead of one prompt

A single "summarize this book" prompt produces inconsistent structure across
books of different lengths and genres. Splitting into stages, each with a
narrow job and a validated handoff, is what actually guarantees every book
ends up the same shape. Don't collapse these stages back into one call.

## A schema-location correction

Part 1 originally assumed the generation script could `import` the Zod
schema straight out of `src/content.config.ts`. It can't: that file imports
`z` and `defineCollection` from the virtual module `astro:content`, which
only resolves inside Astro's own Vite-powered build/dev pipeline — a
standalone script run via `tsx` (no Vite involved) gets `Error: Cannot find
module 'astro:content'` the instant it imports anything from that file,
confirmed directly.

The fix: the schema itself lives in **`src/content/schema.ts`** — a plain
module with a single `import { z } from 'zod'` and no Astro-specific imports
at all — exporting `chapterSchema`, `chapterContentSchema` (chapter fields
minus `number`/`title`, which the script fills in itself rather than trusting
the model to count correctly), `keyClaimSchema`, `bookSchema`, plus two
pipeline-specific schemas composed from `bookSchema`'s own field
definitions (so nothing is redefined twice):

```ts
export const outlineSchema = z.object({
  title: bookSchema.shape.title,
  author: bookSchema.shape.author,
  year: bookSchema.shape.year,
  chapter_titles: z.array(z.string()).min(1),
});

export const synthesisSchema = z.object({
  one_line_takeaway: bookSchema.shape.one_line_takeaway,
  synopsis: bookSchema.shape.synopsis,
  tags: bookSchema.shape.tags,
  key_claims_for_review: bookSchema.shape.key_claims_for_review,
});
```

`src/content.config.ts` becomes a thin wrapper: it imports `bookSchema` from
`src/content/schema.ts` and wires it into `defineCollection` with the `glob`
loader (see Part 1). The generation script imports directly from
`src/content/schema.ts` and never touches `src/content.config.ts` — this is
still "one source of truth for the shape," just one file lower than
originally assumed.

## Provider & search setup

**LLM provider: OpenRouter**, via `@langchain/openai`'s `ChatOpenAI` class
pointed at OpenRouter's OpenAI-compatible endpoint:

```ts
// scripts/lib/model.ts
import { ChatOpenAI } from '@langchain/openai';

export function createModel(): ChatOpenAI {
  return new ChatOpenAI({
    apiKey: process.env.OPENROUTER_API_KEY,
    model: process.env.LLM_MODEL,
    configuration: { baseURL: process.env.LLM_BASE_URL },
  });
}
```

Note `baseURL` nests under `configuration`, not a top-level field — confirmed
against the installed `@langchain/openai` version's types (`configuration?:
ClientOptions`). Not the raw `openai` SDK, and not the Anthropic API
directly. Using LangChain's own model wrapper (rather than a second SDK
alongside LangGraph) keeps the whole pipeline in one ecosystem: every node
gets `.withStructuredOutput(zodSchema)`, which binds a call directly to a Zod
schema and returns parsed, shape-checked output — doing a large chunk of the
Stage 4 validation job before the repair loop ever needs to run. Confirmed
directly: `@langchain/langgraph`'s installed version declares a `zod`
peer range of `^3.25.32 || ^4.2.0`, and `withStructuredOutput` has an explicit
`ZodV4Like` overload — this project's `zod@4.x` is fully supported, not just
hopefully compatible.

**Search provider: Tavily** (`scripts/search/tavily.ts`, `TAVILY_API_KEY`) —
built for LLM/RAG use, returns cleaned content rather than raw HTML, free
tier needs no credit card. Google CSE (`scripts/search/google-cse/`) was
tried as an alternative but its free tier no longer supports open-web
search, so it's kept only as a shelved implementation — see `.env.example`.

The key architectural reason search needs its own step: most models
available through OpenRouter have **no built-in web search tool** — there's
no equivalent of a single "enable web search" flag that works across models.
So search has to be its own explicit call you write, not something the model
triggers mid-generation:

1. Call the search API directly (Tavily).
2. Take the top few results (titles + content) and paste them into the
   prompt as context: "Here is what search turned up: [...]. Based on this,
   do X."
3. The model then reasons over that pasted context — it's not calling
   search itself, you're doing retrieval-then-generate manually.

This means the Outline stage and every per-chapter call need a search call
**before** the LLM call, not a tool the LLM invokes on its own.

### Keep the search provider swappable

Search providers come and go, so no stage hard-wires a provider's SDK/API
shape. Everything depends on one small interface instead:

```ts
// scripts/search/types.ts
export interface SearchResult {
  title: string;
  url: string;
  content: string; // cleaned text/snippet, not raw HTML
}

export interface SearchProvider {
  search(query: string, maxResults?: number): Promise<SearchResult[]>;
}
```

The active implementation, `TavilyProvider` (`scripts/search/tavily.ts`),
is a thin wrapper around Tavily's REST API: POST the query, map its
`results` array into `{ title, url, content }`, throw a descriptive error
(including Tavily's own error body) on a non-OK response.

`GoogleCseProvider` (`scripts/search/google-cse/provider.ts`) still exists
as a second, currently-inactive `SearchProvider` implementation — split
into three single-concern files rather than one class doing everything:

- `google-cse/client.ts` — the raw Custom Search JSON API call
  (`key`/`cx`/`q`/`num` query params), mapped into an internal
  `{ title, url, snippet }` shape. Throws a descriptive error on failure,
  calling out a 429 specifically as a daily-quota exhaustion.
- `google-cse/extract.ts` — `extractPageText(url)`, a best-effort page fetch
  + Readability extraction, needed because Google CSE's API only returns
  short meta-description snippets (~200 chars), not cleaned content like
  Tavily. Never throws (mirrors `lib/openlibrary.ts`'s `lookupIsbn`
  convention) — any failure just resolves to `undefined` so the caller can
  fall back to the snippet instead of breaking generation.
- `google-cse/provider.ts` — `GoogleCseProvider implements SearchProvider`,
  the only file of the three that touches `SearchResult`/`SearchProvider`.
  Composes the other two: calls `client.ts` for results, then runs
  `extract.ts` over each URL concurrently (its own small `pLimit`, separate
  from `generate-book.ts`'s `CHAPTER_CONCURRENCY`), preferring extracted
  text over the raw snippet when it's actually longer.

Every stage/node depends only on the `SearchProvider` interface, never a
concrete provider directly. Switching which one is active is one import +
one instantiation line in `generate-book.ts`'s `main()`, nothing else.

**On free-tier models:** `LLM_MODEL` can point at a specific `:free`-suffixed
OpenRouter model, or at `openrouter/free` (the `.env.example` default) —
OpenRouter's own auto-router across its free-model pool, which spreads load
instead of hammering one model. Either way the pipeline's LLM cost is
genuinely $0. Trade-offs worth knowing: free models
typically have tighter per-minute rate limits (relevant now that chapters
run concurrently — see the concurrency cap below) and can be less reliable
with `withStructuredOutput` than a stronger paid model — if repair retries
max out often, that's the signal to try a paid model for the Synthesis
stage specifically, while keeping a free model for the more mechanical
Outline/per-chapter work.

## Orchestration: LangGraph

Build the pipeline as a LangGraph state graph (`@langchain/langgraph` +
`@langchain/core`). The pipeline's actual shape needs two things LangGraph
gives you directly:

1. **Parallel, dynamic fan-out over chapters.** The chapter count isn't
   known until the Outline stage runs, and once it is, every chapter's
   detail generation is independent work that benefits from running
   concurrently. This is LangGraph's map-reduce pattern: a routing function
   returns an array of `Send("chapterDetail", { ...perChapterState })`
   objects, one per chapter, and LangGraph runs each as its own invocation
   of the `chapterDetail` node, merging results back into shared state via
   an annotation's reducer once every branch completes.
2. **Room to extend.** Adding a future stage is "write a node function, add
   it to the graph" rather than restructuring a hand-called sequence.

### Two real gotchas, confirmed by actually compiling the graph

- **`Annotation`'s `default` option requires an explicit `reducer`** (or the
  deprecated `value`) alongside it in the installed LangGraph version —
  `Annotation<T>({ default: () => x })` alone is a type error
  (`SingleReducer` has no default-only variant). For a plain "last write
  wins" field with a default, pair it with a trivial overwrite reducer:

  ```ts
  const overwrite = <T,>(_existing: T, update: T): T => update;
  // ...
  slug: Annotation<string>({ reducer: overwrite, default: () => '' }),
  ```

  Fields that don't need a default (`author`, `year`, `synthesis`, `book`)
  can still use the no-argument form, `Annotation<T | undefined>()`.

- **A node name cannot match a state channel name.** The natural name for
  the Stage 3 node — `synthesis` — collides with the state field also named
  `synthesis` (which holds that node's own output). LangGraph throws at
  graph-construction time: `"synthesis" is already being used as a state
  attribute... cannot also be used as a node name`. The node is named
  **`synthesize`** instead; the state field stays `synthesis`.

### Concurrency cap on the chapter fan-out

`Send`-based fan-out runs everything dispatched to it concurrently by
default, with no built-in throttling. Wrap the actual network calls inside
`chapterDetail` with `p-limit`, capped at **3-5 concurrent** (default 4, via
`CHAPTER_CONCURRENCY`) — fast enough to matter on long books, conservative
enough to stay under typical free-tier per-minute limits. Lower it if the
active model's limit is tighter than that.

### Per-chapter validation

Validate each chapter's output against `chapterSchema` **inside the
`chapterDetail` node itself**. The model is only asked for `chapterContentSchema`
(`key_points` + `core_claim`) — `number` and `title` are attached by the
script from the Outline stage's own ordered list, not trusted to the model,
so a chapter can't end up mislabeled or miscounted. If the assembled object
fails `chapterSchema`, retry locally (feed the error back, capped at 2 local
attempts) before letting it propagate.

### State shape

```ts
import { Annotation } from '@langchain/langgraph';
import type { Book, Chapter, Synthesis } from '../src/content/schema';

const overwrite = <T,>(_existing: T, update: T): T => update;

const BookGenState = Annotation.Root({
  title: Annotation<string>(),
  force: Annotation<boolean>({ reducer: overwrite, default: () => false }),
  slug: Annotation<string>({ reducer: overwrite, default: () => '' }),
  author: Annotation<string | undefined>(),
  year: Annotation<number | undefined>(),
  chapterTitles: Annotation<string[]>({ reducer: overwrite, default: () => [] }),
  chapterIndex: Annotation<number>({ reducer: overwrite, default: () => 0 }),
  totalChapters: Annotation<number>({ reducer: overwrite, default: () => 0 }),
  chapters: Annotation<Chapter[]>({
    default: () => [],
    reducer: (existing, update) => existing.concat(update), // merges fan-out results
  }),
  synthesis: Annotation<Synthesis | undefined>(),
  book: Annotation<Book | undefined>(), // final assembled+validated object, for Stage 5 to write
  validationErrors: Annotation<string[]>({ reducer: overwrite, default: () => [] }),
  retryCount: Annotation<number>({ reducer: overwrite, default: () => 0 }),
});
```

### Nodes and edges

```ts
import { StateGraph, START, END, Send } from '@langchain/langgraph';

function dispatchChapters(state: typeof BookGenState.State) {
  return state.chapterTitles.map(
    (chapterTitle, index) =>
      new Send('chapterDetail', {
        title: state.title,
        author: state.author,
        year: state.year,
        chapterTitles: [chapterTitle], // singleton — this Send's one chapter
        chapterIndex: index,
        totalChapters: state.totalChapters,
      }),
  );
}

const graph = new StateGraph(BookGenState)
  .addNode('setup', setupNode)               // Stage 0
  .addNode('outline', outlineNode)           // Stage 1
  .addNode('chapterDetail', chapterDetailNode) // Stage 2, one invocation per chapter
  .addNode('synthesize', synthesisNode)      // Stage 3 — NOT "synthesis", see above
  .addNode('validate', validateNode)         // Stage 4 (check only)
  .addNode('repair', repairNode)             // Stage 4 (fix-and-retry)
  .addNode('fail', failNode)                 // Stage 4 (throws with the last validation error)
  .addNode('publish', publishNode)           // Stage 5 (branch + write + commit)
  .addEdge(START, 'setup')
  .addEdge('setup', 'outline')
  .addConditionalEdges('outline', dispatchChapters)
  .addEdge('chapterDetail', 'synthesize') // LangGraph waits for every fanned-out branch first
  .addEdge('synthesize', 'validate')
  .addConditionalEdges(
    'validate',
    (state) =>
      state.validationErrors.length === 0
        ? 'publish'
        : state.retryCount < 3
          ? 'repair'
          : 'fail',
    { publish: 'publish', repair: 'repair', fail: 'fail' }, // explicit path map
  )
  .addEdge('repair', 'validate')
  .addEdge('fail', END)
  .addEdge('publish', END);

const app = graph.compile();
```

Note the explicit path map on `validate`'s conditional edges, and the real
`fail` node — a routing function returning a string with no corresponding
node/pathMap entry throws at runtime. `failNode` throws with the last
validation error rather than silently reaching `END`.

### Checkpointing — not needed for v1, but worth knowing it's there

LangGraph supports a `checkpointer` (in-memory `MemorySaver`, or persistent
SQLite-backed) that would let a crashed run resume from its last completed
node. More relevant now than before, given chapters run as their own
fanned-out invocations — a crash partway through a long textbook's chapter
fan-out is exactly the case checkpointing exists for. Still skip it for v1.
See Part 5.

## Stage breakdown

### Stage 0 — Setup
- Slug the title (kebab-case, NFKD-normalized to strip diacritics).
- If `src/content/books/<slug>.json` exists, **or** a `book/<slug>` branch
  exists, refuse unless `--force` is passed.
- Refuse if the working tree isn't clean (checked via `git status
  --porcelain`) — Stage 5 is about to create and commit to a new branch,
  and shouldn't carry unrelated uncommitted changes onto it.

### Stage 1 — Outline
**Search:** `"<title>" chapter list table of contents`, top 5 results.
**Job:** determine author, year, and the real chapter/section list, in
order — output validated against `outlineSchema`.

**Cover lookup (not model output):** after the outline call, look up an ISBN
via `scripts/lib/openlibrary.ts`'s `lookupIsbn(title, author)` — a direct
call to Open Library's `search.json` API, not the Tavily `SearchProvider`
(this is a structured field lookup consumed straight in code, not a search
snippet for an LLM to read). **The `fields` query parameter must be passed
explicitly** — confirmed directly against the live API: Open Library's
default response omits `isbn` entirely unless you ask for it
(`fields=isbn`), which isn't obviously documented anywhere and will silently
produce `undefined` for every book if missed. Never throws: any failure
(no match, network error, malformed response) resolves to `undefined`,
which just means that book renders without a cover — never blocks
generation.

### Stage 2 — Per-chapter drafting (parallel, concurrency-capped)
One `chapterDetail` invocation per chapter, dispatched via `Send`, throttled
to 3-5 concurrent via `p-limit`. **Search:** `"<book title>" "<chapter
title>" summary` per chapter. **Job:** produce `key_points` + `core_claim`
(validated against `chapterContentSchema`), assemble the full chapter object
with the script-supplied `number`/`title`, then validate that assembled
object against `chapterSchema`, retrying locally on failure.

### Stage 3 — Synthesis
**Input:** all chapter objects from Stage 2, sorted and formatted into a
plain-text summary — the model synthesizes from what it just produced, not
from the raw title again. **Search:** `"<title>" <author> themes summary`,
top 3 results, as supporting context. If `--notes` was passed, the reader's
raw notes are appended to the prompt as a weighting signal only (explicitly
instructed: not source content, never quoted verbatim — see "Goal" above).
**Job:** produce `one_line_takeaway`/`synopsis`/`tags`/`key_claims_for_review`,
validated against `synthesisSchema`.

### Stage 4 — Assembly & validation
Merge Stages 1-3 into one object — plus `verified: false`, always, never the
model's to set (see Part 1) — and validate with `bookSchema` (imported
from `src/content/schema.ts` — see the schema-location correction above).
On failure: feed the Zod error back to the model in a repair call bound to
`synthesisSchema` (chapters are already individually valid, so repair only
ever needs to touch the top-level fields). Cap at 3 retries, then throw via
`fail` — never write an invalid file.

### Stage 5 — Publish to a draft branch
- `git checkout -B book/<slug>` (from whatever branch Stage 0 ran on,
  expected to be `main`) — `-B` rather than `-b` since Stage 0 already
  gated existence/`--force` before we ever get here.
- Write the JSON, pretty-printed, to `src/content/books/<slug>.json`.
- `git add` + commit with message `Add <title>`.
- **Stop there.** No push, no PR — deliberately deferred (see Part 5).

## Suggested implementation shape

- `src/content/schema.ts` — plain Zod schemas, the single source of truth
  (see the schema-location correction above).
- `scripts/lib/model.ts` — `createModel()`, the `ChatOpenAI` factory.
- `scripts/lib/openlibrary.ts` — `lookupIsbn(title, author?)`, a direct
  fetch against Open Library's search API (not behind the `SearchProvider`
  interface — see Stage 1 above for why). No API key needed; it's a free,
  unauthenticated endpoint.
- `scripts/lib/git.ts` — thin wrappers around the `git` CLI via
  `node:child_process`'s `execFileSync` (branch existence/creation, clean
  working tree check, add+commit) — no git library dependency needed.
- `scripts/lib/prompts.ts` — prompt-building functions per stage, plus a
  shared repair-prompt builder (previous output + Zod errors → "fix this").
- `scripts/search/types.ts` + `scripts/search/tavily.ts` — the
  `SearchProvider` interface and its Tavily implementation.
- `scripts/generate-book.ts` — state annotation, node functions, graph
  wiring, and the CLI entrypoint. Loads `.env` itself via Node's built-in
  `process.loadEnvFile('.env')` (Node 22 has this natively — no `dotenv`
  dependency needed), wrapped in try/catch since `.env` may not exist.
  Dependencies needing real API keys (the model client, the search
  provider) are constructed inside `main()`, after CLI args are validated —
  not at module load time — so `--help`-style misuse fails on the actual
  problem, not a missing key.
- Env vars needed: `OPENROUTER_API_KEY`, `LLM_BASE_URL`, `LLM_MODEL`,
  `TAVILY_API_KEY`, and optionally `CHAPTER_CONCURRENCY` (defaults to 4 in
  code if unset).

## Explicitly out of scope for v1 (see Part 5)

- Reading actual PDF/EPUB text — title/web-search-only for now.
- GitHub Action / automated PR — this stays a manually-run local script.
- Automatically pushing the draft branch or opening a PR. The script stops
  after the local commit on `book/<slug>`; pushing, opening a PR, and
  merging are manual steps for now.

## Acceptance check for this part

- ✅ `pnpm exec tsc --noEmit` passes with zero errors.
- ✅ The graph compiles (`graph.compile()` doesn't throw) — this actually
  caught the `synthesis`-name-collision bug directly, before any API calls
  were involved.
- ✅ Running with no title prints usage and exits 1, without touching any
  API keys or the filesystem.
- ✅ Running with a missing `TAVILY_API_KEY` fails with a clean, specific
  error message (not a raw stack trace) — confirmed the error is caught
  inside `main()`'s try/catch, not thrown before it.
- ✅ Running against an already-generated title (no `--force`) refuses
  before any network call, confirmed against the real
  `fooled-by-randomness.json` from Part 1.
- ✅ Running with a dirty working tree refuses with a clear message,
  confirmed against this repo's own in-progress state.
- ✅ `TavilyProvider.search()` against the real Tavily endpoint with a
  garbage key returns a clean `401 Unauthorized` with Tavily's error body,
  not a request-construction failure — confirms the endpoint, method, auth
  header, and body shape are all correct.
- ✅ `ChatOpenAI` against the real OpenRouter endpoint with a garbage key
  sends the correct `Authorization: Bearer <key>` header to the correct
  `/chat/completions` URL (confirmed by intercepting `fetch` directly) and
  gets back OpenRouter's own invalid-key error — confirms the model client
  is wired correctly end-to-end short of a real key.
- ✅ `createAndCheckoutBranch` + `commitFile` (Stage 5's git operations)
  exercised directly against a disposable test branch — branch creation,
  file write, and commit all worked, then cleaned up.
- ✅ A second review pass (independent session, no shared context) caught 10
  further issues, all fixed and re-verified: `repairNode` now repairs every
  top-level field a validation failure could implicate (title/author/year
  included, not just synthesis fields — see `repairableSchema`), the
  per-chapter local-repair prompt now includes the actual failed draft
  instead of just the chapter title, `slugify()` refuses non-ASCII-only
  titles instead of silently producing an empty slug (confirmed against an
  emoji-only title), `validateNode` sorts `chapters` by `number` before
  persisting (previously only sorted a throwaway copy used for prompting),
  `publishNode` now wraps Stage 5 in try/catch with a best-effort rollback
  to the branch Stage 0 started on (confirmed directly: a forced `git add`
  failure on a disposable branch correctly restored the original branch),
  `--force`-over-an-existing-branch now warns before silently resetting it,
  `TavilyProvider` validates the response actually has a `results` array
  before mapping over it, and Zod issue formatting was deduplicated into one
  `formatIssue` helper instead of two copies of the same `.map()`.
- ✅ `lookupIsbn` exercised against the real, live Open Library API for two
  real titles (correct ISBNs returned) and one nonsense title (`undefined`,
  no throw) — this is what caught the missing-`fields`-parameter bug above;
  the initial implementation silently returned `undefined` for every book,
  real or not, until fixed. The resulting cover URLs were confirmed to
  resolve to real JPEGs via the Covers API directly.
- ⬜ Not yet tested (needs real `OPENROUTER_API_KEY` + `TAVILY_API_KEY`):
  actual generation quality, the top-level repair-retry loop firing for
  real, and a real book ending up committed on a real `book/<slug>` branch.
- ✅ A third review pass (a full-project sweep, not scoped to one part)
  caught two more `titlesMatch`/`normalizeTitle` bugs in
  `scripts/lib/openlibrary.ts`, both fixed and re-verified against
  representative cases (short titles, diacritics, the original
  false-positive case, exact matches, all correct): (1) `MIN_PREFIX_MATCH_LENGTH`
  (12 chars, meant to stop something like "It" prefix-matching "It
  Governance for Dummies") was rejecting *every* short queried title's
  legitimate prefix match too — e.g. "Educated" vs "Educated: A Memoir" —
  even though the word-boundary check already correctly accepted it. Fixed
  by relaxing the length floor whenever an author was supplied to the
  search (`lookupIsbn` always passes one in practice — `bookSchema`/
  `outlineSchema` require `author` as non-optional), since Open Library's
  own `author` query param already narrows the result set server-side,
  making a short-title prefix match against an author-matched result far
  safer than an unscoped one. (2) `normalizeTitle` stripped diacritics as
  punctuation (deleting `ü` rather than transliterating it) instead of
  NFKD-decomposing + stripping combining marks the way `slugify()` in
  `generate-book.ts` already does — the two could normalize the same title
  differently, silently losing a match for any non-ASCII title.
