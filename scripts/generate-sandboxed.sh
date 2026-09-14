#!/usr/bin/env bash
# Hardened wrapper around Dockerfile.generate — see
# docs/blueprint/05-operations-and-future.md. Runs generation (network
# calls, untrusted third-party content fed to an LLM) inside an ephemeral,
# locked-down container with no repo/git access; git branch+commit happens
# afterward, on the host, via scripts/publish-book.ts.
set -euo pipefail

cd "$(dirname "$0")/.."

if [ $# -lt 1 ]; then
	echo "Usage: scripts/generate-sandboxed.sh \"Book Title\" [--force] [--notes <path>] [--isbn <isbn>]" >&2
	exit 1
fi

force=""
notes_path=""
isbn=""
title_parts=()
while [ $# -gt 0 ]; do
	case "$1" in
	--)
		# `pnpm run generate:sandboxed -- "Title"` forwards this literal `--`
		# through to the script instead of stripping it (confirmed on pnpm
		# 12.x) — without this case it falls into the title_parts catch-all
		# below and corrupts the slug/title with a leading "--".
		shift
		;;
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
	--isbn)
		isbn="${2:-}"
		if [ -z "$isbn" ]; then
			echo "Error: --isbn requires a value." >&2
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
	echo "Usage: scripts/generate-sandboxed.sh \"Book Title\" [--force] [--notes <path>] [--isbn <isbn>]" >&2
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

# Loaded into this shell so the needed vars can be passed through
# explicitly below -- deliberately not `docker run --env-file .env`, which
# would forward every var in .env into the container.
if [ -f .env ]; then
	set -a
	# shellcheck disable=SC1091
	source .env
	set +a
fi

# Checked before the (potentially minutes-long, cold-cache) docker build
# below, not after -- no point paying for an image build only to fail on a
# millisecond-cheap missing-env-var check.
for var in OPENROUTER_API_KEY LLM_BASE_URL LLM_MODEL TAVILY_API_KEY; do
	if [ -z "${!var:-}" ]; then
		echo "Error: $var is not set (see .env.example)." >&2
		exit 1
	fi
done

echo "Building sandbox image..."
docker build -f Dockerfile.generate -t book-keeper-generate .

output_dir="$(pwd)/.generate-output"
rm -rf "$output_dir"
mkdir -p "$output_dir"
# World-writable so the container's fixed sandboxuser (uid 10001 — see
# Dockerfile.generate, almost never your own host uid) can write its output
# here; a bind mount doesn't remap ownership. Scoped to this one throwaway,
# per-run scratch directory (deleted on success, gitignored otherwise), not
# a broad permissions relaxation.
chmod 777 "$output_dir"
# Only cleaned up on success -- on failure (e.g. the repo changed state
# between the preflight check above and this run, or publish-book.ts itself
# fails) the already-completed generation is preserved instead of silently
# discarded, so it can be published later with a direct publish-book.ts
# call instead of re-running the whole (expensive) generation.
cleanup() {
	local exit_code=$?
	if [ "$exit_code" -eq 0 ]; then
		rm -rf "$output_dir"
	elif [ -f "$output_dir/book.json" ]; then
		echo "Generation output preserved at $output_dir (exit $exit_code)." >&2
		echo "Fix the issue, then run: pnpm exec tsx scripts/publish-book.ts $output_dir/book.json${force:+ --force}" >&2
	else
		echo "Generation failed before producing output (exit $exit_code); nothing to preserve or replay." >&2
	fi
}
trap cleanup EXIT

docker_env_args=(-e OPENROUTER_API_KEY -e LLM_BASE_URL -e LLM_MODEL -e TAVILY_API_KEY)
if [ -n "${CHAPTER_CONCURRENCY:-}" ]; then
	docker_env_args+=(-e CHAPTER_CONCURRENCY)
fi

docker_volume_args=(-v "$output_dir:/output")
container_args=("$title" --emit-json /output/book.json)
if [ -n "$force" ]; then
	container_args+=(--force)
fi
if [ -n "$isbn" ]; then
	container_args+=(--isbn "$isbn")
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
