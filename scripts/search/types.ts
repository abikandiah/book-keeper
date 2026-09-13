export interface SearchResult {
	title: string;
	url: string;
	content: string; // cleaned text/snippet, not raw HTML
}

export interface SearchProvider {
	search(query: string, maxResults?: number): Promise<SearchResult[]>;
}
