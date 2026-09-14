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
