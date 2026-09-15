import { execFileSync } from 'node:child_process';

function git(args: string[]): string {
	return execFileSync('git', args, { encoding: 'utf-8' }).trim();
}

export function isWorkingTreeClean(): boolean {
	return git(['status', '--porcelain']) === '';
}

export function isGitRepo(): boolean {
	try {
		git(['rev-parse', '--is-inside-work-tree']);
		return true;
	} catch {
		return false;
	}
}

export function branchExists(branch: string): boolean {
	try {
		git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
		return true;
	} catch {
		return false;
	}
}

export function currentBranch(): string {
	return git(['rev-parse', '--abbrev-ref', 'HEAD']);
}

export function checkoutBranch(branch: string): void {
	git(['checkout', branch]);
}

export function createAndCheckoutBranch(branch: string): void {
	// -B creates or resets the branch to HEAD — safe here because setupNode
	// (Stage 0) already refused to proceed past an existing branch unless
	// --force was explicitly passed.
	git(['checkout', '-B', branch]);
}

export function commitFile(filePath: string, message: string): void {
	git(['add', filePath]);
	git(['commit', '-m', message]);
}

export function mergeBranch(branch: string): void {
	git(['merge', '--no-edit', branch]);
}

// Used by accept-book.ts to restore main to its pre-merge state on a merge
// conflict, rather than leaving the working tree mid-merge with conflict
// markers — a state that would otherwise silently block every subsequent
// accept/reject/generate run's isWorkingTreeClean() check until someone
// notices and resolves it by hand.
export function abortMerge(): void {
	git(['merge', '--abort']);
}

// -d (safe) refuses on an unmerged branch; -D (force) is for the reject path,
// where the branch is being discarded precisely because it was never merged.
export function deleteBranch(branch: string, force: boolean): void {
	git(['branch', force ? '-D' : '-d', branch]);
}

// Reads a file's content as of a given branch without checking it out —
// lets accept-book.ts inspect a book/<slug> branch's JSON (e.g. `verified`)
// while staying on whatever branch the reviewer is currently on.
export function readFileFromBranch(branch: string, filePath: string): string {
	return git(['show', `${branch}:${filePath}`]);
}
