#!/usr/bin/env bash
# Hardened wrapper around Dockerfile.generate — see
# docs/blueprint/05-operations-and-future.md. Runs generation (network
# calls, untrusted scraped-page parsing) inside an ephemeral, locked-down
# container with no repo/git access; git branch+commit happens afterward,
# on the host, via scripts/publish-book.ts.
set -euo pipefail

cd "$(dirname "$0")/.."

if [ $# -lt 1 ]; then
	echo "Usage: scripts/generate-sandboxed.sh \"Book Title\" [--force] [--notes <path>]" >&2
	exit 1
fi

force=""
notes_path=""
title_parts=()
while [ $# -gt 0 ]; do
	case "$1" in
	--force)
		force="--force"
		shift
		;;
	--notes)
		notes_path="${2:-}"
		if [ -z "$notes_path" ]; then
			echo "Error: --notes requires a file path argument." >&2
			exit 1
		fi
		shift 2
		;;
	*)
		title_parts+=("$1")
		shift
		;;
	esac
done

title="${title_parts[*]}"
if [ -z "$title" ]; then
	echo "Usage: scripts/generate-sandboxed.sh \"Book Title\" [--force] [--notes <path>]" >&2
	exit 1
fi

# Fails fast (existing file/branch, dirty tree) before anything expensive
# runs -- the container has no git access to do this check itself, and
# skipping it here would mean a duplicate title only surfaces as a failure
# in publish-book.ts *after* a full paid LLM+search generation completes.
echo "Checking whether this book can be published..."
publish_check_args=("$title")
if [ -n "$force" ]; then
	publish_check_args+=(--force)
fi
pnpm exec tsx scripts/publish-book.ts --check-only "${publish_check_args[@]}"

echo "Building sandbox image..."
docker build -f Dockerfile.generate -t book-keeper-generate .

# Loaded into this shell so the needed vars can be passed through
# explicitly below -- deliberately not `docker run --env-file .env`, which
# would forward every var in .env (including TAVILY_API_KEY, which this
# path never uses) into the container.
if [ -f .env ]; then
	set -a
	# shellcheck disable=SC1091
	source .env
	set +a
fi

for var in OPENROUTER_API_KEY LLM_BASE_URL LLM_MODEL GOOGLE_CSE_API_KEY GOOGLE_CSE_CX; do
	if [ -z "${!var:-}" ]; then
		echo "Error: $var is not set (see .env.example)." >&2
		exit 1
	fi
done

output_dir="$(pwd)/.generate-output"
rm -rf "$output_dir"
mkdir -p "$output_dir"
# Only cleaned up on success -- on failure (e.g. the repo changed state
# between the preflight check above and this run, or publish-book.ts itself
# fails) the already-completed generation is preserved instead of silently
# discarded, so it can be published later with a direct publish-book.ts
# call instead of re-running the whole (expensive) generation.
cleanup() {
	local exit_code=$?
	if [ "$exit_code" -eq 0 ]; then
		rm -rf "$output_dir"
	else
		echo "Generation output preserved at $output_dir (exit $exit_code)." >&2
		echo "Fix the issue, then run: pnpm exec tsx scripts/publish-book.ts $output_dir/book.json${force:+ --force}" >&2
	fi
}
trap cleanup EXIT

docker_env_args=(-e OPENROUTER_API_KEY -e LLM_BASE_URL -e LLM_MODEL -e GOOGLE_CSE_API_KEY -e GOOGLE_CSE_CX)
if [ -n "${CHAPTER_CONCURRENCY:-}" ]; then
	docker_env_args+=(-e CHAPTER_CONCURRENCY)
fi

docker_volume_args=(-v "$output_dir:/output")
container_args=("$title" --emit-json /output/book.json)
if [ -n "$force" ]; then
	container_args+=(--force)
fi
if [ -n "$notes_path" ]; then
	if [ ! -f "$notes_path" ]; then
		echo "Error: --notes file not found: $notes_path" >&2
		exit 1
	fi
	notes_dir="$(cd "$(dirname "$notes_path")" && pwd)"
	docker_volume_args+=(-v "$notes_dir/$(basename "$notes_path"):/notes.txt:ro")
	container_args+=(--notes /notes.txt)
fi

echo "Running generation in sandbox..."
docker run --rm \
	--read-only \
	--tmpfs /tmp:rw,noexec,nosuid,size=64m \
	--cap-drop=ALL \
	--security-opt no-new-privileges \
	--pids-limit=256 \
	--memory=512m --memory-swap=512m \
	"${docker_env_args[@]}" \
	"${docker_volume_args[@]}" \
	book-keeper-generate \
	"${container_args[@]}"

echo "Publishing to a draft branch..."
publish_args=("$output_dir/book.json")
if [ -n "$force" ]; then
	publish_args+=(--force)
fi
pnpm exec tsx scripts/publish-book.ts "${publish_args[@]}"
