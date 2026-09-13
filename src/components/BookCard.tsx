import { Badge } from '@abumble/design-system/components/Badge';
import { coverUrl } from '../lib/covers';
import { CoverPlaceholder } from './CoverPlaceholder';
import { TagPill } from './TagPill';

interface BookCardProps {
	slug: string;
	title: string;
	author: string;
	year?: number;
	isbn?: string;
	tags: string[];
	oneLineTakeaway: string;
	verified: boolean;
}

// Renders as a compact list row, not a boxed card — see Part 3's "Listing
// layout" note. The whole row is a click target for the book page via a
// stretched-link overlay (`.book-row-link::after`); the tag pills sit above
// that overlay (`.book-row-tags` z-index) so they stay independently
// clickable without nesting an <a> inside the row's <a>.
export function BookCard({ slug, title, author, year, isbn, tags, oneLineTakeaway, verified }: BookCardProps) {
	const cover = coverUrl(isbn, 'M');

	return (
		<li className="book-row">
			<div className="book-row-inner">
				{cover ? (
					<img src={cover} alt="" className="book-cover" width={36} height={54} loading="lazy" />
				) : (
					<CoverPlaceholder size="sm" />
				)}
				<div className="book-row-main">
					<div className="book-row-title-line">
						<a href={`/books/${slug}`} className="book-row-link">
							{title}
						</a>
						<span className="book-row-meta">
							{author}
							{year ? `, ${year}` : ''}
						</span>
						{verified && (
							<Badge variant="success" className="verified-badge">
								Verified
							</Badge>
						)}
					</div>
					<p className="book-row-takeaway">{oneLineTakeaway}</p>
					<div className="book-row-tags">
						{tags.map((tag) => (
							<TagPill key={tag} tag={tag} />
						))}
					</div>
				</div>
			</div>
		</li>
	);
}
