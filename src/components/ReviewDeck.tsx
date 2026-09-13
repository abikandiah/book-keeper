import { useEffect, useState } from 'react';
import { Button } from '@abumble/design-system/components/Button';

export interface ReviewCard {
	prompt: string;
	answer: string;
	bookTitle: string;
}

interface ReviewDeckProps {
	cards: ReviewCard[];
	// Whole-library review shuffles across books, so each card needs its
	// source book visible — otherwise a prompt with no context is
	// disorienting. A single-book deck already has that context from the
	// page it's on, so it stays out of the card itself.
	showSource: boolean;
	// Only set for a single-book deck (/review/[slug]) — writes a
	// last-reviewed timestamp for that one book. The all-books deck doesn't
	// map cleanly onto "reviewed book X," so it skips this entirely rather
	// than guessing which books count as "reviewed" from a partial pass.
	trackSlug?: string;
}

const LAST_REVIEWED_KEY = 'book-keeper:last-reviewed';

function shuffle<T>(items: T[]): T[] {
	const result = [...items];
	for (let i = result.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		[result[i], result[j]] = [result[j], result[i]];
	}
	return result;
}

export function ReviewDeck({ cards, showSource, trackSlug }: ReviewDeckProps) {
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

	// Deliberately empty deps — cards is static page data for this
	// component's whole lifetime, this should only ever run once on mount.
	useEffect(() => {
		setOrder(shuffle(cards));
	}, []);

	useEffect(() => {
		if (!trackSlug) return;

		// Read+parse is separated from the write below so a malformed stored
		// value only costs this one record, not persistence forever — parsing
		// inside the same try as the write meant a single corrupt value
		// permanently blocked every future write for every book, since the
		// bad value was never overwritten and would fail to parse again on
		// every subsequent visit.
		let data: Record<string, string> = {};
		try {
			const raw = localStorage.getItem(LAST_REVIEWED_KEY);
			data = raw ? JSON.parse(raw) : {};
		} catch {
			// Malformed value — start fresh rather than refuse to ever write.
		}

		data[trackSlug] = new Date().toISOString();

		try {
			localStorage.setItem(LAST_REVIEWED_KEY, JSON.stringify(data));
		} catch {
			// Storage access/write can throw (private browsing, quota, etc.) —
			// the deck still works for this visit, it just won't persist.
		}
	}, [trackSlug]);

	if (order === null) {
		// Not yet shuffled client-side — .review-card's own min-height holds
		// the layout steady until the real deck replaces this.
		return <div className="review-card" aria-hidden="true" />;
	}

	if (order.length === 0) {
		return <p className="review-empty">No key claims to review yet.</p>;
	}

	const total = order.length;
	const card = order[index];

	function toggleFlip() {
		setFlipped((f) => !f);
	}

	function next() {
		setFlipped(false);
		setIndex((i) => (i + 1) % total);
	}

	function handleCardKeyDown(e: React.KeyboardEvent) {
		if (e.key === 'Enter' || e.key === ' ') {
			e.preventDefault();
			toggleFlip();
		}
	}

	return (
		<div className="review-deck">
			<p className="review-progress">
				{index + 1} of {total}
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
				{/* Wrapper stays mounted (rather than the answer <p> appearing/
				    disappearing on its own) so assistive tech already tracking
				    this live region actually announces the answer when it's
				    revealed — a region created fresh at the same instant its
				    content appears isn't reliably announced by screen readers. */}
				<div aria-live="polite">{flipped && <p className="review-card-answer">{card.answer}</p>}</div>
			</div>
			<div className="review-controls">
				<Button variant="outline" onClick={toggleFlip}>
					{flipped ? 'Hide answer' : 'Show answer'}
				</Button>
				<Button onClick={next}>Next →</Button>
			</div>
		</div>
	);
}
