import fs from 'node:fs';
import path from 'node:path';
import { Annotation, END, START, Send, StateGraph } from '@langchain/langgraph';
import pLimit from 'p-limit';
import { z } from 'zod';

import {
	bookSchema,
	chapterContentSchema,
	chapterSchema,
	fictionBookSchema,
	fictionRepairableSchema,
	outlineSchema,
	repairableSchema,
	synthesisSchema,
	type Book,
	type Chapter,
	type FictionRepairable,
	type Outline,
	type Repairable,
	type Synthesis,
} from '../src/content/schema';
import { currentBranch, isGitRepo } from './lib/git';
import { loadKnownFacts, type KnownFacts } from './lib/known-facts';
import { log, logError } from './lib/log';
import { createModel } from './lib/model';
import { lookupEditionByIsbn, lookupIsbn, lookupSubjects } from './lib/openlibrary';
import {
	buildChapterCritiquePrompt,
	buildChapterPrompt,
	buildFictionSummaryPrompt,
	buildKnownFactsCritiquePrompt,
	buildOutlineConsensusPrompt,
	buildOutlinePrompt,
	buildRepairPrompt,
	buildSynthesisPrompt,
	type OutlineCandidate,
} from './lib/prompts';
import { checkPublishable, publishBook, slugify } from './lib/publish';
import { TavilyProvider } from './search/tavily';
import type { SearchProvider, SearchResult } from './search/types';

// Chapter-level review: a second, independent model call judging a drafted
// chapter's factual grounding before it's accepted. Deliberately narrow —
// see buildChapterCritiquePrompt — flags only fabricated/contradicted
// claims, not subjective style/depth, so it isn't burning retries on
// judgment calls that don't actually matter.
const critiqueSchema = z.object({
	plausible: z.boolean(),
	concerns: z.array(z.string()),
});
type Critique = z.infer<typeof critiqueSchema>;

// Outline-level review is consensus, not critique — see outlineNode. A
// single model critiquing its own draft against the same search results it
// was drafted from can't catch a wrong-but-consistent draft (confirmed
// directly: a Google Books preview fooled both a draft and its own critique
// into agreeing on a truncated chapter list, since both were judging against
// the same partial source). Three independently-sourced candidates, then one
// judge call reconciling them, actually gives the judge different evidence
// to cross-check against.
const outlineConsensusSchema = z.object({
	title: z.string(),
	author: z.string().optional(),
	year: z.number().optional(),
	chapter_titles: z.array(z.string()).min(1),
	agreement: z.enum(['unanimous', 'majority', 'split']),
	notes: z.string().optional(),
});

interface OutlineSearchStrategy {
	label: string;
	maxResults: number;
	excludeDomains?: string[];
	includeDomains?: string[];
}

// books.google.com preview pages only show a partial chapter list, with
// nothing marking them as incomplete — the specific source that caused the
// failure below. Shared (not just copied) between OUTLINE_SEARCH_STRATEGIES
// and verifyKnownFactsNode's own chapter-list search so a future edit to
// this exclusion can't silently apply to only one of the two.
const CHAPTER_LIST_SEARCH_EXCLUDE_DOMAINS = ['books.google.com'];

const OUTLINE_SEARCH_STRATEGIES: OutlineSearchStrategy[] = [
	{ label: 'general web search', maxResults: 8, excludeDomains: CHAPTER_LIST_SEARCH_EXCLUDE_DOMAINS },
	// Product/listing pages that tend to show a real table of contents.
	{
		label: 'bookseller listings',
		maxResults: 5,
		includeDomains: ['amazon.com', 'barnesandnoble.com', 'bookshop.org', 'thriftbooks.com', 'abebooks.com'],
	},
	// Library catalog metadata, often including a structured TOC field.
	{ label: 'library catalogs', maxResults: 5, includeDomains: ['openlibrary.org', 'worldcat.org', 'loc.gov'] },
];

try {
	process.loadEnvFile('.env');
} catch {
	// no .env file present — fine, vars may already be set in the environment
}

const MAX_TOP_LEVEL_RETRIES = 3;
const MAX_CHAPTER_LOCAL_RETRIES = 2;
const CHAPTER_CONCURRENCY = Number(process.env.CHAPTER_CONCURRENCY) || 4;

function requireEnv(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`${name} is not set (see .env.example).`);
	return value;
}

// Shared by chapterDetailNode and validateNode so Zod errors are formatted
// identically in both places rather than duplicating the same `.map()`.
function formatIssue(issue: { path: PropertyKey[]; message: string }): string {
	return `${issue.path.map(String).join('.')}: ${issue.message}`;
}

// Constructed lazily in main(), after CLI args are validated, so a missing
// API key doesn't get in the way of e.g. printing usage.
let searchProvider: SearchProvider;
let model: ReturnType<typeof createModel>;
let chapterLimit: ReturnType<typeof pLimit>;

// Set from --emit-json in main(). When present, the graph ends at `emit`
// (write the validated book JSON to this path) instead of `publish` (git
// branch/commit) — see setupNode/emitNode and the "Graph wiring" section
// below. This is the entrypoint scripts/generate-sandboxed.sh's Docker
// image uses; it works equally well un-sandboxed for anyone who just wants
// the JSON without a git side-effect.
let emitJsonPath: string | undefined;

// LangGraph's `default` option only applies alongside an explicit `reducer` —
// there's no "just take the default" shorthand, so this is "last write wins"
// for every field below that isn't accumulated across the chapter fan-out.
const overwrite = <T,>(_existing: T, update: T): T => update;

const BookGenState = Annotation.Root({
	title: Annotation<string>(),
	// False when `title` above is actually the --known file's own basename
	// (see parseArgs), not a real title the reader typed. outlineNode's
	// known.chapters branch checks this before ever treating `title` as
	// publishable — see the comment there. Defaults to `false` (fail
	// closed), not `true`: this flag exists specifically to gate an unsafe
	// fallback, so an invoker that forgets to set it explicitly should hit
	// outlineNode's throw rather than silently trusting an unverified title.
	titleWasTyped: Annotation<boolean>({ reducer: overwrite, default: () => false }),
	force: Annotation<boolean>({ reducer: overwrite, default: () => false }),
	slug: Annotation<string>({ reducer: overwrite, default: () => '' }),
	originalBranch: Annotation<string>({ reducer: overwrite, default: () => '' }),
	author: Annotation<string | undefined>(),
	year: Annotation<number | undefined>(),
	// From --isbn and/or --known (see scripts/lib/known-facts.ts, merged in
	// main()): ground truth the reader already has for this exact edition,
	// so outlineNode can treat it as fixed instead of re-deriving it from
	// search. `chapters` is the strongest of these — when given, it skips
	// outline search and consensus entirely (see outlineNode); the other
	// fields just get threaded into the outline prompts as confirmed facts
	// when search still runs.
	knownFacts: Annotation<KnownFacts | undefined>(),
	// From --trust-known. Skips verifyKnownFactsNode's search+critique of
	// `knownFacts.chapters` entirely — for a file you've already verified
	// yourself and want to stop re-litigating, e.g. after a prior run's
	// critique flagged a false positive (thin/wrong search grounding, not an
	// actual mistake in the file).
	trustKnown: Annotation<boolean>({ reducer: overwrite, default: () => false }),
	// Resolved once in verifyKnownFactsNode (which runs for every --known
	// run, right after setup) whenever `knownFacts.isbn` is given, so
	// outlineNode can reuse it instead of looking the same isbn up a second
	// time. Also lets verification search against the isbn-resolved edition
	// title rather than the reader's own (possibly generic/ambiguous) CLI
	// title when `knownFacts.title` itself wasn't given.
	editionMeta: Annotation<Awaited<ReturnType<typeof lookupEditionByIsbn>> | undefined>(),
	// A live Promise, not a resolved value — kicked off in outlineNode but
	// deliberately not awaited there, so its network round-trip overlaps
	// with the (much longer) parallel chapter fan-out instead of serializing
	// in front of it. Only awaited where isbn/pageCount are actually
	// consumed (validateNode). Fine to hold a raw Promise in state since
	// checkpointing isn't used in v1 — nothing ever needs to serialize this.
	isbnPromise: Annotation<Promise<{ isbn?: string; pageCount?: number } | undefined> | undefined>(),
	// Same overlap-with-chapter-fan-out treatment as isbnPromise, kicked off
	// alongside it in outlineNode — but awaited in synthesisNode instead of
	// validateNode, since (unlike isbn/pageCount) this needs to be in hand
	// before the tag-choosing prompt is built, not just before final assembly.
	subjectsPromise: Annotation<Promise<string[] | undefined> | undefined>(),
	// Raw text from --notes, if given. A steering signal for the Synthesis
	// stage only — never persisted to the book JSON and never quoted
	// verbatim in output (the reader's own notes may be messy fragments,
	// not publishable prose). See buildSynthesisPrompt.
	personalNotes: Annotation<string | undefined>(),
	chapterTitles: Annotation<string[]>({ reducer: overwrite, default: () => [] }),
	chapterIndex: Annotation<number>({ reducer: overwrite, default: () => 0 }),
	totalChapters: Annotation<number>({ reducer: overwrite, default: () => 0 }),
	chapters: Annotation<Chapter[]>({
		default: () => [],
		reducer: (existing, update) => existing.concat(update),
	}),
	synthesis: Annotation<Synthesis | undefined>(),
	book: Annotation<Book | undefined>(),
	validationErrors: Annotation<string[]>({ reducer: overwrite, default: () => [] }),
	retryCount: Annotation<number>({ reducer: overwrite, default: () => 0 }),
});

type State = typeof BookGenState.State;

// Structural interfaces (not the full `State`) for the handful of nodes
// shared between this graph and the fiction graph below — setup/publish/
// emit/fail don't touch anything kind-specific, so both graphs' states
// satisfy these directly rather than needing two near-identical copies.
interface SetupState {
	title: string;
	force: boolean;
}
interface PublishableState {
	book: Book | undefined;
	slug: string;
	originalBranch: string;
	title: string;
}
interface FailableState {
	retryCount: number;
	validationErrors: string[];
}

// ---------------------------------------------------------------------------
// Stage 0 — Setup
// ---------------------------------------------------------------------------
async function setupNode(state: SetupState): Promise<{ slug: string; originalBranch: string }> {
	const slug = slugify(state.title);
	if (!slug) {
		throw new Error(
			`Could not derive a URL-safe slug from title "${state.title}" (it has no ASCII letters/digits after ` +
				'stripping diacritics). Rename it to include some, or pick a different working title.',
		);
	}

	// In --emit-json mode this may run inside the sandboxed container, which
	// has no .git at all — publishability (existing file/branch, clean tree)
	// is entirely the host-side publish-book.ts's concern there, and
	// generate-sandboxed.sh already runs that check before starting the
	// container. But --emit-json also works for direct, un-sandboxed use
	// (see the flag's definition above), and there a .git is available with
	// no other pre-check guaranteed to have run — so still check there,
	// rather than letting a duplicate title only surface after a full paid
	// LLM+search generation completes.
	if (emitJsonPath && !isGitRepo()) {
		log(`Generating "${state.title}" -> slug "${slug}" (sandboxed: emitting JSON, no git operations)`);
		return { slug, originalBranch: '' };
	}

	checkPublishable(slug, state.force);

	log(`Generating "${state.title}" -> slug "${slug}"${emitJsonPath ? ' (emitting JSON, no git commit)' : ''}`);
	return { slug, originalBranch: emitJsonPath ? '' : currentBranch() };
}

// ---------------------------------------------------------------------------
// Stage 1 — Outline
// ---------------------------------------------------------------------------
// Three independently-sourced candidates run concurrently — not a dynamic
// fan-out (always exactly 3, known upfront), so plain Promise.allSettled
// here rather than modeling them as separate LangGraph Send-dispatched
// nodes, which earns its keep for genuinely dynamic work like the chapter
// fan-out below, not a fixed-arity concurrent step. allSettled (not
// Promise.all) so one strategy's failure doesn't discard the other two
// already-successful candidates — proceeds on any 1+ successes, only
// throwing if all three failed.
async function generateOutlineCandidates(
	searchTitle: string,
	knownFacts?: { author?: string; year?: number },
): Promise<OutlineCandidate[]> {
	const settled = await Promise.allSettled(
		OUTLINE_SEARCH_STRATEGIES.map(async (strategy): Promise<OutlineCandidate> => {
			const results = await searchProvider.search(
				`"${searchTitle}" chapter list table of contents`,
				strategy.maxResults,
				{ excludeDomains: strategy.excludeDomains, includeDomains: strategy.includeDomains },
			);
			const outline = await model
				.withStructuredOutput(outlineSchema)
				.invoke(buildOutlinePrompt(searchTitle, results, knownFacts));
			return { label: strategy.label, outline, results };
		}),
	);

	const candidates = settled.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
	if (candidates.length === 0) {
		const reasons = settled
			.map((r, i) => {
				if (r.status !== 'rejected') return null;
				const message = r.reason instanceof Error ? r.reason.message : String(r.reason);
				return `${OUTLINE_SEARCH_STRATEGIES[i].label}: ${message}`;
			})
			.filter((r): r is string => r !== null);
		throw new Error(`All ${OUTLINE_SEARCH_STRATEGIES.length} outline search strategies failed:\n${reasons.join('\n')}`);
	}
	if (candidates.length < OUTLINE_SEARCH_STRATEGIES.length) {
		log(
			`  outline: ${OUTLINE_SEARCH_STRATEGIES.length - candidates.length}/${OUTLINE_SEARCH_STRATEGIES.length} ` +
				`candidate search(es) failed — proceeding with ${candidates.length}.`,
		);
	}
	return candidates;
}

// Shared by verifyKnownFactsNode and outlineNode: a known `title` beats an
// isbn-resolved edition title, which beats the reader's own CLI-typed title.
// Treats an empty string as "not given" (not just `undefined`) — knownFacts
// schema doesn't reject `""`, and falling through here matters for both
// callers, not just one of them.
function resolveKnownSearchTitle(
	known: KnownFacts | undefined,
	editionMeta: Awaited<ReturnType<typeof lookupEditionByIsbn>>,
	fallbackTitle: string,
): string {
	return known?.title || editionMeta?.title || fallbackTitle;
}

// ---------------------------------------------------------------------------
// Stage 0.5 — Known-edition resolution + chapter-list verification
// ---------------------------------------------------------------------------
// Runs for every --known run, right after setup. Always resolves
// `knownFacts.isbn` (if given) to editionMeta up front — shared with
// outlineNode below so the isbn is only ever looked up once, and so the
// verification search below can target the isbn-resolved edition title
// rather than a possibly generic/ambiguous CLI title. The verification
// search+critique itself only runs when --known's `chapters` is given — the
// one --known field with zero other check (outlineNode trusts it outright
// and skips outline search/consensus entirely for it). See
// buildKnownFactsCritiquePrompt for why the critique is narrow — a
// hand-typed file deserves a typo/wrong-edition check, not a re-litigation
// of whether the reader knows their own book. A confirmed mistake throws
// (caught by main()'s catch, printed, process exits) rather than blocking
// silently or auto-fixing; a verification call that itself fails (network/API
// hiccup) degrades to "proceeding on trust" rather than aborting the run —
// this check is a safety net, not a new hard dependency.
async function verifyKnownFactsNode(state: State): Promise<Partial<State>> {
	const known = state.knownFacts;
	const editionMeta = known?.isbn ? await lookupEditionByIsbn(known.isbn) : undefined;

	if (!known?.chapters?.length || state.trustKnown) return { editionMeta };

	const searchTitle = resolveKnownSearchTitle(known, editionMeta, state.title);
	log(`Verifying known chapter list for "${searchTitle}" against a quick search...`);

	let critique: Critique;
	try {
		const results = await searchProvider.search(`"${searchTitle}" chapter list table of contents`, 5, {
			excludeDomains: CHAPTER_LIST_SEARCH_EXCLUDE_DOMAINS,
		});
		critique = await model.withStructuredOutput(critiqueSchema).invoke(buildKnownFactsCritiquePrompt(known, results));
	} catch (err) {
		// Deliberately fails open, not closed: this check exists to catch a
		// *reader's* mistake in the known file, not to become a new hard
		// dependency for a --known run that would otherwise need no search
		// at all. logError (not log) so it's visible on stderr even when
		// stdout is redirected/scrolled past — a silently-broken safety net
		// (e.g. a real prompt/schema bug, not just a network blip) is exactly
		// the failure mode most likely to go unnoticed otherwise.
		logError(
			`  known-facts verification could not complete (${err instanceof Error ? err.message : err}) — ` +
				'proceeding WITHOUT this check.',
		);
		return { editionMeta };
	}

	if (!critique.plausible) {
		const concerns = critique.concerns.length > 0 ? critique.concerns.map((c) => `  - ${c}`).join('\n') : '  (no specifics given)';
		throw new Error(
			`--known file looks inconsistent with what search found for "${searchTitle}":\n${concerns}` +
				'\n\nIf you\'ve reviewed this and the known file is actually correct (search grounding ' +
				'can be thin or wrong), re-run with --trust-known to skip this check.',
		);
	}

	log('Known chapter list looks consistent with search — proceeding.');
	return { editionMeta };
}

// Bounded to one retry, and only on a genuine "split" verdict — a "majority"
// result already reflects reasonable confidence, not worth spending another
// full round of searches on. A fresh round (new searches, not re-judging
// the same evidence) gives the retry an actual chance at a different
// outcome, rather than asking the same judge to re-decide from nothing new.
const MAX_OUTLINE_SPLIT_RETRIES = 1;

async function outlineNode(state: State): Promise<Partial<State>> {
	const known = state.knownFacts;
	// Resolved once in verifyKnownFactsNode, which runs immediately before
	// this node for every --known run — reused here rather than looking the
	// same isbn up a second time.
	const editionMeta = state.editionMeta;

	// A known isbn pins the search to this exact edition's own published
	// title (e.g. avoiding ambiguity between translations/editions) rather
	// than however the reader phrased the CLI title. Its author/year — a
	// direct lookup — also override the model's own guess below, once
	// drafted. A known `title` (a reader-confirmed fact, not just a lookup
	// match) wins over both. Never throws; a lookup miss just means no
	// accuracy boost, not a failure.
	const searchTitle = resolveKnownSearchTitle(known, editionMeta, state.title);

	let title: string;
	let author: string | undefined;
	let year: number | undefined;
	let chapterTitles: string[];

	// A known chapter list is the reader directly asserting the real,
	// ordered table of contents as fact — trusted outright, skipping outline
	// search and consensus entirely. Re-deriving it from search afterward
	// would only risk *introducing* doubt into something already certain,
	// not removing it. title/author/year are similarly locked wherever
	// known.
	if (known?.chapters && known.chapters.length > 0) {
		// No model call happens on this branch to produce a real title from
		// search — unlike the else branch below, there's nothing to catch a
		// bad title here. So `title` may ONLY come from a real source: the
		// known file's own `title`, an isbn-resolved edition title, or a
		// title the reader actually typed. `state.title` alone is NOT
		// enough — when no title was typed, it's just --known's basename
		// (see parseArgs), which must never get published as if it were
		// the book's real title.
		// `||`, not `??` — matches resolveKnownSearchTitle's own convention
		// (see its comment above): knownFacts.title isn't rejected as `""` by
		// the schema, and an empty string must fall through here exactly like
		// `undefined` would, e.g. so a resolvable isbn edition title further
		// down the chain still gets used.
		const resolvedTitle: string | undefined =
			known?.title || editionMeta?.title || (state.titleWasTyped ? state.title : undefined);
		if (!resolvedTitle) {
			throw new Error(
				`--known file has "chapters" but no "title", and no title was given on the command line ` +
					'(or resolvable via "isbn"). Add "title" to the known file, or pass one explicitly.',
			);
		}
		title = resolvedTitle;
		author = known?.author ?? editionMeta?.author;
		year = known?.year ?? editionMeta?.year;
		chapterTitles = known.chapters;

		log(
			`Using ${chapterTitles.length} known chapters for "${title}"` +
				`${author ? ` by ${author}` : ''}${year ? ` (${year})` : ''} — skipping outline search.`,
		);
	} else {
		// Whatever *was* known (author/year/title, just not the chapter
		// list) still gets threaded into the prompts below as confirmed
		// fact, so the model only has to work out what's actually missing
		// instead of re-guessing something already certain.
		const knownForPrompt = { title: known?.title, author: known?.author, year: known?.year };

		// Attempt 1 runs unconditionally before the retry loop, so
		// `consensus` always holds a real value below — never `undefined`,
		// so no non-null assertions needed at any use site.
		log('Searching for outline (3 independent searches + a consensus pass)...');
		const firstCandidates = await generateOutlineCandidates(searchTitle, knownForPrompt);
		let consensus = await model
			.withStructuredOutput(outlineConsensusSchema)
			.invoke(buildOutlineConsensusPrompt(searchTitle, firstCandidates, knownForPrompt));

		for (let attempt = 2; consensus.agreement === 'split' && attempt <= MAX_OUTLINE_SPLIT_RETRIES + 1; attempt++) {
			log(
				`  outline: split agreement (${consensus.notes ?? 'no reasoning given'}) — retrying with fresh searches.`,
			);
			const candidates = await generateOutlineCandidates(searchTitle, knownForPrompt);
			consensus = await model
				.withStructuredOutput(outlineConsensusSchema)
				.invoke(buildOutlineConsensusPrompt(searchTitle, candidates, knownForPrompt));
		}

		// A known fact beats a direct ISBN lookup, which beats the model's
		// own guess.
		title = known?.title ?? consensus.title;
		author = known?.author ?? editionMeta?.author ?? consensus.author;
		year = known?.year ?? editionMeta?.year ?? consensus.year;
		chapterTitles = consensus.chapter_titles;

		log(
			`Found ${chapterTitles.length} chapters for "${title}"` +
				`${author ? ` by ${author}` : ''}${year ? ` (${year})` : ''}` +
				(consensus.agreement === 'unanimous'
					? ''
					: ` (${consensus.agreement} agreement among candidates — ${consensus.notes ?? 'no reasoning given'})`),
		);
	}

	// Resolved via a direct Open Library API lookup, not the model — see
	// scripts/lib/openlibrary.ts. Deliberately NOT awaited here: isbn/
	// pageCount aren't consumed until validateNode (Stage 4), so kicking
	// this off without blocking lets its round-trip overlap with the
	// parallel chapter fan-out instead of serializing in front of it. Never
	// throws; `undefined` fields just mean no cover image/page count,
	// handled gracefully downstream. A known `page_count` is applied
	// wherever an isbn ends up resolved (given or looked-up) *and* kept even
	// when no isbn is found at all — it's a fact the reader supplied
	// directly, not something contingent on the lookup succeeding.
	const isbnPromise = known?.isbn
		? Promise.resolve({ isbn: known.isbn, pageCount: known?.page_count ?? editionMeta?.pageCount })
		: lookupIsbn(title, author).then(async (isbn) => {
				if (!isbn) return known?.page_count !== undefined ? { isbn: undefined, pageCount: known.page_count } : undefined;
				const meta = await lookupEditionByIsbn(isbn);
				return { isbn, pageCount: known?.page_count ?? meta?.pageCount };
			});

	// Fired the same way as isbnPromise above (not awaited here) — its
	// round-trip overlaps with the chapter fan-out, and is only awaited once
	// synthesisNode actually needs it for the tags prompt.
	const subjectsPromise = lookupSubjects(title, author);

	return {
		title,
		author,
		year,
		isbnPromise,
		subjectsPromise,
		chapterTitles,
		totalChapters: chapterTitles.length,
	};
}

function dispatchChapters(state: State): Send[] {
	return state.chapterTitles.map(
		(chapterTitle, index) =>
			new Send('chapterDetail', {
				title: state.title,
				author: state.author,
				year: state.year,
				chapterTitles: [chapterTitle],
				chapterIndex: index,
				totalChapters: state.totalChapters,
			}),
	);
}

// ---------------------------------------------------------------------------
// Stage 2 — Per-chapter drafting (parallel, concurrency-capped, Send-dispatched)
// ---------------------------------------------------------------------------
async function chapterDetailNode(state: State): Promise<Partial<State>> {
	const chapterTitle = state.chapterTitles[0];
	const chapterIndex = state.chapterIndex;

	return chapterLimit(async () => {
		const results = await searchProvider.search(`"${state.title}" "${chapterTitle}" summary`, 5);
		const basePrompt = buildChapterPrompt(state.title, chapterTitle, results);

		let lastError = '';
		let lastAttempt: unknown = { chapterTitle }; // only used as repair-prompt context before a first real draft exists
		// Schema-valid candidates are kept even when critique-flagged: a
		// critique failure is a quality signal, not proof the content is
		// unusable, unlike a schema-validation failure. Falling back to the
		// last schema-valid draft once retries are exhausted means a
		// spuriously repeated critique flag degrades one chapter's quality
		// instead of throwing and discarding the whole book generation
		// (including every other chapter already completed).
		let lastValidCandidate: Chapter | undefined;
		let lastValidConcerns: string[] = [];
		for (let attempt = 0; attempt <= MAX_CHAPTER_LOCAL_RETRIES; attempt++) {
			const prompt = attempt === 0 ? basePrompt : buildRepairPrompt(lastAttempt, [lastError]);
			try {
				const draft = await model.withStructuredOutput(chapterContentSchema).invoke(prompt);
				const candidate = { number: chapterIndex + 1, title: chapterTitle, ...draft };
				lastAttempt = candidate;
				const parsed = chapterSchema.safeParse(candidate);
				if (!parsed.success) {
					lastError = parsed.error.issues.map(formatIssue).join('; ');
					continue;
				}

				// A second, independent model call judging the draft before it's
				// accepted — see critiqueSchema's comment above.
				const critique = await model
					.withStructuredOutput(critiqueSchema)
					.invoke(buildChapterCritiquePrompt(state.title, chapterTitle, parsed.data, results));
				lastValidCandidate = parsed.data;
				if (!critique.plausible) {
					lastError = `Content review: ${critique.concerns.join('; ')}`;
					lastValidConcerns = critique.concerns;
					continue;
				}

				log(`  chapter ${chapterIndex + 1}/${state.totalChapters} drafted: "${chapterTitle}"`);
				return { chapters: [parsed.data] };
			} catch (err) {
				lastError = err instanceof Error ? err.message : String(err);
			}
		}

		if (lastValidCandidate) {
			log(
				`  chapter ${chapterIndex + 1}/${state.totalChapters} drafted: "${chapterTitle}" ` +
					`(unresolved review concerns — worth a manual check: ${lastValidConcerns.join('; ')})`,
			);
			return { chapters: [lastValidCandidate] };
		}

		throw new Error(
			`Chapter "${chapterTitle}" failed validation after ${MAX_CHAPTER_LOCAL_RETRIES + 1} attempts: ${lastError}`,
		);
	});
}

// ---------------------------------------------------------------------------
// Stage 3 — Synthesis
// ---------------------------------------------------------------------------
async function synthesisNode(state: State): Promise<Partial<State>> {
	const chaptersSummary = [...state.chapters]
		.sort((a, b) => a.number - b.number)
		.map(
			(c) =>
				`Chapter ${c.number}: ${c.title}\nCore claim: ${c.core_claim}\nKey points:\n${c.key_points
					.map((p) => `- ${p}`)
					.join('\n')}`,
		)
		.join('\n\n');

	const results = await searchProvider.search(`"${state.title}" ${state.author ?? ''} themes summary`.trim(), 3);
	const subjects = await state.subjectsPromise;
	const prompt = buildSynthesisPrompt(state.title, state.author, chaptersSummary, results, state.personalNotes, subjects);
	const synthesis = await model.withStructuredOutput(synthesisSchema).invoke(prompt);

	log('Synthesis complete.');
	return { synthesis };
}

// ---------------------------------------------------------------------------
// Stage 4 — Assembly & validation
// ---------------------------------------------------------------------------
async function validateNode(state: State): Promise<Partial<State>> {
	// Chapters accumulate in whatever order concurrent fan-out invocations
	// happen to resolve in, not reading order — re-sort by `number` before
	// this becomes the persisted array (synthesisNode sorts its own copy for
	// prompting, but that sort was never fed back into shared state).
	const sortedChapters = [...state.chapters].sort((a, b) => a.number - b.number);

	// Kicked off (not awaited) back in outlineNode, so its round-trip has
	// been overlapping with the chapter fan-out + synthesis this whole
	// time — awaiting it here is normally instant, not a fresh wait.
	const isbnResult = await state.isbnPromise;
	const isbn = isbnResult?.isbn;
	const pageCount = isbnResult?.pageCount;
	log(
		isbn
			? `Found ISBN ${isbn}${pageCount ? `, ${pageCount} pages` : ''} (cover image available).`
			: 'No ISBN found — book will render without a cover.',
	);

	const candidate = {
		kind: 'non-fiction' as const,
		title: state.title,
		author: state.author,
		year: state.year,
		isbn,
		page_count: pageCount,
		tags: state.synthesis?.tags ?? [],
		date_added: new Date().toISOString().slice(0, 10),
		// Always starts false — flipped to true by hand once you've read over
		// the generated content and trust it (see Part 5's review workflow).
		verified: false,
		one_line_takeaway: state.synthesis?.one_line_takeaway ?? '',
		synopsis: state.synthesis?.synopsis ?? '',
		chapters: sortedChapters,
		key_claims_for_review: state.synthesis?.key_claims_for_review ?? [],
	};

	const parsed = bookSchema.safeParse(candidate);
	if (parsed.success) {
		log('Validated against the books content schema.');
		return { validationErrors: [], book: parsed.data };
	}

	const errors = parsed.error.issues.map(formatIssue);
	log(`Validation failed (attempt ${state.retryCount + 1}): ${errors.join('; ')}`);
	return { validationErrors: errors };
}

async function repairNode(state: State): Promise<Partial<State>> {
	// Bound to repairableSchema (every top-level field except `chapters`,
	// `date_added`, `isbn`, and `page_count`) rather than just
	// synthesisSchema — validateNode's `bookSchema` check covers
	// title/author/year too (e.g. an outline that came back with no
	// determinable author), and a synthesis-only repair could never fix a
	// failure in one of those fields, burning all retries on an unfixable
	// error. `isbn`/`page_count` are deliberately left untouched here — they
	// came from a direct API lookup, not the model, so they stay whatever
	// outlineNode resolved (possibly undefined) regardless of what else
	// needed repairing.
	//
	// The explicit `: Partial<Repairable>` annotation on `candidate` is
	// deliberate, not decorative: it's what makes `repairableSchema` and
	// this object literal one structural checkpoint instead of two
	// independently-drifting field lists — if a field is ever added to or
	// removed from `repairableSchema` (via bookSchema changing), this
	// literal fails to compile until it's updated to match, rather than
	// silently under/over-supplying the repair prompt. `Partial` (rather
	// than `Repairable` itself) because this snapshot represents the
	// *currently broken* state being repaired — e.g. `author` can
	// legitimately be missing here, which is exactly the case this repair
	// path exists to fix, even though a valid `Repairable` requires it.
	const candidate: Partial<Repairable> = {
		title: state.title,
		author: state.author,
		year: state.year,
		tags: state.synthesis?.tags ?? [],
		one_line_takeaway: state.synthesis?.one_line_takeaway ?? '',
		synopsis: state.synthesis?.synopsis ?? '',
		key_claims_for_review: state.synthesis?.key_claims_for_review ?? [],
	};
	const repaired = await model
		.withStructuredOutput(repairableSchema)
		.invoke(buildRepairPrompt(candidate, state.validationErrors));

	// Only title/author/year are named explicitly (they live at the top
	// level of state); everything else rest-spreads straight into
	// `synthesis` so a future repairable field added to bookSchema flows
	// through automatically instead of needing a matching edit here.
	const { title, author, year, ...synthesisFields } = repaired;

	return {
		title,
		author,
		year,
		synthesis: synthesisFields,
		retryCount: state.retryCount + 1,
	};
}

function failNode(state: FailableState): never {
	throw new Error(
		`Generation failed validation after ${state.retryCount} repair attempt(s):\n${state.validationErrors.join('\n')}`,
	);
}

// ---------------------------------------------------------------------------
// Stage 5 — Publish to a draft branch (commit only — no push, see Part 5)
// ---------------------------------------------------------------------------
async function publishNode(state: PublishableState): Promise<Record<string, never>> {
	publishBook(state.book!, state.slug, state.originalBranch, state.title);
	return {};
}

// ---------------------------------------------------------------------------
// Stage 5 (alternate) — Emit JSON instead of publishing (sandboxed path)
// ---------------------------------------------------------------------------
// Used in place of publishNode when --emit-json is passed: writes the
// validated book straight to a file (consumed by the host-only
// scripts/publish-book.ts, which does the actual git branch/commit) instead
// of touching git — this is what runs inside the Docker sandbox, which has
// no repo access at all. See docs/blueprint/05-operations-and-future.md.
async function emitNode(state: PublishableState): Promise<Record<string, never>> {
	const json = `${JSON.stringify(state.book, null, 2)}\n`;
	fs.writeFileSync(emitJsonPath!, json);
	log(`\nWrote validated book JSON to ${emitJsonPath}.`);
	log('Run scripts/publish-book.ts on the host to commit it.');
	return {};
}

// ---------------------------------------------------------------------------
// Fiction pipeline — deliberately a separate, much shorter graph rather than
// a `kind` branch threaded through the non-fiction graph above: no chapter
// list, no per-chapter fan-out/critique, no synthesis-from-chapters step, no
// flashcard deck — just search, one drafting call, an Open Library lookup,
// and validate/repair/publish (shared with the non-fiction graph above,
// since none of those three care about `kind`). See fictionBookSchema in
// src/content/schema.ts for what a cataloged fiction entry actually needs.
// ---------------------------------------------------------------------------
const FictionBookGenState = Annotation.Root({
	title: Annotation<string>(),
	force: Annotation<boolean>({ reducer: overwrite, default: () => false }),
	slug: Annotation<string>({ reducer: overwrite, default: () => '' }),
	originalBranch: Annotation<string>({ reducer: overwrite, default: () => '' }),
	knownFacts: Annotation<KnownFacts | undefined>(),
	personalNotes: Annotation<string | undefined>(),
	// The one in-flight draft, replaced wholesale on repair — unlike the
	// non-fiction graph there's no separate "chapters" accumulator or
	// "synthesis" field to keep distinct from title/author/year, since one
	// call produces all of it together (see fictionRepairableSchema).
	draft: Annotation<FictionRepairable | undefined>(),
	// Resolved once in fictionDraftNode (not re-fetched on every repair-loop
	// re-entry into validate — repair only replaces `draft`, never re-runs
	// this node) — a repeat lookup on each retry would be wasted network
	// round-trips, and if Open Library's own ranking is non-deterministic
	// across calls, could even resolve to a different edition than the first
	// attempt did.
	isbn: Annotation<string | undefined>(),
	pageCount: Annotation<number | undefined>(),
	book: Annotation<Book | undefined>(),
	validationErrors: Annotation<string[]>({ reducer: overwrite, default: () => [] }),
	retryCount: Annotation<number>({ reducer: overwrite, default: () => 0 }),
});

type FictionState = typeof FictionBookGenState.State;

async function fictionDraftNode(state: FictionState): Promise<Partial<FictionState>> {
	const known = state.knownFacts;
	const searchTitle = known?.title || state.title;

	// Run concurrently, not sequentially — neither depends on the other's
	// result, and both need to be in hand before the prompt below is built
	// (unlike the non-fiction graph's isbnPromise/subjectsPromise, which
	// overlap with a much longer parallel chapter-fan-out stage, this
	// pipeline has no such stage to hide a sequential wait behind, so the
	// two round-trips need to overlap with *each other* instead).
	const [results, subjects] = await Promise.all([
		searchProvider.search(`"${searchTitle}" ${known?.author ?? ''} plot summary themes`.trim(), 5),
		lookupSubjects(searchTitle, known?.author),
	]);
	const prompt = buildFictionSummaryPrompt(searchTitle, results, known, state.personalNotes, subjects);
	const draft = await model.withStructuredOutput(fictionRepairableSchema).invoke(prompt);

	log(`Drafted summary for "${draft.title}"${draft.author ? ` by ${draft.author}` : ''}.`);

	// Resolved once here, not in validateNode — validateNode re-runs on every
	// repair-loop retry (repair only replaces `draft`), so resolving there
	// would mean a wasted extra network round-trip per retry, and no
	// guarantee the same isbn/pageCount even comes back twice in a row.
	// Known facts beat the model's own draft, same precedence as the
	// non-fiction graph's `known?.title ?? consensus.title`.
	const title = known?.title ?? draft.title;
	const author = known?.author ?? draft.author;
	const isbn = known?.isbn ?? (await lookupIsbn(title, author));
	const pageCount = known?.page_count ?? (isbn ? (await lookupEditionByIsbn(isbn))?.pageCount : undefined);
	log(
		isbn
			? `Found ISBN ${isbn}${pageCount ? `, ${pageCount} pages` : ''} (cover image available).`
			: 'No ISBN found — book will render without a cover.',
	);

	// `title` must be written back into state, not just used locally — the
	// non-fiction graph's outlineNode does the same (`return { title, ... }`)
	// specifically so publishNode's commit message uses the real resolved
	// title instead of whatever placeholder seeded `state.title` at setup
	// (the CLI-typed title, or the --known file's basename fallback).
	return { draft, title, isbn, pageCount };
}

async function fictionValidateNode(state: FictionState): Promise<Partial<FictionState>> {
	const known = state.knownFacts;
	const draft = state.draft!;
	const title = known?.title ?? draft.title;
	const author = known?.author ?? draft.author;
	const year = known?.year ?? draft.year;

	const candidate = {
		kind: 'fiction' as const,
		title,
		author,
		year,
		isbn: state.isbn,
		page_count: state.pageCount,
		tags: draft.tags,
		date_added: new Date().toISOString().slice(0, 10),
		verified: false,
		one_line_takeaway: draft.one_line_takeaway,
		synopsis: draft.synopsis,
	};

	const parsed = fictionBookSchema.safeParse(candidate);
	if (parsed.success) {
		log('Validated against the books content schema.');
		return { validationErrors: [], book: parsed.data };
	}

	const errors = parsed.error.issues.map(formatIssue);
	log(`Validation failed (attempt ${state.retryCount + 1}): ${errors.join('; ')}`);
	return { validationErrors: errors };
}

async function fictionRepairNode(state: FictionState): Promise<Partial<FictionState>> {
	const repaired = await model
		.withStructuredOutput(fictionRepairableSchema)
		.invoke(buildRepairPrompt(state.draft, state.validationErrors));
	return { draft: repaired, retryCount: state.retryCount + 1 };
}

// Shared by both graphs' post-`validate` conditional edge — identical retry
// policy either way (emit/publish once clean, repair up to the cap, then
// fail), so a future policy change (e.g. a different retry cap) only needs
// to happen once instead of being kept in sync by hand in two places.
const VALIDATE_OUTCOME_EDGES = { publish: 'publish', emit: 'emit', repair: 'repair', fail: 'fail' } as const;
function decideAfterValidate(state: FailableState): keyof typeof VALIDATE_OUTCOME_EDGES {
	if (state.validationErrors.length === 0) return emitJsonPath ? 'emit' : 'publish';
	return state.retryCount < MAX_TOP_LEVEL_RETRIES ? 'repair' : 'fail';
}

const fictionGraph = new StateGraph(FictionBookGenState)
	.addNode('setup', setupNode)
	.addNode('draftSummary', fictionDraftNode)
	.addNode('validate', fictionValidateNode)
	.addNode('repair', fictionRepairNode)
	.addNode('fail', failNode)
	.addNode('publish', publishNode)
	.addNode('emit', emitNode)
	.addEdge(START, 'setup')
	.addEdge('setup', 'draftSummary')
	.addEdge('draftSummary', 'validate')
	.addConditionalEdges('validate', decideAfterValidate, VALIDATE_OUTCOME_EDGES)
	.addEdge('repair', 'validate')
	.addEdge('fail', END)
	.addEdge('publish', END)
	.addEdge('emit', END);

const fictionApp = fictionGraph.compile();

// ---------------------------------------------------------------------------
// Graph wiring
// ---------------------------------------------------------------------------
const graph = new StateGraph(BookGenState)
	.addNode('setup', setupNode)
	.addNode('verifyKnown', verifyKnownFactsNode)
	.addNode('outline', outlineNode)
	.addNode('chapterDetail', chapterDetailNode)
	.addNode('synthesize', synthesisNode)
	.addNode('validate', validateNode)
	.addNode('repair', repairNode)
	.addNode('fail', failNode)
	.addNode('publish', publishNode)
	.addNode('emit', emitNode)
	.addEdge(START, 'setup')
	.addEdge('setup', 'verifyKnown')
	.addEdge('verifyKnown', 'outline')
	.addConditionalEdges('outline', dispatchChapters)
	.addEdge('chapterDetail', 'synthesize')
	.addEdge('synthesize', 'validate')
	.addConditionalEdges('validate', decideAfterValidate, VALIDATE_OUTCOME_EDGES)
	.addEdge('repair', 'validate')
	.addEdge('fail', END)
	.addEdge('publish', END)
	.addEdge('emit', END);

const app = graph.compile();

// ---------------------------------------------------------------------------
// CLI entrypoint
// ---------------------------------------------------------------------------
const USAGE =
	'Usage: pnpm run generate -- ["Book Title"] [--force] [--fiction] [--notes <path>] [--emit-json <path>] ' +
	'[--isbn <isbn>] [--known <path>] [--trust-known]\n' +
	'("Book Title" may be omitted when --known is given — it falls back to the known file\'s own name.)\n' +
	'(--fiction runs the shorter fiction pipeline — no chapters, no flashcard review, just details + summary. ' +
	'A --known file\'s own "kind" field decides this instead, if given.)';

// Guards every value-taking flag below against silently swallowing the
// *next* flag as its own value when the actual value was left off (e.g.
// `--known --trust-known` with the path omitted) — without this, `--known`
// would hand `loadKnownFacts` the literal string "--trust-known" as a path
// and fail with a confusing ENOENT instead of a clear message, while
// --trust-known itself silently never gets applied.
function readFlagValue(args: string[], index: number, flag: string): string {
	const value = args[index + 1];
	if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value.`);
	return value;
}

// Case-insensitive .json suffix strip for the --known basename fallback
// below — `path.basename(p, '.json')` only strips an exact-case match, so a
// `.JSON`-cased file would otherwise leave the extension stuck onto the
// derived title/slug. A plain regex, not `path.extname` + `path.basename`:
// `path.extname('.json')` returns `''` (Node treats a leading-dot-only name
// as extension-less, confirmed directly), which would leave a --known path
// that's literally named ".json" unstripped instead of correctly reducing
// to "" (matching the empty-title error path below). Mirrored in
// scripts/generate-sandboxed.sh's own basename fallback (bash has no
// case-insensitive `basename` built in) — keep both in sync if this rule
// ever changes.
function stripJsonExtension(filePath: string): string {
	const base = path.basename(filePath);
	return /\.json$/i.test(base) ? base.slice(0, -'.json'.length) : base;
}

// Pulls --notes/--known/--emit-json <path> and --isbn <isbn> (value-taking
// flags) out before the remaining args are joined back into the title, and
// reads the notes/known-facts files eagerly so a bad path fails fast rather
// than partway through the pipeline.
function parseArgs(
	argv: string[],
): {
	title: string;
	titleWasTyped: boolean;
	force: boolean;
	fiction: boolean;
	personalNotes?: string;
	emitJsonPath?: string;
	isbn?: string;
	known?: KnownFacts;
	trustKnown: boolean;
} {
	// `pnpm run generate -- "Title"` forwards a literal `--` through to this
	// script instead of stripping it (confirmed on pnpm 12.x) — dropped here
	// so it doesn't end up folded into the title below.
	const args = argv.filter((a) => a !== '--');
	const force = args.includes('--force');
	const fiction = args.includes('--fiction');
	const trustKnown = args.includes('--trust-known');
	// Internal flag, set only by scripts/generate-sandboxed.sh — never
	// documented for a human to type. That wrapper has to resolve the
	// --known basename fallback itself (it needs a concrete title before it
	// ever invokes this script, for its own host-side pre-flight check), so
	// by the time this process sees the positional title it's always
	// "typed" from this script's own point of view — this flag is how the
	// wrapper tells it "no, that title is actually my own fallback," so
	// `titleWasTyped` ends up correct across that process boundary too, not
	// just for a direct, non-sandboxed invocation.
	const titleNotTyped = args.includes('--title-not-typed');

	const notesIndex = args.indexOf('--notes');
	let personalNotes: string | undefined;
	if (notesIndex !== -1) {
		const notesPath = readFlagValue(args, notesIndex, '--notes');
		personalNotes = fs.readFileSync(notesPath, 'utf-8');
		args.splice(notesIndex, 2);
	}

	const emitJsonIndex = args.indexOf('--emit-json');
	let emitJsonPath: string | undefined;
	if (emitJsonIndex !== -1) {
		emitJsonPath = readFlagValue(args, emitJsonIndex, '--emit-json');
		args.splice(emitJsonIndex, 2);
	}

	const isbnIndex = args.indexOf('--isbn');
	let isbn: string | undefined;
	if (isbnIndex !== -1) {
		isbn = readFlagValue(args, isbnIndex, '--isbn');
		args.splice(isbnIndex, 2);
	}

	const knownIndex = args.indexOf('--known');
	let known: KnownFacts | undefined;
	let knownPath: string | undefined;
	if (knownIndex !== -1) {
		knownPath = readFlagValue(args, knownIndex, '--known');
		known = loadKnownFacts(knownPath);
		args.splice(knownIndex, 2);
	}

	const typedTitle = args
		.filter((a) => a !== '--force' && a !== '--fiction' && a !== '--trust-known' && a !== '--title-not-typed')
		.join(' ')
		.trim();
	// Falls back to the --known file's own basename (e.g.
	// `known/the-undiscovered-self.json` -> "the-undiscovered-self") when no
	// title was typed, so `--known <path>` can work standalone as long as
	// the file's named after the book. This seeds the working slug and the
	// search-title fallback, but it's NOT a real title — outlineNode's
	// known.chapters branch (the one path with no model call to produce a
	// real title from search) must not let this leak through as the
	// *published* title, so `titleWasTyped` lets it tell the difference.
	const title = typedTitle || (knownPath ? stripJsonExtension(knownPath) : '');
	return {
		title,
		titleWasTyped: !!typedTitle && !titleNotTyped,
		force,
		fiction,
		personalNotes,
		emitJsonPath,
		isbn,
		known,
		trustKnown,
	};
}

async function main() {
	let title: string;
	let titleWasTyped: boolean;
	let force: boolean;
	let fiction: boolean;
	let personalNotes: string | undefined;
	let isbn: string | undefined;
	let known: KnownFacts | undefined;
	let trustKnown: boolean;
	try {
		({ title, titleWasTyped, force, fiction, personalNotes, emitJsonPath, isbn, known, trustKnown } = parseArgs(
			process.argv.slice(2),
		));
	} catch (err) {
		console.error(err instanceof Error ? err.message : String(err));
		process.exit(1);
		return;
	}

	if (!title) {
		console.error(USAGE);
		process.exit(1);
		return;
	}

	// --known's own `notes` field and --notes are complementary, not
	// exclusive — a reader might keep durable per-edition facts in one and
	// jot fresh, this-reading-specific notes in the other. Both, either, or
	// neither may be present.
	const combinedNotes = [known?.notes, personalNotes].filter((n): n is string => !!n).join('\n\n');

	// --isbn wins over --known's isbn when both are given — it's the more
	// explicit, invocation-specific override. `undefined` (rather than
	// omitting `knownFacts` entirely) whenever neither flag supplied
	// anything, so outlineNode only has one shape (`state.knownFacts?.x`) to
	// deal with regardless of which flags were used.
	const knownFacts: KnownFacts | undefined =
		known || isbn ? { ...known, isbn: isbn ?? known?.isbn } : undefined;

	// A --known file's own `kind` is ground truth, same precedence as its
	// title/author/year/isbn — it wins over --fiction if both are given (see
	// knownFactsSchema's comment).
	const isFiction = knownFacts?.kind ? knownFacts.kind === 'fiction' : fiction;

	try {
		searchProvider = new TavilyProvider(requireEnv('TAVILY_API_KEY'));
		model = createModel();
		chapterLimit = pLimit(CHAPTER_CONCURRENCY);

		if (isFiction) {
			await fictionApp.invoke(
				{ title, force, personalNotes: combinedNotes || undefined, knownFacts },
				{ recursionLimit: 50 },
			);
		} else {
			await app.invoke(
				{ title, titleWasTyped, force, personalNotes: combinedNotes || undefined, knownFacts, trustKnown },
				{ recursionLimit: 50 },
			);
		}
	} catch (err) {
		logError(`\nGeneration failed: ${err instanceof Error ? err.message : err}`);
		process.exit(1);
	}
}

main();
