// Plain zod module — deliberately has zero `astro:content` / `astro/loaders`
// imports, so it can be imported both by Astro (via content.config.ts) and by
// the standalone generation script (via tsx, which cannot resolve Astro's
// virtual modules). This file is the single source of truth for the book
// content shape; content.config.ts and scripts/generate-book.ts both import
// from here rather than redefining anything.
import { z } from 'zod';

// Closed vocabularies for `tags`, curated from BISAC Subject Headings (the
// taxonomy the publishing industry itself uses — Amazon, bookstores, most
// library systems) rather than left to whatever free-form label the model
// invents per book. Split in two because a novel's genres and a non-fiction
// book's subjects are genuinely different vocabularies, not because they
// share a spectrum. Extend either by hand when a genuinely new category of
// book shows up — that's the only change needed, since both the schema below
// and the generation prompts derive from these.
export const NONFICTION_TAGS = [
	'history',
	'world-history',
	'military-history',
	'philosophy',
	'psychology',
	'self-help',
	'science',
	'mathematics',
	'technology',
	'computers-internet',
	'engineering',
	'business',
	'economics',
	'finance',
	'politics',
	'current-affairs',
	'sociology',
	'anthropology',
	'gender-studies',
	'biography-memoir',
	'religion-spirituality',
	'health-wellness',
	'medicine',
	'nature-environment',
	'true-crime',
	'education',
	'language-linguistics',
	'journalism-media',
	'art-design',
	'architecture',
	'music',
	'travel',
	'law',
	'literary-criticism',
	'parenting-family',
	'sports-recreation',
	'cooking-food',
	'crafts-hobbies',
	'humor',
	'reference',
] as const;

export const FICTION_TAGS = [
	'fiction-literary',
	'fiction-classic',
	'fiction-historical',
	'science-fiction',
	'fantasy',
	'mystery-thriller',
	'crime-detective',
	'horror',
	'romance',
	'drama',
	'adventure',
	'war-military-fiction',
	'dystopian',
	'magical-realism',
	'coming-of-age',
	'poetry',
	'short-stories',
	'young-adult',
	'graphic-novel',
	'humor-satire',
] as const;

export const chapterSchema = z.object({
	number: z.number(),
	title: z.string(),
	key_points: z.array(z.string()).min(1).max(10),
	core_claim: z.string(), // one sentence: the chapter's central point
});

export const keyClaimSchema = z.object({
	prompt: z.string(), // a recall cue, e.g. "What is the narrative fallacy?"
	answer: z.string(), // the answer/explanation, 1-3 sentences
});

// Fields every book has regardless of kind — factored out as plain field
// definitions (not a ZodObject) so both member schemas below can spread them
// in directly, and so outlineSchema can pick just title/author/year without
// depending on either member schema's own shape.
const commonFields = {
	title: z.string(),
	author: z.string(),
	year: z.number().optional(),
	// Resolved via the Open Library search API (not asked of the LLM) — used
	// to construct a cover-image URL at render time
	// (https://covers.openlibrary.org/b/isbn/<isbn>-M.jpg). Absent when no
	// match is found; the frontend must render fine without it.
	isbn: z.string().optional(),
	// Resolved alongside isbn (same Open Library lookup, see
	// scripts/lib/openlibrary.ts) — absent whenever isbn is.
	page_count: z.number().optional(),
	date_added: z.string(), // ISO date, when it was added to the site
	// Manually flipped to true by the reader after reviewing the generated
	// content (part of the existing draft-branch review step, see Part 5's
	// day-to-day workflow) — never set by the model. Absence/false just means
	// "not yet reviewed," not "wrong."
	verified: z.boolean().default(false),
	one_line_takeaway: z.string(),
	synopsis: z.string(), // 1-3 paragraphs; a plot summary for fiction
};

function uniqueTags<T extends z.ZodTypeAny>(tag: T) {
	return z
		.array(tag)
		.min(2)
		.max(4)
		.refine((tags) => new Set(tags).size === tags.length, { message: 'tags must not repeat' });
}

// The full study-guide shape: per-chapter breakdown + spaced-recall flashcard
// deck. Only makes sense for an argument-driven non-fiction book — a novel
// doesn't decompose into "claims" the same way (see fictionBookSchema).
export const nonFictionBookSchema = z.object({
	kind: z.literal('non-fiction'),
	...commonFields,
	tags: uniqueTags(z.enum(NONFICTION_TAGS)),
	chapters: z.array(chapterSchema).min(1),
	key_claims_for_review: z.array(keyClaimSchema).min(3),
});

// Deliberately just cataloging: details, cover, and a plot summary — no
// chapter walkthrough, no key-claims review deck. See Part 5/CLAUDE
// conversation history for why: reading fiction isn't about retaining facts
// the way non-fiction is, so there's nothing worth spaced-recall reviewing.
export const fictionBookSchema = z.object({
	kind: z.literal('fiction'),
	...commonFields,
	tags: uniqueTags(z.enum(FICTION_TAGS)),
});

export const bookSchema = z.discriminatedUnion('kind', [nonFictionBookSchema, fictionBookSchema]);

// Stage 2 (per-chapter drafting) model output — `number`/`title` are filled in
// by the script itself (from the Outline stage's ordered list), not asked of
// the model, so it can't miscount or reword a chapter title. Non-fiction only.
export const chapterContentSchema = z.object({
	key_points: chapterSchema.shape.key_points,
	core_claim: chapterSchema.shape.core_claim,
});

// Outline stage output — metadata + ordered chapter titles, nothing else yet.
// Shared identity fields only (not picked off either member schema, since
// this runs before `kind` is even known to matter for shape purposes).
export const outlineSchema = z
	.object({
		title: commonFields.title,
		author: commonFields.author,
		year: commonFields.year,
	})
	.extend({ chapter_titles: z.array(z.string()).min(1) });

// Non-fiction Synthesis stage output — the top-level fields not covered by
// chapters.
export const synthesisSchema = nonFictionBookSchema.pick({
	one_line_takeaway: true,
	synopsis: true,
	tags: true,
	key_claims_for_review: true,
});

// Non-fiction Stage 4 repair-loop output — every top-level field a repair
// call could plausibly need to fix. Excludes `chapters` (already validated
// per-chapter before Stage 4 ever runs, see Part 2's "Per-chapter
// validation"), `kind` (fixed, never in question once this pipeline is
// running), `date_added` (script-generated, never model output),
// `isbn`/`page_count` (resolved via a direct API lookup, not model
// knowledge), and `verified` (reader-controlled, never model output).
export const repairableSchema = nonFictionBookSchema.omit({
	kind: true,
	chapters: true,
	date_added: true,
	isbn: true,
	page_count: true,
	verified: true,
});

// Fiction's entire generation call: no separate outline/synthesis split
// (there's no per-chapter stage to feed into a later synthesis step), so one
// schema covers both the initial draft and repair-loop output — title/author/
// year confirmation plus everything else in one shot. Mirrors repairableSchema
// above at fiction's smaller scale.
export const fictionRepairableSchema = fictionBookSchema.omit({
	kind: true,
	date_added: true,
	isbn: true,
	page_count: true,
	verified: true,
});

export type Chapter = z.infer<typeof chapterSchema>;
export type ChapterContent = z.infer<typeof chapterContentSchema>;
export type KeyClaim = z.infer<typeof keyClaimSchema>;
export type NonFictionBook = z.infer<typeof nonFictionBookSchema>;
export type FictionBook = z.infer<typeof fictionBookSchema>;
export type Book = z.infer<typeof bookSchema>;
export type Outline = z.infer<typeof outlineSchema>;
export type Synthesis = z.infer<typeof synthesisSchema>;
export type Repairable = z.infer<typeof repairableSchema>;
export type FictionRepairable = z.infer<typeof fictionRepairableSchema>;
