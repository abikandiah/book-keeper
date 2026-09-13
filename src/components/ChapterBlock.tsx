interface Chapter {
	number: number;
	title: string;
	key_points: string[];
	core_claim: string;
}

export function ChapterBlock({ chapter }: { chapter: Chapter }) {
	return (
		<section className="chapter-block">
			<div className="chapter-heading">
				<span className="chapter-number">{String(chapter.number).padStart(2, '0')}</span>
				<h3 className="chapter-title">{chapter.title}</h3>
			</div>
			<blockquote className="chapter-claim">{chapter.core_claim}</blockquote>
			<ul className="chapter-points">
				{chapter.key_points.map((point, i) => (
					<li key={i}>{point}</li>
				))}
			</ul>
		</section>
	);
}
