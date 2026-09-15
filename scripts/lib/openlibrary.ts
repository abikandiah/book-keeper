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
	subject?: string[];
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

interface OpenLibraryBookData {
	title?: string;
	authors?: { name: string }[];
	publish_date?: string;
	number_of_pages?: number;
}

// Forward lookup: isbn -> Open Library's edition record. Used two ways: to
// pull page_count once an isbn is known (either user-supplied via --isbn or
// found by lookupIsbn's reverse search below), and, when the user supplies
// --isbn upfront, to resolve this specific edition's own title/author so
// generation searches target the exact published work rather than however
// the reader happened to phrase the CLI title.
export async function lookupEditionByIsbn(
	isbn: string,
): Promise<{ title?: string; author?: string; year?: number; pageCount?: number } | undefined> {
	try {
		const params = new URLSearchParams({ bibkeys: `ISBN:${isbn}`, format: 'json', jscmd: 'data' });
		const { response: res, clear } = await fetchWithTimeout(
			`https://openlibrary.org/api/books?${params.toString()}`,
			{},
			LOOKUP_TIMEOUT_MS,
		);
		let data: Record<string, OpenLibraryBookData>;
		try {
			if (!res.ok) return undefined;
			data = (await res.json()) as Record<string, OpenLibraryBookData>;
		} finally {
			clear();
		}

		const record = data[`ISBN:${isbn}`];
		if (!record) return undefined;

		const yearMatch = record.publish_date?.match(/\d{4}/);
		return {
			title: record.title,
			author: record.authors?.[0]?.name,
			year: yearMatch ? Number(yearMatch[0]) : undefined,
			pageCount: record.number_of_pages,
		};
	} catch {
		return undefined;
	}
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

// Library call numbers (e.g. "Cb113.h4 h3713 2015") and raw Dewey/BISAC
// numeric codes (e.g. "599.9", "Sci027000 sci086000 sci000000") show up in
// Open Library's raw `subject` field alongside genuinely useful topic
// labels — neither means anything to an LLM prompt, so both are dropped
// rather than passed through. Detected as "every space-separated token
// contains a digit" rather than a single regex: an earlier regex-based
// version (`/^[a-z]{0,4}[\d.]+[a-z\d. ]*$/i`) also matched real, useful
// subjects like "20th century" and "19th century literature" (confirmed
// directly) — a plain word like "century" or "literature" never has a digit
// in it, so requiring every token to have one keeps those while still
// catching "599.9", "Cb113.h4 h3713 2015", and "Sci027000 sci086000
// sci000000" (every token in each of those does contain a digit).
function looksLikeCatalogCode(subject: string): boolean {
	const tokens = subject.split(/\s+/);
	return tokens.length > 0 && tokens.every((token) => /\d/.test(token));
}

const MAX_SUBJECTS = 15;

// Supplementary grounding only, never authoritative: the caller still picks
// `tags` from a closed vocabulary (NONFICTION_TAGS/FICTION_TAGS in
// src/content/schema.ts), this just gives the model real catalog signal to
// weigh instead of guessing blind.
// Same never-throws/undefined-on-failure posture as lookupIsbn — a missing or
// failed lookup just means synthesis proceeds without this hint.
export async function lookupSubjects(title: string, author?: string): Promise<string[] | undefined> {
	try {
		const params = new URLSearchParams({ title, limit: '5', fields: 'title,isbn,subject' });
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
			(doc) => Array.isArray(doc.subject) && doc.subject.length > 0 && titlesMatch(title, doc.title, Boolean(author)),
		);
		if (!match?.subject) return undefined;

		const seen = new Set<string>();
		const cleaned: string[] = [];
		for (const raw of match.subject) {
			const subject = raw.trim();
			const isAscii = [...subject].every((ch) => ch.charCodeAt(0) < 128);
			if (!subject || !isAscii || subject.includes(':') || looksLikeCatalogCode(subject)) continue;
			const key = subject.toLowerCase();
			if (seen.has(key)) continue;
			seen.add(key);
			cleaned.push(subject);
			if (cleaned.length >= MAX_SUBJECTS) break;
		}
		return cleaned.length > 0 ? cleaned : undefined;
	} catch {
		return undefined;
	}
}
