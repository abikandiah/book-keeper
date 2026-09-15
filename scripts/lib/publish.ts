import fs from 'node:fs';
import path from 'node:path';

import type { Book } from '../../src/content/schema';
import { branchExists, checkoutBranch, commitFile, createAndCheckoutBranch, isWorkingTreeClean } from './git';

export const BOOKS_DIR = 'src/content/books';

// Single source of truth for the `book/<slug>` naming convention — shared
// with accept-book.ts and reject-book.ts, which otherwise had no reason to
// duplicate this exact string template themselves.
export function bookBranch(slug: string): string {
	return `book/${slug}`;
}

export function slugify(title: string): string {
	return title
		.toLowerCase()
		.normalize('NFKD')
		.replace(/[\u0300-\u036f]/g, '') // strip combining diacritics after NFKD decomposition
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/(^-|-$)/g, '');
}

// Shared by both the direct (non-sandboxed) `generate` path and the
// sandboxed path's host-only publish-book.ts — the git-dependent
// pre-flight checks a book must pass before it's written and committed.
export function checkPublishable(slug: string, force: boolean): void {
	const filePath = path.join(BOOKS_DIR, `${slug}.json`);
	const branch = bookBranch(slug);
	const branchAlreadyExists = branchExists(branch);

	if (!force) {
		if (fs.existsSync(filePath)) {
			throw new Error(`${filePath} already exists. Pass --force to regenerate it.`);
		}
		if (branchAlreadyExists) {
			throw new Error(`Branch "${branch}" already exists. Pass --force to proceed anyway.`);
		}
	} else if (branchAlreadyExists) {
		console.warn(
			`Branch "${branch}" already exists — --force will reset it to this run, discarding any commits currently on it.`,
		);
	}
	if (!isWorkingTreeClean()) {
		throw new Error(
			'Working tree is not clean. Commit or stash pending changes before publishing a book — this creates and commits to a new branch.',
		);
	}
}

// Creates/resets `book/<slug>`, writes the book JSON, and commits it. On
// failure, best-effort restores `originalBranch` so a failed commit (bad
// git identity, a rejected pre-commit hook, disk full) doesn't leave the
// repo stranded on a half-published branch that then blocks every future
// run via checkPublishable's isWorkingTreeClean() check.
export function publishBook(book: Book, slug: string, originalBranch: string, title: string): void {
	const branch = bookBranch(slug);
	const filePath = path.join(BOOKS_DIR, `${slug}.json`);

	try {
		createAndCheckoutBranch(branch);
		fs.mkdirSync(BOOKS_DIR, { recursive: true });
		fs.writeFileSync(filePath, `${JSON.stringify(book, null, 2)}\n`);
		commitFile(filePath, `Add ${title}`);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		try {
			checkoutBranch(originalBranch);
			console.error(
				`\nPublish failed on branch "${branch}": ${message}\n` +
					`Restored original branch "${originalBranch}". "${branch}" may still exist with a ` +
					`partial/uncommitted change — inspect it and delete it ("git branch -D ${branch}") if needed.`,
			);
		} catch {
			console.error(
				`\nPublish failed on branch "${branch}": ${message}\n` +
					`Could not automatically switch back to "${originalBranch}" — resolve this manually ` +
					`("git status", "git branch") before running generate again.`,
			);
		}
		throw err;
	}

	console.log(`\nCommitted to branch "${branch}".`);
	console.log(`Run "pnpm dev" and open /books/${slug} to review before merging to main.`);
}
