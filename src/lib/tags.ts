// Tags are stored lowercase-kebab (e.g. "decision-making") per Part 1's
// schema note — this is purely a display transform for headings/titles;
// the stored value and the /tags/[tag] URL stay lowercase-kebab.
export function formatTagLabel(tag: string): string {
	return tag
		.split('-')
		.map((word) => word.charAt(0).toUpperCase() + word.slice(1))
		.join(' ');
}
