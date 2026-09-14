import type { SearchOptions, SearchProvider, SearchResult } from './types';

const TAVILY_SEARCH_URL = 'https://api.tavily.com/search';

interface TavilyResultItem {
	title: string;
	url: string;
	content: string;
}

interface TavilyResponse {
	results: TavilyResultItem[];
}

export class TavilyProvider implements SearchProvider {
	constructor(private apiKey: string) {}

	async search(query: string, maxResults = 5, options?: SearchOptions): Promise<SearchResult[]> {
		const res = await fetch(TAVILY_SEARCH_URL, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Authorization: `Bearer ${this.apiKey}`,
			},
			body: JSON.stringify({
				query,
				max_results: maxResults,
				search_depth: 'basic',
				...(options?.excludeDomains?.length ? { exclude_domains: options.excludeDomains } : {}),
				...(options?.includeDomains?.length ? { include_domains: options.includeDomains } : {}),
			}),
		});

		if (!res.ok) {
			const body = await res.text().catch(() => '');
			throw new Error(`Tavily search failed (${res.status} ${res.statusText}): ${body}`);
		}

		const data = (await res.json()) as TavilyResponse;
		if (!Array.isArray(data.results)) {
			throw new Error(`Tavily search returned an unexpected response shape: ${JSON.stringify(data)}`);
		}
		return data.results.map((r) => ({
			title: r.title,
			url: r.url,
			content: r.content,
		}));
	}
}
