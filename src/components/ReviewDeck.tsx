import { useEffect, useState } from 'react';
import { DECK_CAP, buildDeck, safeStorageGet, safeStorageSet, writeLastReviewed } from '../lib/reviewDeck';

export interface ReviewCard {
	prompt: string;
	answer: string;
	bookTitle: string;
	bookSlug: string;
}

interface ReviewDeckProps {
	cards: ReviewCard[];
	// Whole-library review shuffles across books, so each card needs its
	// source book visible — otherwise a prompt with no context is
	// disorienting. A single-book deck already has that context from the
	// page it's on, so it stays out of the card itself.
	showSource: boolean;
}

const HINT_SEEN_KEY = 'book-keeper:review-hint-seen';

// sessionStorage, not localStorage — "seen this tab session" is what the
// "click to reveal" hint's dismissal is supposed to mean; localStorage
// would make it "seen once, ever," a different (and wrong) guarantee.
// Read directly at render time rather than mirrored into React state: every
// path that can change whether the hint should show (flipping a card,
// which calls writeHintSeen below) already re-renders via setFlipped, so a
// second piece of state just for this would only be a second place for the
// hint's visibility and the underlying storage value to drift apart.
function readHintSeen(): boolean {
	return safeStorageGet('session', HINT_SEEN_KEY) === '1';
}

function writeHintSeen() {
	safeStorageSet('session', HINT_SEEN_KEY, '1');
}

export function ReviewDeck({ cards, showSource }: ReviewDeckProps) {
	// Starts `null` (identical on the server-rendered HTML and the first
	// client render, so no hydration mismatch) and only shuffles once
	// mounted, client-side only. Starting from the *unshuffled* cards array
	// instead of `null` would also avoid the mismatch, but would then mean
	// the very first thing a reader sees is one card's real prompt, which a
	// moment later gets silently swapped out for a different one once the
	// real shuffle lands — a visible content change, not just an invisible
	// reorder. Rendering nothing until the real order is ready avoids both
	// problems at once.
	const [order, setOrder] = useState<ReviewCard[] | null>(null);
	const [index, setIndex] = useState(0);
	const [flipped, setFlipped] = useState(false);

	// Deliberately empty deps — cards/showSource are static page data for
	// this component's whole lifetime, this should only ever run once on
	// mount. Only the all-books route (showSource) gets DECK_CAP applied;
	// see buildDeck's own comment for why that's decided here rather than
	// guessed from `cards`' shape inside buildDeck.
	useEffect(() => {
		setOrder(buildDeck(cards, showSource ? DECK_CAP : Infinity));
	}, []);

	function advance(direction: 1 | -1) {
		if (!order) return;
		// Deliberately does *not* write last-reviewed for the card being
		// left — flipping to see the answer is the actual act of reviewing
		// (testing recall), which is the entire point of the tool; merely
		// clicking through cards without flipping hasn't tested anything,
		// so it shouldn't count as "reviewed" for staleness purposes either.
		// (Reconsidered from an earlier version that wrote here too, on the
		// theory that skimming without flipping should still count as
		// engagement — decided that's the wrong signal: it would let a deck
		// be clicked through end-to-end with zero recall tested and still
		// look freshly reviewed.)
		setFlipped(false);
		setIndex((i) => (i + direction + order.length) % order.length);
	}

	const next = () => advance(1);
	const prev = () => advance(-1);

	function handleDeckKeyDown(e: React.KeyboardEvent) {
		// Modifier keys are left alone entirely (Alt+Left/Right is browser
		// back/forward in most browsers — without this guard we'd fire our
		// own navigation alongside it, not instead of it). Attaching this to
		// the deck wrapper (rather than a window-level listener) means it
		// only ever fires while focus is already somewhere inside the deck,
		// via ordinary DOM bubbling — no ref/activeElement bookkeeping
		// needed, and it can't intercept the arrow keys a screen reader's
		// own virtual-cursor browsing mode uses elsewhere on the page.
		if (e.altKey || e.ctrlKey || e.metaKey) return;
		// Auto-repeat while a key is held would otherwise call next()/prev()
		// once per repeat tick — each call writes a fresh last-reviewed
		// timestamp for whatever book is being left (see advance() above),
		// so holding the key for under a second could mark a dozen books
		// "just reviewed" without the reader having actually looked at any
		// of them, corrupting the staleness ordering the feature exists for.
		if (e.repeat) return;
		if (e.key === 'ArrowRight') {
			e.preventDefault();
			next();
		} else if (e.key === 'ArrowLeft') {
			e.preventDefault();
			prev();
		}
	}

	if (order === null) {
		// Not yet shuffled client-side — .review-card's own min-height holds
		// the layout steady until the real deck replaces this.
		return <div className="review-card" aria-hidden="true" />;
	}

	if (order.length === 0) {
		return <p className="review-empty">No key claims to review yet.</p>;
	}

	const card = order[index];

	function toggleFlip() {
		if (!flipped) {
			// Recorded on reveal, not on every toggle — hiding the answer again
			// isn't a second engagement with this book. This is also what now
			// feeds buildDeck's staleness ordering, so it fires here regardless
			// of which review page this is (previously only /review/[slug]
			// tracked anything at all).
			writeLastReviewed(card.bookSlug);
			writeHintSeen();
		}
		setFlipped((f) => !f);
	}

	function handleCardKeyDown(e: React.KeyboardEvent) {
		// Same auto-repeat guard as handleDeckKeyDown — holding Enter/Space
		// would otherwise flicker `flipped` open/closed on every repeat tick
		// and re-run writeLastReviewed each time.
		if (e.repeat) return;
		if (e.key === 'Enter' || e.key === ' ') {
			e.preventDefault();
			toggleFlip();
		}
	}

	return (
		<div className="review-deck" onKeyDown={handleDeckKeyDown}>
			<p className="review-progress">
				{index + 1} of {order.length}
			</p>
			<div
				className="review-card"
				role="button"
				tabIndex={0}
				aria-expanded={flipped}
				onClick={toggleFlip}
				onKeyDown={handleCardKeyDown}
			>
				{showSource && <p className="review-card-source">{card.bookTitle}</p>}
				<p className="review-card-prompt">{card.prompt}</p>
				{/* Teaches the click-to-flip gesture once, then gets out of the
				    way — reappearing on every single unflipped card would be
				    clutter once the reader already knows the card is clickable. */}
				{!flipped && !readHintSeen() && <p className="review-card-hint">Click to reveal</p>}
				{/* Wrapper stays mounted (rather than the answer <p> appearing/
				    disappearing on its own) so assistive tech already tracking
				    this live region actually announces the answer when it's
				    revealed — a region created fresh at the same instant its
				    content appears isn't reliably announced by screen readers. */}
				<div aria-live="polite">{flipped && <p className="review-card-answer">{card.answer}</p>}</div>
			</div>
			<div className="review-controls">
				{/* Plain buttons, not the design system's Button primitive — its
				    default/outline variants bring Tailwind's rounded corners,
				    shadow, and a solid --primary (orange) fill, which reads as a
				    different visual object next to .review-card's flat bordered-
				    box language. These match the card/banner treatment instead
				    (same border/hover-to-primary-border language as
				    .review-card and .review-banner) so the whole deck feels like
				    one continuous surface rather than a card with generic UI
				    chrome bolted on below it. */}
				<button type="button" className="review-control-btn review-nav-btn" aria-label="Previous card" onClick={prev}>
					<span aria-hidden="true">←</span>
				</button>
				<button type="button" className="review-control-btn review-flip-btn" onClick={toggleFlip}>
					{flipped ? 'Hide answer' : 'Show answer'}
				</button>
				<button type="button" className="review-control-btn review-nav-btn" aria-label="Next card" onClick={next}>
					<span aria-hidden="true">→</span>
				</button>
			</div>
		</div>
	);
}
