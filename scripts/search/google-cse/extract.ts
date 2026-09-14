import dns from 'node:dns/promises';
import net from 'node:net';

import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';

// Best-effort page-content enrichment, same convention as
// scripts/lib/openlibrary.ts's lookupIsbn: never throws, never hangs
// indefinitely, and a failure here should never block or break book
// generation — the caller falls back to the search snippet instead.
const FETCH_TIMEOUT_MS = 8000;

// Cheap defensive guard against pathologically large pages (e.g. an
// infinite-scroll feed or a misidentified non-article response). Enforced
// as a streaming byte cap in readCapped() below, not a post-hoc check on
// the fully-read body — undici/fetch transparently decompresses gzip, so
// checking .length only *after* res.text() resolves would already have let
// a decompression bomb exhaust memory getting there.
const MAX_RESPONSE_BYTES = 2_000_000;

// Keeps prompt sizes bounded — roughly the same order of magnitude as
// Tavily's own `content` field, not an attempt to capture a full article.
const MAX_CONTENT_LENGTH = 2000;

const USER_AGENT = 'book-keeper/1.0 (+personal research tool, not for redistribution)';

const BLOCKED_HOSTNAMES = new Set(['localhost']);

// Not exhaustive against a network-level adversary (a DNS answer could
// change between this check and the actual fetch — full protection needs
// an IP-pinning dispatcher, disproportionate effort for a hobby project's
// search-enrichment step) but blocks the straightforward case: a search
// result whose URL is, or resolves to, a private/loopback/link-local
// address (including the 169.254.169.254 cloud metadata endpoint) rather
// than a real public page.
function isPrivateIPv4(ip: string): boolean {
	const parts = ip.split('.').map(Number);
	if (parts.length !== 4 || parts.some((p) => Number.isNaN(p))) return true; // malformed — fail closed
	const [a, b] = parts;
	if (a === 0 || a === 10 || a === 127) return true;
	if (a === 169 && b === 254) return true;
	if (a === 172 && b >= 16 && b <= 31) return true;
	if (a === 192 && b === 168) return true;
	if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT / shared address space
	return false;
}

function isPrivateIPv6(ip: string): boolean {
	const normalized = ip.toLowerCase();
	if (normalized === '::1') return true;
	if (normalized.startsWith('fe80:')) return true; // link-local
	if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true; // unique local, fc00::/7
	if (normalized.startsWith('::ffff:')) return isPrivateIPv4(normalized.slice('::ffff:'.length));
	return false;
}

async function isSafeUrl(rawUrl: string): Promise<boolean> {
	let url: URL;
	try {
		url = new URL(rawUrl);
	} catch {
		return false;
	}
	if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
	if (BLOCKED_HOSTNAMES.has(url.hostname.toLowerCase())) return false;

	const literalIpVersion = net.isIP(url.hostname);
	if (literalIpVersion) {
		return literalIpVersion === 4 ? !isPrivateIPv4(url.hostname) : !isPrivateIPv6(url.hostname);
	}

	try {
		const addresses = await dns.lookup(url.hostname, { all: true });
		return addresses.every((addr) => (addr.family === 4 ? !isPrivateIPv4(addr.address) : !isPrivateIPv6(addr.address)));
	} catch {
		return false; // couldn't resolve — fail closed, not open
	}
}

// Reads the response body under a hard byte cap, bailing out (and
// cancelling the underlying stream) the moment the cap is crossed rather
// than buffering an arbitrarily large — or decompression-bombed — body
// first and only checking its size afterward.
async function readCapped(res: Response, maxBytes: number): Promise<string | undefined> {
	const contentLength = res.headers.get('content-length');
	if (contentLength && Number(contentLength) > maxBytes) return undefined;

	const reader = res.body?.getReader();
	if (!reader) return undefined;

	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (total > maxBytes) {
				await reader.cancel();
				return undefined;
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}

	return Buffer.concat(chunks, total).toString('utf-8');
}

export async function extractPageText(url: string): Promise<string | undefined> {
	// One deadline covers fetch AND the body read below — clearing it as soon
	// as fetch() resolves (i.e. once headers arrive) would leave the
	// subsequent streaming read in readCapped() completely unguarded, so a
	// server that sends headers promptly but then trickles bytes (or sends
	// none at all) could hang extraction indefinitely despite this function's
	// "never hangs" contract.
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
	try {
		if (!(await isSafeUrl(url))) return undefined;

		const res = await fetch(url, { signal: controller.signal, headers: { 'User-Agent': USER_AGENT } });
		if (!res.ok) return undefined;

		const contentType = res.headers.get('content-type') ?? '';
		if (!contentType.includes('text/html')) return undefined;

		const html = await readCapped(res, MAX_RESPONSE_BYTES);
		if (!html) return undefined;

		const { document } = parseHTML(html);
		const article = new Readability(document).parse();
		if (!article?.textContent) return undefined;

		const collapsed = article.textContent.replace(/\s+/g, ' ').trim();
		return collapsed.length > 0 ? collapsed.slice(0, MAX_CONTENT_LENGTH) : undefined;
	} catch {
		return undefined;
	} finally {
		clearTimeout(timeout);
	}
}
