const startTime = Date.now();

function formatElapsed(ms: number): string {
	const totalSeconds = Math.floor(ms / 1000);
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

// Callers occasionally lead a message with "\n" as a blank-line separator
// (e.g. right before a final summary). Pulling any leading newlines out
// before the prefix keeps that as an actual blank line rather than gluing
// the "[m:ss] " tag onto its own orphaned line ahead of unprefixed text.
function withElapsedPrefix(message: string): string {
	const leadingNewlines = /^\n+/.exec(message)?.[0] ?? '';
	const rest = message.slice(leadingNewlines.length);
	return `${leadingNewlines}[${formatElapsed(Date.now() - startTime)}] ${rest}`;
}

// Prefixes every line with elapsed time since the script started, so a
// multi-minute generation run's console output shows how long each stage
// actually took instead of an unlabeled scroll of text. Shared by
// generate-book.ts and model.ts so both write to the same timeline.
export function log(message: string): void {
	console.log(withElapsedPrefix(message));
}

export function logError(message: string): void {
	console.error(withElapsedPrefix(message));
}
