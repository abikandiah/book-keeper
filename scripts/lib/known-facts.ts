import fs from 'node:fs';
import { z } from 'zod';

// Ground truth the caller already has for a specific book/edition — exact
// title, author, ISBN, page count, publication year, and/or the real
// chapter/section list — supplied via `--known <path>` so the pipeline can
// treat them as fixed instead of re-deriving them from noisy web search.
// Every field is optional: supply only what you actually know as fact.
// Anything omitted still goes through the normal search+consensus path (see
// outlineNode in generate-book.ts).
export const knownFactsSchema = z.object({
	title: z.string().optional(),
	author: z.string().optional(),
	year: z.number().optional(),
	isbn: z.string().optional(),
	page_count: z.number().optional(),
	// When given (non-empty), the entire outline search+consensus stage is
	// skipped — this list is trusted outright as the real, ordered
	// chapter/section list for this edition. Don't supply a partial or
	// uncertain list here; leave the field out instead and let outline
	// search run normally. Still gets one search + a narrow model critique
	// first (verifyKnownFactsNode in generate-book.ts, skippable via
	// --trust-known) — the outline-consensus skip above means this is
	// otherwise the one field with no other check at all.
	chapters: z.array(z.string()).min(1).optional(),
	notes: z.string().optional(),
});
export type KnownFacts = z.infer<typeof knownFactsSchema>;

export function loadKnownFacts(path: string): KnownFacts {
	const raw = fs.readFileSync(path, 'utf-8');

	let json: unknown;
	try {
		json = JSON.parse(raw);
	} catch (err) {
		throw new Error(`--known file "${path}" is not valid JSON: ${err instanceof Error ? err.message : err}`);
	}

	const parsed = knownFactsSchema.safeParse(json);
	if (!parsed.success) {
		const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
		throw new Error(`--known file "${path}" doesn't match the expected shape: ${issues}`);
	}
	return parsed.data;
}
