// Shown wherever a book's `isbn` didn't resolve to a cover — keeps list rows
// and the book page visually consistent (same box dimensions as a real
// cover) instead of the layout shifting depending on whether a cover
// happened to be found. Reuses the same `.book-cover`/`.book-cover-lg` box
// dimensions as a real cover image.
export function CoverPlaceholder({ size }: { size: 'sm' | 'lg' }) {
	return (
		<span
			className={`book-cover-placeholder ${size === 'lg' ? 'book-cover-lg' : 'book-cover'}`}
			aria-hidden="true"
		>
			<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
				<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
				<path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2Z" />
			</svg>
		</span>
	);
}
