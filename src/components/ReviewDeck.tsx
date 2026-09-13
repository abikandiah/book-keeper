import { useEffect, useState } from 'react';
import { Button } from '@abumble/design-system/components/Button';
import { DECK_CAP, buildDeck, writeLastReviewed } from '../lib/reviewDeck';

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

function readHintSeen(): boolean {
	try {
		return sessionStorage.getItem(HINT_SEEN_KEY) === '1';
	} catch {
		return false;
	}
}

function writeHintSeen() {
	try {
		sessionStorage.setItem(HINT_SEEN_KEY, '1');
	} catch {
		// Storage access can throw — the hint just won't stay dismissed
		// across a page nav this particular visit, not a functional loss.
	}
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
	// Tracks whether the reader has ever flipped a card this browser
	// session, so the "click to reveal" hint teaches the gesture once and
	// then gets out of the way — seeded from sessionStorage (not plain
	// useState(false)) so navigating away and back doesn't reset it and
	// bring the hint back; sessionStorage is exactly the "once per tab
	// session" persistence layer this calls for, unlike localStorage
	// (which would make it "once ever, forever," a different guarantee).
	const [hasFlippedOnce, setHasFlippedOnce] = useState(readHintSeen);

	// Deliberately empty deps — cards is static page data for this
	// component's whole lifetime, this should only ever run once on mount.
	useEffect(() => {
		setOrder(buildDeck(cards, DECK_CAP));
	}, []);

	function advance(direction: 1 | -1) {
		if (!order) return;
		// Marks the card you're leaving as reviewed even if you never
		// flipped it — without this, skimming a deck via Next/Prev alone
		// never updates any book's staleness, so buildDeck's round-robin
		// keeps treating those books as untouched forever despite real
		// engagement.
		writeLastReviewed(order[index].bookSlug);
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
		}
		if (!hasFlippedOnce) {
			writeHintSeen();
		}
		setFlipped((f) => !f);
		setHasFlippedOnce(true);
	}

	function handleCardKeyDown(e: React.KeyboardEvent) {
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
				{!flipped && !hasFlippedOnce && <p className="review-card-hint">Click to reveal</p>}
				{/* Wrapper stays mounted (rather than the answer <p> appearing/
				    disappearing on its own) so assistive tech already tracking
				    this live region actually announces the answer when it's
				    revealed — a region created fresh at the same instant its
				    content appears isn't reliably announced by screen readers. */}
				<div aria-live="polite">{flipped && <p className="review-card-answer">{card.answer}</p>}</div>
			</div>
			<div className="review-controls">
				<Button variant="outline" size="icon-lg" aria-label="Previous card" onClick={prev}>
					<span className="review-nav-arrow" aria-hidden="true">
						←
					</span>
				</Button>
				<Button variant="default" onClick={toggleFlip}>
					{flipped ? 'Hide answer' : 'Show answer'}
				</Button>
				<Button variant="outline" size="icon-lg" aria-label="Next card" onClick={next}>
					<span className="review-nav-arrow" aria-hidden="true">
						→
					</span>
				</Button>
			</div>
		</div>
	);
}
