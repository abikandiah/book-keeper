// Plain zod module — deliberately has zero `astro:content` / `astro/loaders`
// imports, so it can be imported both by Astro (via content.config.ts) and by
// the standalone generation script (via tsx, which cannot resolve Astro's
// virtual modules). This file is the single source of truth for the book
// content shape; content.config.ts and scripts/generate-book.ts both import
// from here rather than redefining anything.
import { z } from 'zod';

export const chapterSchema = z.object({
	number: z.number(),
	title: z.string(),
	key_points: z.array(z.string()).min(1).max(6),
	core_claim: z.string(), // one sentence: the chapter's central point
});

export const keyClaimSchema = z.object({
	prompt: z.string(), // a recall cue, e.g. "What is the narrative fallacy?"
	answer: z.string(), // the answer/explanation, 1-3 sentences
});

export const bookSchema = z.object({
	title: z.string(),
	author: z.string(),
	year: z.number().optional(),
	tags: z.array(z.string()).min(1),
	date_added: z.string(), // ISO date, when it was added to the site
	one_line_takeaway: z.string(),
	synopsis: z.string(), // 1-3 paragraphs
	chapters: z.array(chapterSchema).min(1),
	key_claims_for_review: z.array(keyClaimSchema).min(3),
});

// Stage 2 (per-chapter drafting) model output — `number`/`title` are filled in
// by the script itself (from the Outline stage's ordered list), not asked of
// the model, so it can't miscount or reword a chapter title.
export const chapterContentSchema = z.object({
	key_points: chapterSchema.shape.key_points,
	core_claim: chapterSchema.shape.core_claim,
});

// Stage 1 (Outline) output — metadata + ordered chapter titles, nothing else yet.
export const outlineSchema = bookSchema
	.pick({ title: true, author: true, year: true })
	.extend({ chapter_titles: z.array(z.string()).min(1) });

// Stage 3 (Synthesis) output — the top-level fields not covered by chapters.
export const synthesisSchema = bookSchema.pick({
	one_line_takeaway: true,
	synopsis: true,
	tags: true,
	key_claims_for_review: true,
});

// Stage 4 repair-loop output — every top-level field a repair call could
// plausibly need to fix. Excludes `chapters` (already validated per-chapter
// before Stage 4 ever runs, see Part 2's "Per-chapter validation") and
// `date_added` (script-generated, never model output).
export const repairableSchema = bookSchema.omit({ chapters: true, date_added: true });

export type Chapter = z.infer<typeof chapterSchema>;
export type ChapterContent = z.infer<typeof chapterContentSchema>;
export type KeyClaim = z.infer<typeof keyClaimSchema>;
export type Book = z.infer<typeof bookSchema>;
export type Outline = z.infer<typeof outlineSchema>;
export type Synthesis = z.infer<typeof synthesisSchema>;
export type Repairable = z.infer<typeof repairableSchema>;
