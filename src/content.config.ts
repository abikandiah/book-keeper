import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

const chapterSchema = z.object({
	number: z.number(),
	title: z.string(),
	key_points: z.array(z.string()).min(1).max(6),
	core_claim: z.string(), // one sentence: the chapter's central point
});

const keyClaimSchema = z.object({
	prompt: z.string(), // a recall cue, e.g. "What is the narrative fallacy?"
	answer: z.string(), // the answer/explanation, 1-3 sentences
});

const booksCollection = defineCollection({
	loader: glob({ pattern: '**/*.json', base: './src/content/books' }),
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
