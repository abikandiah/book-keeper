import fs from 'node:fs';
import path from 'node:path';
import { Annotation, END, START, Send, StateGraph } from '@langchain/langgraph';
import pLimit from 'p-limit';

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
import {
	branchExists,
	checkoutBranch,
	commitFile,
	createAndCheckoutBranch,
	currentBranch,
	isWorkingTreeClean,
} from './lib/git';
import { createModel } from './lib/model';
import { lookupIsbn } from './lib/openlibrary';
import { buildChapterPrompt, buildOutlinePrompt, buildRepairPrompt, buildSynthesisPrompt } from './lib/prompts';
import { TavilyProvider } from './search/tavily';
import type { SearchProvider } from './search/types';

try {
	process.loadEnvFile('.env');
} catch {
	// no .env file present — fine, vars may already be set in the environment
}

const MAX_TOP_LEVEL_RETRIES = 3;
const MAX_CHAPTER_LOCAL_RETRIES = 2;
const CHAPTER_CONCURRENCY = Number(process.env.CHAPTER_CONCURRENCY) || 4;
const BOOKS_DIR = 'src/content/books';

function slugify(title: string): string {
	return title
		.toLowerCase()
		.normalize('NFKD')
		.replace(/[\u0300-\u036f]/g, '') // strip combining diacritics after NFKD decomposition
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/(^-|-$)/g, '');
}

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
	// A live Promise, not a resolved value — kicked off in outlineNode but
	// deliberately not awaited there, so its network round-trip overlaps
	// with the (much longer) parallel chapter fan-out instead of serializing
	// in front of it. Only awaited where isbn is actually consumed
	// (validateNode). Fine to hold a raw Promise in state since checkpointing
	// isn't used in v1 — nothing ever needs to serialize this.
	isbnPromise: Annotation<Promise<string | undefined> | undefined>(),
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

	const filePath = path.join(BOOKS_DIR, `${slug}.json`);
	const branch = `book/${slug}`;
	const branchAlreadyExists = branchExists(branch);

	if (!state.force) {
		if (fs.existsSync(filePath)) {
			throw new Error(`${filePath} already exists. Pass --force to regenerate it.`);
		}
		if (branchAlreadyExists) {
			throw new Error(`Branch "${branch}" already exists. Pass --force to proceed anyway.`);
		}
	} else if (branchAlreadyExists) {
		console.warn(
			`Branch "${branch}" already exists — --force will reset it to this run, discarding any commits currently on it.`,
		);
	}
	if (!isWorkingTreeClean()) {
		throw new Error(
			'Working tree is not clean. Commit or stash pending changes before generating a book — Stage 5 creates and commits to a new branch.',
		);
	}

	console.log(`Generating "${state.title}" -> slug "${slug}"`);
	return { slug, originalBranch: currentBranch() };
}

// ---------------------------------------------------------------------------
// Stage 1 — Outline
// ---------------------------------------------------------------------------
async function outlineNode(state: State): Promise<Partial<State>> {
	const results = await searchProvider.search(`"${state.title}" chapter list table of contents`, 5);
	const prompt = buildOutlinePrompt(state.title, results);
	const outline = await model.withStructuredOutput(outlineSchema).invoke(prompt);

	console.log(
		`Found ${outline.chapter_titles.length} chapters for "${outline.title}"` +
			`${outline.author ? ` by ${outline.author}` : ''}${outline.year ? ` (${outline.year})` : ''}`,
	);

	// Resolved via a direct Open Library API lookup, not the model — see
	// scripts/lib/openlibrary.ts. Deliberately NOT awaited here: isbn isn't
	// consumed until validateNode (Stage 4), so kicking this off without
	// blocking lets its round-trip overlap with the parallel chapter
	// fan-out instead of serializing in front of it. Never throws;
	// `undefined` just means no cover image, handled gracefully downstream.
	const isbnPromise = lookupIsbn(outline.title, outline.author);

	return {
		title: outline.title,
		author: outline.author,
		year: outline.year,
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
		for (let attempt = 0; attempt <= MAX_CHAPTER_LOCAL_RETRIES; attempt++) {
			const prompt = attempt === 0 ? basePrompt : buildRepairPrompt(lastAttempt, [lastError]);
			try {
				const draft = await model.withStructuredOutput(chapterContentSchema).invoke(prompt);
				const candidate = { number: chapterIndex + 1, title: chapterTitle, ...draft };
				lastAttempt = candidate;
				const parsed = chapterSchema.safeParse(candidate);
				if (parsed.success) {
					console.log(`  chapter ${chapterIndex + 1}/${state.totalChapters} drafted: "${chapterTitle}"`);
					return { chapters: [parsed.data] };
				}
				lastError = parsed.error.issues.map(formatIssue).join('; ');
			} catch (err) {
				lastError = err instanceof Error ? err.message : String(err);
			}
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
	const prompt = buildSynthesisPrompt(state.title, state.author, chaptersSummary, results);
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
	const isbn = await state.isbnPromise;
	console.log(isbn ? `Found ISBN ${isbn} (cover image available).` : 'No ISBN found — book will render without a cover.');

	const candidate = {
		title: state.title,
		author: state.author,
		year: state.year,
		isbn,
		tags: state.synthesis?.tags ?? [],
		date_added: new Date().toISOString().slice(0, 10),
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
	// `date_added`, and `isbn`) rather than just synthesisSchema —
	// validateNode's `bookSchema` check covers title/author/year too (e.g.
	// an outline that came back with no determinable author), and a
	// synthesis-only repair could never fix a failure in one of those
	// fields, burning all retries on an unfixable error. `isbn` is
	// deliberately left untouched here — it came from a direct API lookup,
	// not the model, so it stays whatever outlineNode resolved (possibly
	// undefined) regardless of what else needed repairing.
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
	const branch = `book/${state.slug}`;
	const filePath = path.join(BOOKS_DIR, `${state.slug}.json`);

	try {
		createAndCheckoutBranch(branch);
		fs.mkdirSync(BOOKS_DIR, { recursive: true });
		fs.writeFileSync(filePath, `${JSON.stringify(state.book, null, 2)}\n`);
		commitFile(filePath, `Add ${state.title}`);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		// Best-effort recovery: switch back to whatever branch we started on
		// so a failed commit (bad git identity, a rejected pre-commit hook,
		// disk full) doesn't leave the repo stranded on a half-published
		// branch that then blocks every future run via isWorkingTreeClean().
		try {
			checkoutBranch(state.originalBranch);
			console.error(
				`\nPublish failed on branch "${branch}": ${message}\n` +
					`Restored original branch "${state.originalBranch}". "${branch}" may still exist with a ` +
					`partial/uncommitted change — inspect it and delete it ("git branch -D ${branch}") if needed.`,
			);
		} catch {
			console.error(
				`\nPublish failed on branch "${branch}": ${message}\n` +
					`Could not automatically switch back to "${state.originalBranch}" — resolve this manually ` +
					`("git status", "git branch") before running generate again.`,
			);
		}
		throw err;
	}

	console.log(`\nCommitted to branch "${branch}".`);
	console.log(`Run "pnpm dev" and open /books/${state.slug} to review before merging to main.`);
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
	.addEdge(START, 'setup')
	.addEdge('setup', 'outline')
	.addConditionalEdges('outline', dispatchChapters)
	.addEdge('chapterDetail', 'synthesize')
	.addEdge('synthesize', 'validate')
	.addConditionalEdges(
		'validate',
		(state) =>
			state.validationErrors.length === 0
				? 'publish'
				: state.retryCount < MAX_TOP_LEVEL_RETRIES
					? 'repair'
					: 'fail',
		{ publish: 'publish', repair: 'repair', fail: 'fail' },
	)
	.addEdge('repair', 'validate')
	.addEdge('fail', END)
	.addEdge('publish', END);

const app = graph.compile();

// ---------------------------------------------------------------------------
// CLI entrypoint
// ---------------------------------------------------------------------------
async function main() {
	const rawArgs = process.argv.slice(2);
	const force = rawArgs.includes('--force');
	const title = rawArgs.filter((a) => a !== '--force').join(' ').trim();

	if (!title) {
		console.error('Usage: pnpm run generate -- "Book Title" [--force]');
		process.exit(1);
		return;
	}

	try {
		searchProvider = new TavilyProvider(requireEnv('TAVILY_API_KEY'));
		model = createModel();
		chapterLimit = pLimit(CHAPTER_CONCURRENCY);

		await app.invoke({ title, force }, { recursionLimit: 50 });
	} catch (err) {
		console.error('\nGeneration failed:', err instanceof Error ? err.message : err);
		process.exit(1);
	}
}

main();
