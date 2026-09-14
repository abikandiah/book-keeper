// Not part of the SearchProvider abstraction (scripts/search/) — that
// interface returns snippets for an LLM to read as grounding context.
// This is a direct, structured lookup against Open Library's own search API
// for a specific field (ISBN), consumed straight in code with no LLM
// involved. Never throws, and never hangs indefinitely: a missing/failed/
// slow cover lookup should never block or break book generation, so any
// failure (including a timeout) just resolves to `undefined`.

import { fetchWithTimeout } from './fetch-timeout';

const LOOKUP_TIMEOUT_MS = 8000;

interface OpenLibrarySearchDoc {
	title?: string;
	isbn?: string[];
}

interface OpenLibrarySearchResponse {
	docs?: OpenLibrarySearchDoc[];
}

// NFKD-decompose + strip combining marks, matching scripts/generate-book.ts's
// `slugify()` — without this, an accented queried title (e.g. "Über den
// Umgang") and an ASCII-spelled Open Library title for the same book ("Uber
// den Umgang") normalize to different strings ("ber den umgang" vs "uber den
// umgang": stripping "ü" as if it were punctuation deletes it instead of
// transliterating to "u"), and both branches of titlesMatch below fail on a
// legitimate match.
function normalizeTitle(value: string): string {
	return value
		.toLowerCase()
		.normalize('NFKD')
		.replace(/[\u0300-\u036f]/g, '') // strip combining diacritics after NFKD decomposition
		.replace(/[^a-z0-9]+/g, ' ')
		.trim();
}

// Below this length a title is too short/generic for a prefix match to be
// safe when the search wasn't also scoped by author — e.g. "It" is a
// legitimate word-boundary prefix of "It Governance for Dummies" and
// countless other unrelated titles. Below the threshold, only an exact
// match is accepted, *unless* an author was supplied (see `titlesMatch`).
const MIN_PREFIX_MATCH_LENGTH = 12;

// Loose on purpose: Open Library titles frequently differ from the queried
// title by a subtitle (e.g. "Fooled by Randomness" vs "Fooled by randomness:
// the hidden role of chance..."), so exact equality would reject too many
// real matches. A word-boundary prefix match (not a raw substring prefix —
// that would also match "Italian Cooking" against "It") catches the
// subtitle case while still rejecting an unrelated book that merely shares
// a leading word.
//
// `authorProvided` relaxes the length floor entirely: `lookupIsbn` passes
// `author` straight into the Open Library query as its own filter param, so
// a result reaching this function already matched on author server-side —
// a short *and* single-word title like "Educated" (8 chars, under
// MIN_PREFIX_MATCH_LENGTH) prefix-matching "Educated: A Memoir" is safe once
// the author is already known to match; it's only a real ambiguity risk in
// an unscoped, title-only search. Confirmed the length floor alone was
// wrong: it rejected "Educated" vs "Educated: A Memoir" outright even
// though the word-boundary check already accepted it.
function titlesMatch(queried: string, candidate: string | undefined, authorProvided: boolean): boolean {
	if (!candidate) return false;
	const a = normalizeTitle(queried);
	const b = normalizeTitle(candidate);
	if (a.length === 0 || b.length === 0) return false;
	if (a === b) return true;
	const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
	if (!longer.startsWith(`${shorter} `)) return false;
	return authorProvided || shorter.length >= MIN_PREFIX_MATCH_LENGTH;
}

export async function lookupIsbn(title: string, author?: string): Promise<string | undefined> {
	try {
		// `fields` is required explicitly — Open Library's default response
		// shape omits `isbn` (and everything else not listed) entirely
		// otherwise, confirmed directly against the live API; it's not
		// documented as opt-in anywhere obvious. `title` is requested too, so
		// the match can be verified below rather than trusting result order.
		const params = new URLSearchParams({ title, limit: '5', fields: 'title,isbn' });
		if (author) params.set('author', author);

		const { response: res, clear } = await fetchWithTimeout(
			`https://openlibrary.org/search.json?${params.toString()}`,
			{},
			LOOKUP_TIMEOUT_MS,
		);
		let data: OpenLibrarySearchResponse;
		try {
			if (!res.ok) return undefined;
			data = (await res.json()) as OpenLibrarySearchResponse;
		} finally {
			clear();
		}
		const match = data.docs?.find(
			(doc) => Array.isArray(doc.isbn) && doc.isbn.length > 0 && titlesMatch(title, doc.title, Boolean(author)),
		);
		return match?.isbn?.[0];
	} catch {
		return undefined;
	}
}
