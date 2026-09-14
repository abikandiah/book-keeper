import pLimit from 'p-limit';

import type { SearchProvider, SearchResult } from '../types';
import { googleCseSearch } from './client';
import { extractPageText } from './extract';

// Independent of generate-book.ts's CHAPTER_CONCURRENCY — this caps
// concurrent page fetches *within* a single search() call, nested under
// however many chapters are already running in parallel. Kept small since
// it's fetching arbitrary third-party sites, not our own LLM provider.
const EXTRACTION_CONCURRENCY = 3;

// Composes the raw API client (client.ts) with best-effort page-content
// extraction (extract.ts) to close the gap between Google CSE's thin
// meta-description snippets and Tavily's cleaned content extraction. Only
// this file touches the SearchProvider/SearchResult contract — client.ts
// and extract.ts are internal plumbing.
export class GoogleCseProvider implements SearchProvider {
	constructor(
		private apiKey: string,
		private cx: string,
	) {}

	async search(query: string, maxResults = 5): Promise<SearchResult[]> {
		const results = await googleCseSearch(this.apiKey, this.cx, query, maxResults);

		// Created fresh per call, not as a shared instance field: this
		// provider is a single long-lived instance for the whole generation
		// run, so a shared limiter would cap extraction at EXTRACTION_CONCURRENCY
		// project-wide instead of per search() call as intended (see the
		// comment above), badly over-serializing the concurrent chapter
		// fan-out's search calls.
		const extractLimit = pLimit(EXTRACTION_CONCURRENCY);

		return Promise.all(
			results.map((result) =>
				extractLimit(async (): Promise<SearchResult> => {
					const extracted = await extractPageText(result.url);
					const content = extracted && extracted.length > result.snippet.length ? extracted : result.snippet;
					return { title: result.title, url: result.url, content };
				}),
			),
		);
	}
}
