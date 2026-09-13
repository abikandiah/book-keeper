import { ChatOpenAI } from '@langchain/openai';

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

	return new ChatOpenAI({
		apiKey,
		model,
		configuration: { baseURL },
	});
}
