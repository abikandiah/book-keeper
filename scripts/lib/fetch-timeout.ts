// Shared "fetch that never hangs indefinitely" pattern — used by
// scripts/lib/openlibrary.ts's lookupIsbn and
// scripts/search/google-cse/extract.ts's extractPageText, both of which are
// best-effort enrichment steps where a slow/unresponsive server should never
// block or break book generation. The caller owns clearing the timeout (via
// the returned `clear`), so it can keep the deadline alive across a
// subsequent streaming body read instead of it firing the instant fetch()
// resolves.
export async function fetchWithTimeout(
	url: string,
	init: RequestInit,
	timeoutMs: number,
): Promise<{ response: Response; clear: () => void }> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), timeoutMs);
	const clear = () => clearTimeout(timeout);
	try {
		const response = await fetch(url, { ...init, signal: controller.signal });
		return { response, clear };
	} catch (err) {
		clear();
		throw err;
	}
}
