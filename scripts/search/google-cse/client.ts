const GOOGLE_CSE_URL = 'https://www.googleapis.com/customsearch/v1';

export interface GoogleCseResult {
	title: string;
	url: string;
	snippet: string;
}

interface GoogleCseApiItem {
	title: string;
	link: string;
	snippet?: string;
}

interface GoogleCseApiResponse {
	items?: GoogleCseApiItem[];
	error?: { code: number; message: string; status: string };
}

// Raw API wrapper only — no knowledge of extraction or the SearchProvider
// interface. `num` is capped at 10 by the API itself; a query with no
// matches returns no `items` at all rather than an error, hence `?? []`.
export async function googleCseSearch(
	apiKey: string,
	cx: string,
	query: string,
	maxResults = 5,
): Promise<GoogleCseResult[]> {
	const params = new URLSearchParams({ key: apiKey, cx, q: query, num: String(Math.min(maxResults, 10)) });
	const res = await fetch(`${GOOGLE_CSE_URL}?${params.toString()}`);

	// A non-2xx from a proxy/WAF in front of the API can come back as an
	// HTML/text error page rather than JSON — parse defensively so that
	// case still surfaces the intended descriptive error below instead of a
	// raw "Unexpected token <" from a failed res.json() call.
	let data: GoogleCseApiResponse = {};
	try {
		data = (await res.json()) as GoogleCseApiResponse;
	} catch {
		// fall through with an empty response; res.statusText covers the detail below
	}

	if (!res.ok) {
		const detail = data.error?.message ?? res.statusText;
		if (res.status === 429) {
			throw new Error(`Google CSE daily quota exceeded (100 free queries/day): ${detail}`);
		}
		throw new Error(`Google CSE search failed (${res.status}): ${detail}`);
	}

	return (data.items ?? []).map((item) => ({
		title: item.title,
		url: item.link,
		snippet: item.snippet ?? '',
	}));
}
