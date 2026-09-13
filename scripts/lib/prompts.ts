import type { SearchResult } from '../search/types';

export function formatSearchResults(results: SearchResult[]): string {
	if (results.length === 0) return '(no search results found)';
	return results
		.map((r, i) => `[${i + 1}] ${r.title} (${r.url})\n${r.content}`)
		.join('\n\n');
}

export function buildOutlinePrompt(title: string, results: SearchResult[]): string {
	return `You are researching the non-fiction book "${title}" to build a structured summary.

Here is what web search turned up about this book:

${formatSearchResults(results)}

Based on this, determine:
- The book's author (full name)
- The publication year
- The book's actual chapter/section list, in order, using the real chapter titles as published — not a generic or invented structure

Return only what the search results support. If a detail is genuinely not
determinable from the given context, make your best-supported inference
rather than guessing wildly.`;
}

export function buildChapterPrompt(
	bookTitle: string,
	chapterTitle: string,
	results: SearchResult[],
): string {
	return `You are summarizing one chapter of the non-fiction book "${bookTitle}".

Chapter: "${chapterTitle}"

Here is what web search turned up about this chapter (may be thin — chapter-level coverage online is often sparse; lean on general knowledge of the book where needed):

${formatSearchResults(results)}

Produce:
- key_points: 1-6 concise bullet points covering what this chapter actually argues or covers
- core_claim: a single sentence capturing the chapter's central point`;
}

export function buildSynthesisPrompt(
	bookTitle: string,
	author: string | undefined,
	chaptersSummary: string,
	results: SearchResult[],
	personalNotes?: string,
): string {
	return `You are writing the top-level summary for the non-fiction book "${bookTitle}"${author ? ` by ${author}` : ''}.

Here is the chapter-by-chapter breakdown already produced for this book:

${chaptersSummary}

Here is additional web search context about the book's overall themes:

${formatSearchResults(results)}
${
	personalNotes
		? `
The reader who is generating this summary has also supplied their own rough,
informal notes from actually reading this book. These notes are NOT source
content: they may be fragments, shorthand, or poorly formatted, and must
never be quoted or copied into your output verbatim. Use them only as a
weighting signal — if the reader's notes dwell on a particular chapter, idea,
or claim, treat that as evidence it deserves more prominence in the synopsis
and key_claims_for_review than it might otherwise get. Write everything in
your own clean, publishable prose regardless of how the notes are phrased.

Reader's notes (raw, for weighting only — do not quote):
${personalNotes}
`
		: ''
}
Synthesize from the chapter breakdown above (not just the raw search context) to produce:
- one_line_takeaway: the single sentence you'd want if you only had five seconds — this is what appears on book list/cards
- synopsis: 1-3 paragraphs covering the book's overall arc/thesis
- tags: free-form, lowercase-kebab-case topic tags (e.g. "decision-making", "embedded-systems")
- key_claims_for_review: 5-15 prompt/answer flashcard pairs — recall cues and their answers, phrased for spaced-recall review, covering the claims most worth remembering cold (not necessarily one per chapter)`;
}

export function buildRepairPrompt(previousOutput: unknown, errors: string[]): string {
	return `Your previous output failed schema validation.

Previous output:
${JSON.stringify(previousOutput, null, 2)}

Validation errors:
${errors.join('\n')}

Fix these specific issues and return corrected output matching the schema. Keep everything else from your previous output that wasn't flagged as invalid.`;
}
