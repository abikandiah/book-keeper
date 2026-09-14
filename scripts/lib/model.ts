import { classifyRateLimitError } from '@langchain/core/utils/async_caller';
import { ChatOpenAI } from '@langchain/openai';

// OpenRouter's free-tier per-minute cap (distinct from its daily cap — see
// .env.example) is transient and self-resolving: waiting ~60s always clears
// it, unlike a genuine failure. LangChain's own retry layer (AsyncCaller,
// used internally by ChatOpenAI) already backs off on a 429, but its total
// budget isn't reliably long enough to survive a full per-minute window, so
// this adds a second, longer-patience layer on top.
//
// Reuses @langchain/core's own classifyRateLimitError — the exact
// status-code/error-code-based classification AsyncCaller itself relies on
// internally — rather than pattern-matching the error's free-text message,
// which is fragile against a provider rewording its rate-limit message.
// Deliberately does NOT wait on a "stop" classification (e.g. a genuinely
// exhausted daily quota, detected via error code / quota-message pattern,
// not just any 429) — waiting a minute doesn't fix a quota that resets in
// hours.
const RATE_LIMIT_WAIT_MS = 60_000;
const MAX_RATE_LIMIT_WAITS = 10;

function shouldWaitForRateLimit(err: unknown): boolean {
	const classification = classifyRateLimitError(err);
	return classification !== undefined && classification.action !== 'stop';
}

async function invokeWithRateLimitWait<T>(fn: () => Promise<T>): Promise<T> {
	for (let attempt = 1; ; attempt++) {
		try {
			return await fn();
		} catch (err) {
			if (!shouldWaitForRateLimit(err) || attempt > MAX_RATE_LIMIT_WAITS) throw err;
			// +/-10% jitter so multiple chapters hitting the same per-minute cap
			// at once (CHAPTER_CONCURRENCY) don't all retry in exact lockstep and
			// re-collide on the same window.
			const waitMs = Math.round(RATE_LIMIT_WAIT_MS * (0.9 + Math.random() * 0.2));
			console.log(
				`  hit a per-minute rate limit — waiting ~${Math.round(waitMs / 1000)}s before retrying ` +
					`(${attempt}/${MAX_RATE_LIMIT_WAITS})...`,
			);
			await new Promise((resolve) => setTimeout(resolve, waitMs));
		}
	}
}

// Wraps `withStructuredOutput` so every `.invoke()` call it produces waits
// out per-minute rate limits automatically. Applied once here, at model
// construction, rather than at each of generate-book.ts's call sites — a
// future call site can't accidentally skip it, since there's no separate
// step to remember.
function withRateLimitWait(chatModel: ChatOpenAI): ChatOpenAI {
	const originalWithStructuredOutput = chatModel.withStructuredOutput.bind(chatModel);
	chatModel.withStructuredOutput = ((...args: Parameters<typeof originalWithStructuredOutput>) => {
		const runnable = originalWithStructuredOutput(...args);
		const originalInvoke = runnable.invoke.bind(runnable);
		runnable.invoke = ((...invokeArgs: Parameters<typeof originalInvoke>) =>
			invokeWithRateLimitWait(() => originalInvoke(...invokeArgs))) as typeof runnable.invoke;
		return runnable;
	}) as typeof chatModel.withStructuredOutput;
	return chatModel;
}

// OpenRouter exposes an OpenAI-compatible endpoint, so ChatOpenAI (from
// @langchain/openai) works against it directly via `configuration.baseURL` —
// no separate OpenRouter client needed. See docs/blueprint/02-generation-pipeline.md.
export function createModel(): ChatOpenAI {
	const apiKey = process.env.OPENROUTER_API_KEY;
	const baseURL = process.env.LLM_BASE_URL;
	const model = process.env.LLM_MODEL;

	if (!apiKey) throw new Error('OPENROUTER_API_KEY is not set (see .env.example).');
	if (!baseURL) throw new Error('LLM_BASE_URL is not set (see .env.example).');
	if (!model) throw new Error('LLM_MODEL is not set (see .env.example).');

	return withRateLimitWait(
		new ChatOpenAI({
			apiKey,
			model,
			configuration: { baseURL },
		}),
	);
}
