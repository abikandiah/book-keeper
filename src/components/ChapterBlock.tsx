interface Chapter {
	number: number;
	title: string;
	key_points: string[];
	core_claim: string;
}

// Collapsed by default (native <details>, no client JS) — with 6+ chapters
// the fully-expanded list was too much to scroll through just to find one
// chapter. Collapsed, the number + title still line up as a scannable
// table of contents.
export function ChapterBlock({ chapter }: { chapter: Chapter }) {
	return (
		<details className="chapter-block">
			<summary className="chapter-heading collapsible-summary">
				<span className="chapter-number">{String(chapter.number).padStart(2, '0')}</span>
				<h3 className="chapter-title">{chapter.title}</h3>
			</summary>
			<div className="chapter-detail">
				<blockquote className="chapter-claim">{chapter.core_claim}</blockquote>
				<ul className="chapter-points">
					{chapter.key_points.map((point, i) => (
						<li key={i}>{point}</li>
					))}
				</ul>
			</div>
		</details>
	);
}
