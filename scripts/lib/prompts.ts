import type { Outline } from '../../src/content/schema';
import type { SearchResult } from '../search/types';

export function formatSearchResults(results: SearchResult[]): string {
	if (results.length === 0) return '(no search results found)';
	return results
		.map((r, i) => `[${i + 1}] ${r.title} (${r.url})\n${r.content}`)
		.join('\n\n');
}

// Shared by buildOutlinePrompt and buildOutlineConsensusPrompt — both thread
// reader-confirmed --known facts into their prompt as a labeled block the
// model shouldn't second-guess. Returns '' (nothing rendered) when no field
// is present, so call sites can always splice this in unconditionally.
function formatConfirmedFacts(knownFacts?: { title?: string; author?: string; year?: number }): string {
	const lines = [
		knownFacts?.title ? `- Title: ${knownFacts.title}` : null,
		knownFacts?.author ? `- Author: ${knownFacts.author}` : null,
		knownFacts?.year ? `- Publication year: ${knownFacts.year}` : null,
	].filter((line): line is string => line !== null);
	if (lines.length === 0) return '';
	return `\nThe reader has already confirmed these facts directly — treat them as certain, do not second-guess or override them from other evidence below:\n${lines.join('\n')}\n`;
}

export function buildOutlinePrompt(
	title: string,
	results: SearchResult[],
	knownFacts?: { author?: string; year?: number },
): string {
	return `You are researching the non-fiction book "${title}" to build a structured summary.
${formatConfirmedFacts(knownFacts)}
Here is what web search turned up about this book:

${formatSearchResults(results)}

Based on this, determine:
- The book's author (full name)${knownFacts?.author ? ' — already confirmed above' : ''}
- The publication year${knownFacts?.year ? ' — already confirmed above' : ''}
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
- key_points: 1-10 concise bullet points covering what this chapter actually argues or covers — most chapters need far fewer than 10, but don't compress a genuinely dense chapter (e.g. a textbook chapter) down to fit an artificially low count
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

export interface OutlineCandidate {
	label: string;
	outline: Outline;
	results: SearchResult[];
}

export function buildOutlineConsensusPrompt(
	title: string,
	candidates: OutlineCandidate[],
	knownFacts?: { title?: string; author?: string; year?: number },
): string {
	const rendered = candidates
		.map((c, i) => {
			const o = c.outline;
			return (
				`Candidate ${i + 1} — from ${c.label}:\n` +
				`Title: ${o.title}${o.author ? `\nAuthor: ${o.author}` : ''}${o.year ? `\nYear: ${o.year}` : ''}\n` +
				`Chapter list (${o.chapter_titles.length}):\n${o.chapter_titles.map((t, j) => `  ${j + 1}. ${t}`).join('\n')}\n\n` +
				`Search results this candidate was drafted from:\n${formatSearchResults(c.results)}`
			);
		})
		.join('\n\n---\n\n');

	return `You are reconciling ${candidates.length} independently-researched candidate
chapter lists for the non-fiction book "${title}" — each drafted from a
different search strategy (general web, bookseller listings, library
catalogs), so they may disagree.
${formatConfirmedFacts(knownFacts)}
${rendered}

Determine the single, correct, real chapter/section list as actually
published, along with the author and publication year. Read each
candidate's own search results, not just its drafted list — a candidate's
draft can misread or omit chapters that were actually present in its own
search results, and two candidates can independently reach a similar-looking
but still-wrong list if their sources are both thin. Prefer whichever
candidates' actual source material agrees, not just whichever drafted lists
happen to look similar. A lone outlier — especially one far shorter than the
others, which often means it's missing chapters or mistaking front matter
(foreword, introduction, preface) for real ones — should generally be
distrusted unless its own search results are clearly more complete/specific
than the rest. A candidate with empty or near-empty search results just
means that search strategy found nothing useful for this book — ignore it
rather than treating it as evidence the book is short.

Return:
- title, author, year
- chapter_titles: the reconciled, real chapter list, in order
- agreement: "unanimous" if the candidates with real data agreed, "majority" if most did, "split" if there was no clear consensus
- notes: brief reasoning — required unless agreement is "unanimous"`;
}

export function buildChapterCritiquePrompt(
	bookTitle: string,
	chapterTitle: string,
	chapter: { key_points: string[]; core_claim: string },
	results: SearchResult[],
): string {
	return `You are fact-checking a drafted chapter summary for the non-fiction book
"${bookTitle}", chapter "${chapterTitle}".

Drafted summary:
- core_claim: ${chapter.core_claim}
- key_points:
${chapter.key_points.map((p) => `  - ${p}`).join('\n')}

Here is what web search turned up about this chapter (may be thin):

${formatSearchResults(results)}

Judge only whether this summary is fabricated or contradicted by the search
results — a specific claim invented outright, or one the search results
directly dispute. Writing style, genericness, or how thoroughly it covers
the chapter are NOT grounds to flag it; those are subjective judgment calls,
out of scope here. Thin search results are common and expected (chapter-
level web coverage is often sparse) — a summary that leans on general
knowledge of the book rather than the search snippets is fine, not a
violation.

Return:
- plausible: true unless there's a specific fabricated or contradicted claim
- concerns: the specific fabricated/contradicted claim(s) if not plausible (empty array if plausible)`;
}

export function buildRepairPrompt(previousOutput: unknown, errors: string[]): string {
	return `Your previous output failed schema validation.

Previous output:
${JSON.stringify(previousOutput, null, 2)}

Validation errors:
${errors.join('\n')}

Fix these specific issues and return corrected output matching the schema. Keep everything else from your previous output that wasn't flagged as invalid.`;
}
