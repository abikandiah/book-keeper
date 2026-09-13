// Not part of the SearchProvider abstraction (scripts/search/) — that
// interface returns snippets for an LLM to read as grounding context.
// This is a direct, structured lookup against Open Library's own search API
// for a specific field (ISBN), consumed straight in code with no LLM
// involved. Never throws, and never hangs indefinitely: a missing/failed/
// slow cover lookup should never block or break book generation, so any
// failure (including a timeout) just resolves to `undefined`.

const LOOKUP_TIMEOUT_MS = 8000;

interface OpenLibrarySearchDoc {
	title?: string;
	isbn?: string[];
}

interface OpenLibrarySearchResponse {
	docs?: OpenLibrarySearchDoc[];
}

function normalizeTitle(value: string): string {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, ' ')
		.trim();
}

// Loose on purpose: Open Library titles frequently differ from the queried
// title by a subtitle (e.g. "Fooled by Randomness" vs "Fooled by randomness:
// the hidden role of chance..."), so exact equality would reject too many
// real matches. A prefix match in either direction catches that case while
// still rejecting an unrelated book that merely shares a word — the actual
// risk this guards against.
function titlesMatch(queried: string, candidate: string | undefined): boolean {
	if (!candidate) return false;
	const a = normalizeTitle(queried);
	const b = normalizeTitle(candidate);
	return a.length > 0 && b.length > 0 && (a === b || a.startsWith(b) || b.startsWith(a));
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

		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), LOOKUP_TIMEOUT_MS);
		let res: Response;
		try {
			res = await fetch(`https://openlibrary.org/search.json?${params.toString()}`, {
				signal: controller.signal,
			});
		} finally {
			clearTimeout(timeout);
		}
		if (!res.ok) return undefined;

		const data = (await res.json()) as OpenLibrarySearchResponse;
		const match = data.docs?.find(
			(doc) => Array.isArray(doc.isbn) && doc.isbn.length > 0 && titlesMatch(title, doc.title),
		);
		return match?.isbn?.[0];
	} catch {
		return undefined;
	}
}
