export interface SearchResult {
	title: string;
	url: string;
	content: string; // cleaned text/snippet, not raw HTML
}

export interface SearchOptions {
	// Both are hard filters, not general quality tuning — for known-bad
	// sources (excludeDomains) or scoping to a specific set of known-good
	// ones (includeDomains, e.g. bookseller/library-catalog sites likely to
	// carry a real table of contents). Support is provider-specific; a
	// provider that can't honor either should just ignore it, not error.
	excludeDomains?: string[];
	includeDomains?: string[];
}

export interface SearchProvider {
	search(query: string, maxResults?: number, options?: SearchOptions): Promise<SearchResult[]>;
}
