import { bookSchema } from '../src/content/schema';
import { branchExists, checkoutBranch, currentBranch, deleteBranch, isWorkingTreeClean, readFileFromBranch } from './lib/git';
import { BOOKS_DIR, bookBranch } from './lib/publish';

function parseArgs(argv: string[]): { slug: string; force: boolean } {
	const cleaned = argv.filter((a) => a !== '--');
	const force = cleaned.includes('--force');
	const slug = cleaned.find((a) => a !== '--force');
	if (!slug) throw new Error('Usage: pnpm run reject -- <slug> [--force]');
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
			throw new Error('Working tree is not clean. Commit or stash pending changes before rejecting a book.');
		}

		// A typo'd slug should never silently destroy a branch you actually
		// reviewed and approved — same safety margin as accept's own
		// verified-check, just in the opposite direction (refuse deleting a
		// verified branch, rather than refuse publishing an unverified one).
		// Best-effort: an unreadable/unparseable file (e.g. mid-generation, or
		// predating some schema change) doesn't block a reject — that's
		// exactly the kind of branch reject exists to clean up, unverified or
		// not.
		if (!args.force) {
			try {
				const filePath = `${BOOKS_DIR}/${args.slug}.json`;
				const raw: unknown = JSON.parse(readFileFromBranch(branch, filePath));
				const parsed = bookSchema.safeParse(raw);
				if (parsed.success && parsed.data.verified) {
					throw new Error(
						`"${parsed.data.title}" on "${branch}" is marked verified — pass --force if you really want to ` +
							'discard a reviewed, approved book.',
					);
				}
			} catch (err) {
				if (err instanceof Error && err.message.includes('is marked verified')) throw err;
				// JSON parse failure, schema mismatch, etc. — not this check's
				// concern, fall through and let the delete proceed.
			}
		}

		if (currentBranch() === branch) checkoutBranch('main');
		deleteBranch(branch, true);

		console.log(`Deleted "${branch}".`);
	} catch (err) {
		console.error('Reject failed:', err instanceof Error ? err.message : err);
		process.exit(1);
	}
}

main();
