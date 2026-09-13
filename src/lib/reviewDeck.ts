// Pure deck-building logic, kept out of ReviewDeck.tsx so it's plain
// TypeScript (no JSX/React) — this is the piece that's been re-verified by
// hand against synthetic data (a 40-book/354-card pool) each time it
// changed; a plain module is what actually makes that verification
// automatable later instead of staying manual forever.
import type { ReviewCard } from '../components/ReviewDeck';

const LAST_REVIEWED_KEY = 'book-keeper:last-reviewed';
// Ceiling on how many cards a single session ever shows, regardless of how
// many books are in the library. Without this, the all-books deck grows
// unbounded with the library (500+ cards at 50+ books) — no real "session,"
// just an endless grab-bag, and a progress counter reading "1 of 847."
export const DECK_CAP = 30;

export function shuffle<T>(items: T[]): T[] {
	const result = [...items];
	for (let i = result.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		[result[i], result[j]] = [result[j], result[i]];
	}
	return result;
}

export function readLastReviewed(): Record<string, string> {
	try {
		const raw = localStorage.getItem(LAST_REVIEWED_KEY);
		if (!raw) return {};
		const parsed = JSON.parse(raw);
		// JSON.parse("null") / a stored array or primitive all parse without
		// throwing, so the catch below doesn't cover them — without this
		// check, a non-object result (e.g. literally `null`) reaches
		// buildDeck's `lastReviewed[a]` lookup and throws (can't index into
		// null), crashing the whole component with no error boundary.
		return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
	} catch {
		// Malformed stored value — treat as empty rather than refuse to ever
		// read/write again (a bad value here would otherwise permanently
		// block every future write, since it never gets the chance to be
		// overwritten with something valid).
		return {};
	}
}

export function writeLastReviewed(bookSlug: string) {
	// Re-reads fresh rather than reusing anything cached in memory — this is
	// a deliberate choice, not the oversight it might look like: a stale
	// in-memory copy would only widen the (already small, single-user-tool)
	// window for two tabs' writes to clobber each other, not narrow it.
	const data = readLastReviewed();
	data[bookSlug] = new Date().toISOString();
	try {
		localStorage.setItem(LAST_REVIEWED_KEY, JSON.stringify(data));
	} catch {
		// Storage access/write can throw (private browsing, quota, etc.) —
		// the deck still works for this visit, it just won't persist.
	}
}

// Builds the deck a session actually shows: cards grouped by book, books
// ordered by staleness (never-reviewed books first, then oldest-reviewed),
// then one card pulled from each book in turn — round-robin, not a flat
// random sample — until the cap is reached or the pool runs out. A flat
// random sample over individual cards would be biased toward whichever
// books happen to have more claims (a 15-claim book is 3x more likely to
// appear than a 5-claim one on any given draw); round-robin-by-book
// guarantees every book gets a card before any book gets a second one.
export function buildDeck(cards: ReviewCard[], cap: number): ReviewCard[] {
	const lastReviewed = readLastReviewed();

	const byBook = new Map<string, ReviewCard[]>();
	for (const card of shuffle(cards)) {
		const list = byBook.get(card.bookSlug);
		if (list) list.push(card);
		else byBook.set(card.bookSlug, [card]);
	}

	const bookSlugs = [...byBook.keys()];
	// Precomputed once per book rather than re-parsed on every comparison
	// the sort makes, and normalized to 0 for anything that doesn't parse
	// to a real date (missing entry, or a corrupted stored value) — without
	// the NaN guard, a corrupted entry makes `NaN - x` comparisons, which
	// sort() treats as "equal," so that book's position becomes whatever
	// the engine's sort happens to leave it at rather than "never reviewed."
	const staleness = new Map(
		bookSlugs.map((slug) => {
			const parsed = lastReviewed[slug] ? new Date(lastReviewed[slug]).getTime() : NaN;
			return [slug, Number.isNaN(parsed) ? 0 : parsed];
		}),
	);
	bookSlugs.sort((a, b) => staleness.get(a)! - staleness.get(b)!);

	// The cap only makes sense once there's more than one book to ration
	// cards across. On /review/[slug] `cards` is a single book's claims, and
	// that book's own "Test yourself on N key claims" count (shown on the
	// book page) already promises every one of them — capping there would
	// silently truncate below that promise instead of just rationing across
	// a shared session budget.
	const effectiveCap = bookSlugs.length > 1 ? cap : Infinity;

	// Bounded by the most claims any single book has, rather than a
	// sentinel "did this round add anything" flag — the loop's exit
	// condition is then a plain fact about the data, not something that
	// has to be inferred from watching what happened last iteration.
	const maxClaimsPerBook = Math.max(0, ...bookSlugs.map((slug) => byBook.get(slug)!.length));
	const deck: ReviewCard[] = [];
	for (let round = 0; round < maxClaimsPerBook && deck.length < effectiveCap; round++) {
		for (const slug of bookSlugs) {
			if (deck.length >= effectiveCap) break;
			const list = byBook.get(slug)!;
			if (round < list.length) deck.push(list[round]);
		}
	}

	return deck;
}
