#!/usr/bin/env bash
set -euo pipefail

# Catch substantial growth into a specification while leaving room for user guidance.
readme="$(dirname "$0")/../README.md"
words=$(wc -w < "$readme")
limit=1200

if (( words > limit )); then
  echo "README.md has $words words (maximum $limit)." >&2
  echo 'Review for implementation details and repetition before trimming necessary user guidance.' >&2
  exit 1
fi

echo "README.md: $words/$limit words"
