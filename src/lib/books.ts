import type { CollectionEntry } from 'astro:content';

export function sortByDateAddedDesc(a: CollectionEntry<'books'>, b: CollectionEntry<'books'>): number {
	return new Date(b.data.date_added).getTime() - new Date(a.data.date_added).getTime();
}
