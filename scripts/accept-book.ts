import { bookSchema } from '../src/content/schema';
import {
	abortMerge,
	branchExists,
	checkoutBranch,
	currentBranch,
	deleteBranch,
	isWorkingTreeClean,
	mergeBranch,
	readFileFromBranch,
} from './lib/git';
import { BOOKS_DIR, bookBranch } from './lib/publish';

function parseArgs(argv: string[]): { slug: string; force: boolean } {
	const cleaned = argv.filter((a) => a !== '--');
	const force = cleaned.includes('--force');
	const slug = cleaned.find((a) => a !== '--force');
	if (!slug) throw new Error('Usage: pnpm run accept -- <slug> [--force]');
	return { slug, force };
}

function main() {
	let args: { slug: string; force: boolean };
	try {
		args = parseArgs(process.argv.slice(2));
	} catch (err) {
		console.error(err instanceof Error ? err.message : String(err));
		process.exit(1);
		return;
	}

	const branch = bookBranch(args.slug);
	try {
		if (!branchExists(branch)) {
			throw new Error(`Branch "${branch}" does not exist.`);
		}
		if (!isWorkingTreeClean()) {
			throw new Error('Working tree is not clean. Commit or stash pending changes before accepting a book.');
		}

		// Checked against the branch's own copy, not whatever's currently
		// checked out — this must work whether you're mid-review on `branch`
		// itself or already back on `main`.
		const filePath = `${BOOKS_DIR}/${args.slug}.json`;
		const raw: unknown = JSON.parse(readFileFromBranch(branch, filePath));
		const parsed = bookSchema.safeParse(raw);
		if (!parsed.success) {
			// A schema-shape mismatch here almost always means the branch
			// predates a schema change (e.g. the discriminated-union `kind`
			// field this codebase added) — a dense raw ZodError dump wouldn't
			// tell you that, so it's worth calling out explicitly rather than
			// just forwarding the generic issue list.
			const hasKind = typeof raw === 'object' && raw !== null && 'kind' in raw;
			if (!hasKind) {
				throw new Error(
					`"${filePath}" on "${branch}" has no "kind" field (added to the schema after this branch was ` +
						`generated). Check out "${branch}", add "kind": "non-fiction" (or "fiction") to the file, ` +
						'commit, and try again.',
				);
			}
			// A zod enum mismatch (e.g. an old `tags` value that predates a
			// vocabulary change) inlines the *entire* allowed-values list into
			// `message` — confirmed directly, a 39-option tags enum produces a
			// ~700-character single line. Capped so one such issue doesn't drown
			// out every other issue in the joined message below.
			const issues = parsed.error.issues
				.map((i) => `${i.path.join('.') || '(root)'}: ${i.message.length > 120 ? `${i.message.slice(0, 120)}…` : i.message}`)
				.join('; ');
			throw new Error(`"${filePath}" on "${branch}" doesn't match the current content schema: ${issues}`);
		}
		const book = parsed.data;
		if (!book.verified && !args.force) {
			throw new Error(
				`"${book.title}" is not marked verified on "${branch}" yet. Review it (pnpm dev) and flip ` +
					`"verified" to true before accepting, or pass --force to accept anyway.`,
			);
		}

		if (currentBranch() !== 'main') checkoutBranch('main');
		try {
			mergeBranch(branch);
		} catch (mergeErr) {
			// Restores main to its pre-merge state rather than leaving the
			// working tree mid-merge with conflict markers — see abortMerge's
			// comment in lib/git.ts for why that matters. Guarded: if the merge
			// failed for a reason that never actually started a merge (e.g. the
			// branch vanished mid-run — a race with `reject` deleting it), there's
			// no MERGE_HEAD to abort, and abortMerge() throwing "no merge to
			// abort" would otherwise replace the original, more useful error.
			try {
				abortMerge();
			} catch {
				// Nothing to abort — fall through to the original error below.
			}
			throw new Error(
				`Merging "${branch}" into main failed (likely a conflict) — merge aborted if one was in progress, ` +
					`main should be unchanged: ${mergeErr instanceof Error ? mergeErr.message : mergeErr}\n` +
					`Resolve by hand (e.g. rebase "${branch}" onto main first), then retry.`,
			);
		}
		deleteBranch(branch, false);

		console.log(`Merged "${branch}" into main and deleted it.`);
	} catch (err) {
		console.error('Accept failed:', err instanceof Error ? err.message : err);
		process.exit(1);
	}
}

main();
