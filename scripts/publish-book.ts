import fs from 'node:fs';

import { bookSchema } from '../src/content/schema';
import { currentBranch } from './lib/git';
import { checkPublishable, publishBook, slugify } from './lib/publish';

// Host-only counterpart to generate-book.ts --emit-json — never runs inside
// the Docker sandbox (scripts/generate-sandboxed.sh). Takes the JSON file
// the sandbox produced and does the one thing the sandbox deliberately
// can't: git branch + commit. Re-validates with bookSchema before trusting
// anything the sandbox produced, even though it already validated
// internally — a boundary-crossing artifact is never trusted blindly just
// because it came from your own pipeline.
//
// Also supports --check-only <title>, a fast up-front pre-flight: run
// before generate-sandboxed.sh spends a full (paid) LLM+search generation,
// so a duplicate title or a dirty working tree fails in milliseconds
// instead of after the sandbox has already done all the expensive work.
type Args = { mode: 'check'; title: string; force: boolean } | { mode: 'publish'; jsonPath: string; force: boolean };

function parseArgs(argv: string[]): Args {
	// `pnpm run publish-book -- ...` forwards a literal `--` through to this
	// script instead of stripping it (confirmed on pnpm 12.x) — dropped here
	// alongside `--force` so it can't be mistaken for `--check-only` or a
	// JSON path below.
	const cleaned = argv.filter((a) => a !== '--');
	const force = cleaned.includes('--force');
	const rest = cleaned.filter((a) => a !== '--force');

	if (rest[0] === '--check-only') {
		const title = rest.slice(1).join(' ').trim();
		if (!title) throw new Error('Usage: pnpm run publish-book -- --check-only "Book Title" [--force]');
		return { mode: 'check', title, force };
	}

	const jsonPath = rest[0];
	if (!jsonPath) {
		throw new Error(
			'Usage: pnpm run publish-book -- <path-to-book.json> [--force]\n' +
				'   or: pnpm run publish-book -- --check-only "Book Title" [--force]',
		);
	}
	return { mode: 'publish', jsonPath, force };
}

function main() {
	let args: Args;
	try {
		args = parseArgs(process.argv.slice(2));
	} catch (err) {
		console.error(err instanceof Error ? err.message : String(err));
		process.exit(1);
		return;
	}

	try {
		if (args.mode === 'check') {
			checkPublishable(slugify(args.title), args.force);
			console.log(`OK to publish "${args.title}".`);
			return;
		}

		const raw = JSON.parse(fs.readFileSync(args.jsonPath, 'utf-8'));
		const book = bookSchema.parse(raw);
		const slug = slugify(book.title);
		const originalBranch = currentBranch();

		checkPublishable(slug, args.force);
		publishBook(book, slug, originalBranch, book.title);
	} catch (err) {
		console.error(`\n${args.mode === 'check' ? 'Check' : 'Publish'} failed:`, err instanceof Error ? err.message : err);
		process.exit(1);
	}
}

main();
