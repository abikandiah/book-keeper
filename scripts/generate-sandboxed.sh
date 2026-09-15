#!/usr/bin/env bash
# Hardened wrapper around Dockerfile.generate — see
# docs/blueprint/05-operations-and-future.md. Runs generation (network
# calls, untrusted third-party content fed to an LLM) inside an ephemeral,
# locked-down container with no repo/git access; git branch+commit happens
# afterward, on the host, via scripts/publish-book.ts.
set -euo pipefail

cd "$(dirname "$0")/.."

usage="Usage: scripts/generate-sandboxed.sh [\"Book Title\"] [--force] [--fiction] [--notes <path>] [--isbn <isbn>] [--known <path>] [--trust-known]
(\"Book Title\" may be omitted when --known is given -- it falls back to the known file's own name.)
(--fiction runs the shorter fiction pipeline -- a --known file's own \"kind\" field decides this instead, if given.)"

# No "at least one arg" guard here (a zero-arg call is otherwise a valid
# shape now, e.g. bare `--known <path>` alone) -- the real completeness
# check is the `[ -z "$title" ]` guard below, once title has had a chance to
# fall back to --known's basename.

force=""
fiction=""
notes_path=""
isbn=""
known_path=""
trust_known=""
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
	--fiction)
		fiction="--fiction"
		shift
		;;
	--notes)
		notes_path="${2:-}"
		# The `--*` case also catches a left-off value being swallowed by the
		# *next* flag instead (e.g. `--notes --trust-known`), which would
		# otherwise fail later with a confusing "file not found: --trust-known"
		# rather than this clear message.
		case "$notes_path" in
		'' | --*)
			echo "Error: --notes requires a file path argument." >&2
			exit 1
			;;
		esac
		shift 2
		;;
	--isbn)
		isbn="${2:-}"
		case "$isbn" in
		'' | --*)
			echo "Error: --isbn requires a value." >&2
			exit 1
			;;
		esac
		shift 2
		;;
	--known)
		known_path="${2:-}"
		case "$known_path" in
		'' | --*)
			echo "Error: --known requires a file path argument." >&2
			exit 1
			;;
		esac
		shift 2
		;;
	--trust-known)
		trust_known="--trust-known"
		shift
		;;
	*)
		title_parts+=("$1")
		shift
		;;
	esac
done

title="${title_parts[*]}"
title_not_typed=""
# Falls back to the --known file's own basename (e.g.
# known/the-undiscovered-self.json -> "the-undiscovered-self") when no title
# was typed, so `--known <path>` can work standalone as long as the file's
# named after the book. Resolved here (not left to the container) because
# this script needs a concrete title before it ever runs anything, for its
# own host-side pre-flight check below -- but that means the container would
# otherwise see this title as if it had been typed on the command line, with
# no way to tell the difference. `title_not_typed` (forwarded as
# --title-not-typed in container_args below) is exactly that missing
# signal: generate-book.ts's own parseArgs uses it to set `titleWasTyped`
# correctly even across this process boundary, so outlineNode's refusal to
# publish a slug-shaped title still applies to this, the actually-documented
# way to run generation -- not just to a direct, non-sandboxed invocation.
# generate-book.ts's stripJsonExtension applies the identical basename rule
# (keep both in sync if it ever changes).
#
# `case` (not `basename "$known_path" .json`, which only strips an
# exact-case ".json") so a `.JSON`-cased file still gets its extension
# stripped -- bash has no case-insensitive `basename` built in.
if [ -z "$title" ] && [ -n "$known_path" ]; then
	known_base="$(basename "$known_path")"
	case "$known_base" in
	*.[jJ][sS][oO][nN]) title="${known_base%.*}" ;;
	*) title="$known_base" ;;
	esac
	title_not_typed="1"
fi
if [ -z "$title" ]; then
	echo "$usage" >&2
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
if [ -n "$fiction" ]; then
	container_args+=(--fiction)
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
if [ -n "$known_path" ]; then
	if [ ! -f "$known_path" ]; then
		echo "Error: --known file not found: $known_path" >&2
		exit 1
	fi
	known_dir="$(cd "$(dirname "$known_path")" && pwd)"
	docker_volume_args+=(-v "$known_dir/$(basename "$known_path"):/known.json:ro")
	container_args+=(--known /known.json)
fi
if [ -n "$trust_known" ]; then
	container_args+=(--trust-known)
fi
if [ -n "$title_not_typed" ]; then
	container_args+=(--title-not-typed)
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
