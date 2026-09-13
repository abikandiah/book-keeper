// Cover-image URLs are derived from an `isbn`, resolved once during
// generation (Part 2) and stored on the book itself — see Part 1's schema
// note. Deriving the URL here, rather than storing it, keeps this the one
// place a future change to the cover source has to touch.
const OPEN_LIBRARY_COVERS = 'https://covers.openlibrary.org/b/isbn';

export type CoverSize = 'S' | 'M' | 'L';

export function coverUrl(isbn: string | undefined, size: CoverSize): string | undefined {
	return isbn ? `${OPEN_LIBRARY_COVERS}/${isbn}-${size}.jpg` : undefined;
}
