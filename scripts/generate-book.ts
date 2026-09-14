import fs from 'node:fs';
import { Annotation, END, START, Send, StateGraph } from '@langchain/langgraph';
import pLimit from 'p-limit';
import { z } from 'zod';

import {
	bookSchema,
	chapterContentSchema,
	chapterSchema,
	outlineSchema,
	repairableSchema,
	synthesisSchema,
	type Book,
	type Chapter,
	type Repairable,
	type Synthesis,
} from '../src/content/schema';
import { currentBranch, isGitRepo } from './lib/git';
import { createModel } from './lib/model';
import { lookupEditionByIsbn, lookupIsbn } from './lib/openlibrary';
import {
	buildChapterCritiquePrompt,
	buildChapterPrompt,
	buildOutlineCritiquePrompt,
	buildOutlinePrompt,
	buildOutlineRepairPrompt,
	buildRepairPrompt,
	buildSynthesisPrompt,
} from './lib/prompts';
import { checkPublishable, publishBook, slugify } from './lib/publish';
import { TavilyProvider } from './search/tavily';
import type { SearchProvider, SearchResult } from './search/types';

// Shared shape for both the outline- and chapter-level review passes below —
// a second, independent model call judging the first's output before it's
// accepted, rather than a single unchecked generation. Not full multi-
// candidate consensus (generate N, vote) — a critic-then-bounded-retry gate
// gets most of the reliability benefit for a fraction of the extra LLM
// calls, which matters directly against free-tier rate/daily-quota limits.
const critiqueSchema = z.object({
	plausible: z.boolean(),
	concerns: z.array(z.string()),
});
type Critique = z.infer<typeof critiqueSchema>;

try {
	process.loadEnvFile('.env');
} catch {
	// no .env file present — fine, vars may already be set in the environment
}

const MAX_TOP_LEVEL_RETRIES = 3;
const MAX_CHAPTER_LOCAL_RETRIES = 2;
// One retry (two attempts total) — each attempt here costs two model calls
// (draft + critique), not one, so this is deliberately lower than
// MAX_CHAPTER_LOCAL_RETRIES for the same total-cost order of magnitude.
const MAX_OUTLINE_REVIEW_RETRIES = 1;
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
	force: Annotation<boolean>({ reducer: overwrite, default: () => false }),
	slug: Annotation<string>({ reducer: overwrite, default: () => '' }),
	originalBranch: Annotation<string>({ reducer: overwrite, default: () => '' }),
	author: Annotation<string | undefined>(),
	year: Annotation<number | undefined>(),
	// From --isbn, if given. Lets outlineNode resolve the exact edition's own
	// title/author upfront and search against that instead of the reader's
	// own paraphrase of the title.
	isbnOverride: Annotation<string | undefined>(),
	// A live Promise, not a resolved value — kicked off in outlineNode but
	// deliberately not awaited there, so its network round-trip overlaps
	// with the (much longer) parallel chapter fan-out instead of serializing
	// in front of it. Only awaited where isbn/pageCount are actually
	// consumed (validateNode). Fine to hold a raw Promise in state since
	// checkpointing isn't used in v1 — nothing ever needs to serialize this.
	isbnPromise: Annotation<Promise<{ isbn?: string; pageCount?: number } | undefined> | undefined>(),
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

// ---------------------------------------------------------------------------
// Stage 0 — Setup
// ---------------------------------------------------------------------------
async function setupNode(state: State): Promise<Partial<State>> {
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
		console.log(`Generating "${state.title}" -> slug "${slug}" (sandboxed: emitting JSON, no git operations)`);
		return { slug, originalBranch: '' };
	}

	checkPublishable(slug, state.force);

	console.log(`Generating "${state.title}" -> slug "${slug}"${emitJsonPath ? ' (emitting JSON, no git commit)' : ''}`);
	return { slug, originalBranch: emitJsonPath ? '' : currentBranch() };
}

// ---------------------------------------------------------------------------
// Stage 1 — Outline
// ---------------------------------------------------------------------------
async function outlineNode(state: State): Promise<Partial<State>> {
	// --isbn pins the search to this exact edition's own published title
	// (e.g. avoiding ambiguity between translations/editions) rather than
	// however the reader phrased the CLI title. Its author/year — a direct
	// lookup — also override the model's own guess below, once drafted.
	// Never throws; a lookup miss just means no accuracy boost, not a
	// failure.
	let searchTitle = state.title;
	let editionMeta: Awaited<ReturnType<typeof lookupEditionByIsbn>>;
	if (state.isbnOverride) {
		editionMeta = await lookupEditionByIsbn(state.isbnOverride);
		if (editionMeta?.title) searchTitle = editionMeta.title;
	}

	// A second, independent model call judges each drafted chapter list
	// before it's accepted — see critiqueSchema's comment above. Re-searches
	// on each retry rather than just re-asking the model to "fix" the same
	// list from nothing: the observed failure mode (front matter/themes
	// mistaken for the real chapter list) is a sourcing problem as much as a
	// reasoning one. Attempt 1 runs unconditionally before the retry loop,
	// so `outline`/`results`/`critique` always hold real values below —
	// never `undefined`, so no non-null assertions needed at any use site.
	let results = await searchProvider.search(`"${searchTitle}" chapter list table of contents`, 5);
	let outline = await model.withStructuredOutput(outlineSchema).invoke(buildOutlinePrompt(searchTitle, results));
	let critique = await model
		.withStructuredOutput(critiqueSchema)
		.invoke(buildOutlineCritiquePrompt(searchTitle, outline.chapter_titles, results));
	console.log(
		critique.plausible
			? '  outline review: looks good (attempt 1)'
			: `  outline review: flagged (attempt 1): ${critique.concerns.join('; ')}`,
	);

	for (let attempt = 2; !critique.plausible && attempt <= MAX_OUTLINE_REVIEW_RETRIES + 1; attempt++) {
		results = await searchProvider.search(`"${searchTitle}" chapter list table of contents`, 5);
		outline = await model
			.withStructuredOutput(outlineSchema)
			.invoke(buildOutlineRepairPrompt(searchTitle, results, outline.chapter_titles, critique.concerns));
		critique = await model
			.withStructuredOutput(critiqueSchema)
			.invoke(buildOutlineCritiquePrompt(searchTitle, outline.chapter_titles, results));
		console.log(
			critique.plausible
				? `  outline review: looks good (attempt ${attempt})`
				: `  outline review: flagged (attempt ${attempt}): ${critique.concerns.join('; ')}`,
		);
	}

	// A direct ISBN lookup beats the model's own guess when one's available.
	const author = editionMeta?.author ?? outline.author;
	const year = editionMeta?.year ?? outline.year;

	console.log(
		`Found ${outline.chapter_titles.length} chapters for "${outline.title}"` +
			`${author ? ` by ${author}` : ''}${year ? ` (${year})` : ''}` +
			(critique.plausible ? '' : ' (unresolved review concerns — worth a manual check)'),
	);

	// Resolved via a direct Open Library API lookup, not the model — see
	// scripts/lib/openlibrary.ts. Deliberately NOT awaited here: isbn/
	// pageCount aren't consumed until validateNode (Stage 4), so kicking
	// this off without blocking lets its round-trip overlap with the
	// parallel chapter fan-out instead of serializing in front of it. Never
	// throws; `undefined` fields just mean no cover image/page count,
	// handled gracefully downstream.
	const isbnPromise = state.isbnOverride
		? Promise.resolve({ isbn: state.isbnOverride, pageCount: editionMeta?.pageCount })
		: lookupIsbn(outline.title, author).then(async (isbn) => {
				if (!isbn) return undefined;
				const meta = await lookupEditionByIsbn(isbn);
				return { isbn, pageCount: meta?.pageCount };
			});

	return {
		title: outline.title,
		author,
		year,
		isbnPromise,
		chapterTitles: outline.chapter_titles,
		totalChapters: outline.chapter_titles.length,
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

				console.log(`  chapter ${chapterIndex + 1}/${state.totalChapters} drafted: "${chapterTitle}"`);
				return { chapters: [parsed.data] };
			} catch (err) {
				lastError = err instanceof Error ? err.message : String(err);
			}
		}

		if (lastValidCandidate) {
			console.log(
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
	const prompt = buildSynthesisPrompt(state.title, state.author, chaptersSummary, results, state.personalNotes);
	const synthesis = await model.withStructuredOutput(synthesisSchema).invoke(prompt);

	console.log('Synthesis complete.');
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
	console.log(
		isbn
			? `Found ISBN ${isbn}${pageCount ? `, ${pageCount} pages` : ''} (cover image available).`
			: 'No ISBN found — book will render without a cover.',
	);

	const candidate = {
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
		console.log('Validated against the books content schema.');
		return { validationErrors: [], book: parsed.data };
	}

	const errors = parsed.error.issues.map(formatIssue);
	console.log(`Validation failed (attempt ${state.retryCount + 1}): ${errors.join('; ')}`);
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

function failNode(state: State): never {
	throw new Error(
		`Generation failed validation after ${state.retryCount} repair attempt(s):\n${state.validationErrors.join('\n')}`,
	);
}

// ---------------------------------------------------------------------------
// Stage 5 — Publish to a draft branch (commit only — no push, see Part 5)
// ---------------------------------------------------------------------------
async function publishNode(state: State): Promise<Partial<State>> {
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
async function emitNode(state: State): Promise<Partial<State>> {
	const json = `${JSON.stringify(state.book, null, 2)}\n`;
	fs.writeFileSync(emitJsonPath!, json);
	console.log(`\nWrote validated book JSON to ${emitJsonPath}.`);
	console.log('Run scripts/publish-book.ts on the host to commit it.');
	return {};
}

// ---------------------------------------------------------------------------
// Graph wiring
// ---------------------------------------------------------------------------
const graph = new StateGraph(BookGenState)
	.addNode('setup', setupNode)
	.addNode('outline', outlineNode)
	.addNode('chapterDetail', chapterDetailNode)
	.addNode('synthesize', synthesisNode)
	.addNode('validate', validateNode)
	.addNode('repair', repairNode)
	.addNode('fail', failNode)
	.addNode('publish', publishNode)
	.addNode('emit', emitNode)
	.addEdge(START, 'setup')
	.addEdge('setup', 'outline')
	.addConditionalEdges('outline', dispatchChapters)
	.addEdge('chapterDetail', 'synthesize')
	.addEdge('synthesize', 'validate')
	.addConditionalEdges(
		'validate',
		(state) =>
			state.validationErrors.length === 0
				? emitJsonPath
					? 'emit'
					: 'publish'
				: state.retryCount < MAX_TOP_LEVEL_RETRIES
					? 'repair'
					: 'fail',
		{ publish: 'publish', emit: 'emit', repair: 'repair', fail: 'fail' },
	)
	.addEdge('repair', 'validate')
	.addEdge('fail', END)
	.addEdge('publish', END)
	.addEdge('emit', END);

const app = graph.compile();

// ---------------------------------------------------------------------------
// CLI entrypoint
// ---------------------------------------------------------------------------
// Pulls --notes <path> and --emit-json <path> (value-taking flags) out
// before the remaining args are joined back into the title, and reads the
// notes file eagerly so a bad path fails fast rather than partway through
// the pipeline.
function parseArgs(
	argv: string[],
): { title: string; force: boolean; personalNotes?: string; emitJsonPath?: string; isbn?: string } {
	// `pnpm run generate -- "Title"` forwards a literal `--` through to this
	// script instead of stripping it (confirmed on pnpm 12.x) — dropped here
	// so it doesn't end up folded into the title below.
	const args = argv.filter((a) => a !== '--');
	const force = args.includes('--force');

	const notesIndex = args.indexOf('--notes');
	let personalNotes: string | undefined;
	if (notesIndex !== -1) {
		const notesPath = args[notesIndex + 1];
		if (!notesPath) throw new Error('--notes requires a file path argument.');
		personalNotes = fs.readFileSync(notesPath, 'utf-8');
		args.splice(notesIndex, 2);
	}

	const emitJsonIndex = args.indexOf('--emit-json');
	let emitJsonPath: string | undefined;
	if (emitJsonIndex !== -1) {
		emitJsonPath = args[emitJsonIndex + 1];
		if (!emitJsonPath) throw new Error('--emit-json requires a file path argument.');
		args.splice(emitJsonIndex, 2);
	}

	const isbnIndex = args.indexOf('--isbn');
	let isbn: string | undefined;
	if (isbnIndex !== -1) {
		isbn = args[isbnIndex + 1];
		if (!isbn) throw new Error('--isbn requires a value.');
		args.splice(isbnIndex, 2);
	}

	const title = args.filter((a) => a !== '--force').join(' ').trim();
	return { title, force, personalNotes, emitJsonPath, isbn };
}

async function main() {
	let title: string;
	let force: boolean;
	let personalNotes: string | undefined;
	let isbn: string | undefined;
	try {
		({ title, force, personalNotes, emitJsonPath, isbn } = parseArgs(process.argv.slice(2)));
	} catch (err) {
		console.error(err instanceof Error ? err.message : String(err));
		process.exit(1);
		return;
	}

	if (!title) {
		console.error(
			'Usage: pnpm run generate -- "Book Title" [--force] [--notes <path>] [--emit-json <path>] [--isbn <isbn>]',
		);
		process.exit(1);
		return;
	}

	try {
		searchProvider = new TavilyProvider(requireEnv('TAVILY_API_KEY'));
		model = createModel();
		chapterLimit = pLimit(CHAPTER_CONCURRENCY);

		await app.invoke({ title, force, personalNotes, isbnOverride: isbn }, { recursionLimit: 50 });
	} catch (err) {
		console.error('\nGeneration failed:', err instanceof Error ? err.message : err);
		process.exit(1);
	}
}

main();
