# Part 2 — Generation Pipeline

**Context:** "Book Keeper" is a static Astro site (see `00-INDEX.md`). Part 1
defined the target schema (`src/content.config.ts`) that every book's content
file must conform to. This part is the script that produces that JSON from
just a book title, using an LLM via OpenRouter, with Tavily for search
grounding, orchestrated as a **LangGraph** state graph with a parallel,
concurrency-capped fan-out over chapters — see "Orchestration: LangGraph"
below for why the graph shape earns its keep here, not just as a stylistic
choice.

## Goal

A CLI script: `pnpm run generate -- "Fooled by Randomness"` (or similar) that
runs a multi-stage pipeline, writes a schema-valid JSON file to
`src/content/books/<slug>.json`, and commits it to a fresh draft branch
(`book/<slug>`) off `main`. It does **not** push that branch or open a PR —
that stays a manual step for now (see Part 5). Reviewing, editing, and
merging the branch is entirely up to you.

## Why multiple stages instead of one prompt

A single "summarize this book" prompt produces inconsistent structure across
books of different lengths and genres. Splitting into stages, each with a
narrow job and a validated handoff, is what actually guarantees every book
ends up the same shape. Don't collapse these stages back into one call.

## Provider & search setup

**LLM provider: OpenRouter**, via `@langchain/openai`'s `ChatOpenAI` class
pointed at OpenRouter's OpenAI-compatible endpoint (`baseURL:
process.env.LLM_BASE_URL`, `apiKey: process.env.OPENROUTER_API_KEY`, `model:
process.env.LLM_MODEL`) — not the raw `openai` SDK, and not the Anthropic
API directly. Using LangChain's own model wrapper (rather than a second SDK
alongside LangGraph) keeps the whole pipeline in one ecosystem: every node
gets `.withStructuredOutput(zodSchema)`, which binds a call directly to a Zod
schema and returns parsed, shape-checked output — doing a large chunk of the
Stage 4 validation job before the repair loop ever needs to run.

**Search provider: Tavily** (`TAVILY_API_KEY`). Chosen over Brave/Serper
because it's built specifically for LLM/RAG use — it returns cleaned,
ready-to-use content rather than raw search-results HTML you'd have to parse
yourself — and its free tier (1,000 credits/month) comfortably covers this
project's volume.

The key architectural reason search needs its own step: most models
available through OpenRouter have **no built-in web search tool** — there's
no equivalent of a single "enable web search" flag that works across models.
So search has to be its own explicit call you write, not something the model
triggers mid-generation:

1. Call the search API directly (Tavily).
2. Take the top few results (titles + snippets, maybe fetch full text for
   the single best result) and paste them into the prompt as context: "Here
   is what search turned up: [...]. Based on this, do X."
3. The model then reasons over that pasted context — it's not calling
   search itself, you're doing retrieval-then-generate manually.

This means the Outline stage and every per-chapter call need a search call
**before** the LLM call, not a tool the LLM invokes on its own. Structure
each as `search() → buildPrompt(results) → callModel()` rather than a single
tool-enabled LLM call.

### Keep the search provider swappable

Tavily is a young company in a market that's already seen one shakeup this
year (the retired Bing Search API, Tavily's own acquisition by Nebius) — so
even though it's the pick for now, don't hard-wire calls to Tavily's SDK/API
shape throughout the pipeline. Isolate it behind a small interface:

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

```ts
// scripts/search/tavily.ts
import type { SearchProvider, SearchResult } from './types';

export class TavilyProvider implements SearchProvider {
  constructor(private apiKey: string) {}
  async search(query: string, maxResults = 5): Promise<SearchResult[]> {
    // call Tavily's API, map its response shape into SearchResult[]
    // ...
  }
}
```

Every stage/node should depend only on the `SearchProvider` interface (e.g.
receive one as a constructor/function argument), never import
`TavilyProvider` directly inline. Swapping providers later — Brave, Serper,
or whatever exists by then — means writing one new file that implements
`SearchProvider` and changing a single line where the provider is
instantiated. Same "validated interface as the contract" pattern as the Zod
schema in Part 1 — apply it here for the same reason.

**On free-tier models:** `LLM_MODEL` can point at one of OpenRouter's
`:free`-suffixed models (as in the `.env.example` default), making the
pipeline's LLM cost genuinely $0. Trade-offs worth knowing: free models
typically have tighter per-minute rate limits (relevant now that chapters
run concurrently — see the concurrency cap below) and can be less reliable
with `withStructuredOutput` than a stronger paid model — if repair retries
max out often, that's the signal to try a paid model for the Synthesis
stage specifically (it benefits most from stronger reasoning), while keeping
a free model for the more mechanical Outline/per-chapter work. Free-tier
model availability on OpenRouter also rotates over time — the specific
model in `.env.example` may need updating if it's deprecated later; that's
expected maintenance, not a design flaw.

## Orchestration: LangGraph

Build the pipeline as a LangGraph state graph (`@langchain/langgraph` +
`@langchain/core`, the JS/TS packages — not the Python ones). This isn't
just "matching some other project's pattern" — the pipeline's actual shape
needs two things LangGraph gives you directly:

1. **Parallel, dynamic fan-out over chapters.** The chapter count isn't
   known until the Outline stage runs, and once it is, every chapter's
   detail generation is independent work that benefits from running
   concurrently rather than one-at-a-time, especially for long books. This
   is LangGraph's map-reduce pattern: a routing function returns an array of
   `Send("chapterDetail", { ...perChapterState })` objects, one per chapter,
   and LangGraph runs each as its own invocation of the `chapterDetail`
   node, then merges their results back into shared state via an
   annotation's reducer once every branch completes — no manual
   `Promise.all` bookkeeping required.
2. **Room to extend.** Adding a future stage (e.g. a fact-check pass, a
   discussion-questions generator, a difficulty rating) is "write a node
   function, add it to the graph" rather than restructuring a hand-called
   sequence of functions. Don't build any such stage now — just don't
   design the graph in a way that makes adding one later painful.

### Concurrency cap on the chapter fan-out

`Send`-based fan-out runs everything dispatched to it concurrently by
default, with no built-in throttling. Left uncapped, a 40-chapter textbook
would fire 40 simultaneous LLM + search calls, which free-tier OpenRouter
models (and possibly Tavily) will rate-limit hard. Wrap the actual network
calls inside `chapterDetail` with `p-limit`, capped at **3-5 concurrent**
(a module-level constant or `CHAPTER_CONCURRENCY` env var, default 4) —
fast enough to matter on long books, conservative enough to survive the
default free-tier model.

### Per-chapter validation

Validate each chapter's output against `chapterSchema` **inside the
`chapterDetail` node itself**, right when it's produced — not only once, at
the very end, against the fully assembled object. If a chapter fails
validation, retry that one chapter locally (feed the Zod error back, same
pattern as the top-level repair loop, capped at 2 local attempts) before
letting it propagate. This means one bad chapter doesn't force a full-pipeline
repair retry, and by the time everything converges on Synthesis, every
chapter is already known-good — the final Stage 4 validate step is really
only checking the top-level synthesis fields and overall object shape, not
re-litigating chapter structure.

### State shape

```ts
import { Annotation } from "@langchain/langgraph";

const BookGenState = Annotation.Root({
  title: Annotation<string>(),
  slug: Annotation<string>(),
  author: Annotation<string | undefined>(),
  year: Annotation<number | undefined>(),
  chapterTitles: Annotation<string[]>({ default: () => [] }),
  chapters: Annotation<ChapterDraft[]>({
    default: () => [],
    reducer: (existing, update) => existing.concat(update), // merges fan-out results
  }),
  synthesis: Annotation<SynthesisFields | undefined>(), // one_line_takeaway, synopsis, tags, key_claims_for_review
  validationErrors: Annotation<string[]>({ default: () => [] }),
  retryCount: Annotation<number>({ default: () => 0 }),
});
```

### Nodes and edges

```ts
import { StateGraph, START, END, Send } from "@langchain/langgraph";

const graph = new StateGraph(BookGenState)
  .addNode("setup", setupNode)               // Stage 0
  .addNode("outline", outlineNode)           // Stage 1
  .addNode("chapterDetail", chapterDetailNode) // Stage 2, one invocation per chapter
  .addNode("synthesis", synthesisNode)       // Stage 3
  .addNode("validate", validateNode)         // Stage 4 (check only)
  .addNode("repair", repairNode)             // Stage 4 (fix-and-retry)
  .addNode("fail", failNode)                 // Stage 4 (throws with the last validation error)
  .addNode("publish", publishNode)           // Stage 5 (branch + write + commit)
  .addEdge(START, "setup")
  .addEdge("setup", "outline")
  .addConditionalEdges("outline", (state) =>
    state.chapterTitles.map((title, i) => new Send("chapterDetail", { title, index: i }))
  )
  .addEdge("chapterDetail", "synthesis") // LangGraph waits for every fanned-out branch first
  .addEdge("synthesis", "validate")
  .addConditionalEdges(
    "validate",
    (state) =>
      state.validationErrors.length === 0
        ? "publish"
        : state.retryCount < 3
        ? "repair"
        : "fail",
    { publish: "publish", repair: "repair", fail: "fail" } // explicit path map — don't rely on string-matches-node-name
  )
  .addEdge("repair", "validate")
  .addEdge("fail", END)
  .addEdge("publish", END);

const app = graph.compile();
await app.invoke({ title: process.argv[2] });
```

Note the explicit path map on `validate`'s conditional edges, and the real
`fail` node — a routing function returning a string with no corresponding
node/pathMap entry throws at runtime, so `"fail"` needs to resolve to
something. `failNode` should throw with the last validation error rather
than silently reaching `END`, per Stage 4's "never write an invalid file"
rule below.

### Checkpointing — not needed for v1, but worth knowing it's there

LangGraph supports a `checkpointer` (in-memory `MemorySaver`, or a
persistent one backed by SQLite) that would let a crashed run resume from
its last completed node instead of restarting the Outline stage's search
calls from scratch. More relevant now than before, given chapters run as
their own fanned-out invocations — a crash partway through a long
textbook's chapter fan-out is exactly the case checkpointing exists for.
Still skip it for v1 (a book generation run completes in well under a
minute even with the concurrency cap) — but it's the natural next upgrade
if generation ever starts timing out or getting expensive to redo. See
Part 5.

## Stage breakdown

### Stage 0 — Setup
- Take the title as input (author optional, disambiguate via search if
  needed).
- Generate the slug (kebab-case title).
- If `src/content/books/<slug>.json` already exists, **or** a `book/<slug>`
  branch already exists, refuse to proceed unless a `--force` flag is
  passed (protects against accidental overwrite of an edited file or an
  in-progress draft).
- Confirm the working tree is clean before branching — this script is about
  to create and check out a new branch, and shouldn't carry unrelated
  uncommitted changes onto it.

### Stage 1 — Outline
**Input:** title (+ author if given).
**Search:** query the search API for the book (e.g. `"<title>" chapter list
table of contents`), pull top results' snippets/text — publisher pages,
"look inside" previews, Goodreads tables of contents tend to surface well.
**Job:** Pass those search results into the prompt and have the model
determine author, year, and the book's actual chapter/section list (titles,
in order). This stage's *only* output is metadata + an ordered list of
chapter titles. Do not generate summaries yet.
**Output:** `{ title, author, year, chapter_titles: string[] }` — this list
is exactly what the fan-out to `chapterDetail` dispatches over.

Why this is separate: getting the real chapter structure right up front is
what prevents the model from inventing a generic 10-chapter structure that
doesn't match the actual book.

### Stage 2 — Per-chapter drafting (parallel, concurrency-capped)
**Input:** one chapter title (+ index) from Stage 1's list — each
`chapterDetail` invocation handles exactly one chapter, dispatched via the
`Send`-based fan-out described above, throttled to 3-5 concurrent via
`p-limit`.
**Search:** a query per chapter, e.g. `"<book title>" "<chapter title>"
summary`, results pasted into that call's prompt as context.
**Job:** Produce `key_points` (max 6, per the schema) and a single
`core_claim` sentence, then validate the result against `chapterSchema`
inline (see "Per-chapter validation" above), retrying locally up to twice on
failure before letting an error propagate.
**Output:** one chapter object matching the `chapterSchema` from Part 1,
merged into shared state's `chapters` array once every dispatched invocation
completes.

Note: chapter-level search results are often thinner than book-level ones
(not every chapter has dedicated coverage online) — the model will need to
lean more on general knowledge plus whatever partial context search returns
for this stage. That's an accepted v1 limitation, not a bug to solve now.

### Stage 3 — Synthesis
**Input:** all chapter objects from Stage 2 (not the raw title — the model
should synthesize from what it just produced, so the top-level synopsis
actually reflects the chapter-level content rather than a generic
web-summary of the book). Every chapter arriving here is already
schema-valid, since Stage 2 validated inline.
**Job:** Produce `one_line_takeaway`, `synopsis` (1-3 paragraphs), `tags`
(free-form, lowercase-kebab), and `key_claims_for_review` (5-15 prompt/answer
pairs, per the schema).
**Output:** the remaining top-level fields.

### Stage 4 — Assembly & validation
- Merge Stages 1-3 into one object matching the full schema from Part 1.
  Chapters are already individually valid, so this check is really about
  the top-level synthesis fields and overall object shape.
- Validate with the **same Zod schema** used in `src/content.config.ts` — the
  script should literally import it from there rather than redefining it, so
  there's exactly one source of truth for the shape.
- On validation failure: feed the Zod error output back to the model in a
  repair call ("here's what you produced, here's the validation error, fix
  it") rather than starting over. Cap retries at 3 and fail loudly (throw,
  via the `fail` node) with the last error if still invalid — never write an
  invalid file.

### Stage 5 — Publish to a draft branch
- On validation success: create and check out a new branch, `book/<slug>`,
  off the current `HEAD` (expected to be `main`).
- Write the JSON to `src/content/books/<slug>.json`, pretty-printed.
- `git add` + commit that file on `book/<slug>` with a message like `Add
  <title>`.
- **Stop there.** Do not push the branch, do not open a PR — that's a
  deliberate, deferred manual step (see Part 5). The script's job ends at
  "committed on a local draft branch, ready for you to review."
- Print next steps to stdout: which branch you're on, and to run `astro
  dev` to review `/books/<slug>` before merging.

## Suggested implementation shape

- Language: TypeScript/Node (so it can literally `import` the Zod schema from
  `src/content.config.ts` — avoids maintaining the schema twice).
- LLM calls: `@langchain/openai`'s `ChatOpenAI`, `baseURL:
  process.env.LLM_BASE_URL`, `model: process.env.LLM_MODEL`, `apiKey:
  process.env.OPENROUTER_API_KEY`. Use `.withStructuredOutput(zodSchema)`
  per node (chapter schema for `chapterDetail`, a synthesis-fields schema
  for `synthesis`) rather than hand-parsing raw completions. Reading the
  model/base URL from env vars rather than hardcoding them means the model
  can be changed per-run or upgraded later with no code change.
- Search calls: implement `TavilyProvider` behind the `SearchProvider`
  interface (see "Keep the search provider swappable" above), called before
  the LLM call in Outline and each `chapterDetail` invocation — never call
  Tavily's API directly from inside node logic.
- Concurrency: `p-limit`, capped at 3-5 (see "Concurrency cap on the
  chapter fan-out" above), wrapping the search+LLM calls inside
  `chapterDetail`.
- Git operations (Stage 5): shell out to the `git` CLI (e.g.
  `child_process.execFileSync`) for branch creation/checkout and the
  commit — no new git library needed for this.
- Env vars needed: `OPENROUTER_API_KEY`, `LLM_BASE_URL`, `LLM_MODEL`,
  `TAVILY_API_KEY`, and optionally `CHAPTER_CONCURRENCY` — all already in
  `.env.example` (Part 0) except the last, which can default in code.
- Log progress to stdout per stage/chapter (title found, N chapters found,
  chapter X/N drafted, synthesis done, validated, branch created) — useful
  for debugging and because chapter fan-out, even capped, still takes a
  noticeable number of seconds on longer books.

## Explicitly out of scope for v1 (see Part 5)

- Reading actual PDF/EPUB text — title/web-search-only for now.
- GitHub Action / automated PR — this stays a manually-run local script.
- Automatically pushing the draft branch or opening a PR. The script stops
  after the local commit on `book/<slug>`; pushing (`git push -u origin
  book/<slug>`), opening a PR, and merging are manual steps for now — worth
  automating later once you're comfortable with the branch-based flow, but
  not v1.

## Acceptance check for this part

- Running the script against a real title (e.g. one from Part 1's example)
  produces a file that passes Astro's build validation with no manual edits,
  committed on a new `book/<slug>` branch, with `main` untouched.
- Chapters visibly generate concurrently (log timestamps overlap across
  chapters), not silently serially, and no more than
  `CHAPTER_CONCURRENCY` are in flight at once.
- Deliberately breaking one chapter's output confirms per-chapter
  validation/local-repair actually catches it without failing the whole run.
- Running the script twice on the same title without `--force` refuses to
  proceed (whether the file or the branch already exists).
- Deliberately breaking Stage 3's output (e.g. via a bad prompt tweak) and
  confirming the top-level repair-retry loop actually fires and either
  fixes it or fails loudly via the `fail` node — don't let this path go
  untested.
