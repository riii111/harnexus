#!/usr/bin/env bash
# Places the harnexus command, which runs this checkout with the pinned Bun by their absolute paths.
# It changes nothing else: no PATH, shell profile or environment setting.
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
prefix=${HARNEXUS_CLI_PREFIX:-$HOME/.local/bin}
bun_bin=bun

usage() {
  echo "usage: bun run install:cli [--prefix ABSOLUTE_DIR] [--bun ABSOLUTE_PATH_TO_BUN]" >&2
  exit 2
}

while [[ $# -gt 0 ]]; do
  case $1 in
    --prefix) [[ $# -ge 2 ]] || usage; prefix=$2; shift 2 ;;
    --bun) [[ $# -ge 2 ]] || usage; bun_bin=$2; shift 2 ;;
    *) usage ;;
  esac
done

[[ $prefix == /* ]] || { echo "install:cli: --prefix must be an absolute path" >&2; exit 2; }
if [[ $bun_bin != bun && $bun_bin != /* ]]; then
  echo "install:cli: --bun must be an absolute path" >&2
  exit 2
fi
found=$(command -v "$bun_bin" || true)
[[ -n $found ]] || { echo "install:cli: Bun is not available" >&2; exit 1; }
# The resolved file, so the command keeps this Bun when a version manager later points bun elsewhere.
bun_path=$(cd "$(dirname "$found")" && pwd -P)/$(basename "$found")
bun_path=$(readlink -f "$bun_path" 2>/dev/null || echo "$bun_path")
pinned=$(sed -n 's/.*"packageManager": "bun@\(.*\)".*/\1/p' "$root/package.json")
actual=$("$bun_path" --version)
if [[ $actual != "$pinned" ]]; then
  echo "install:cli: $bun_path is Bun $actual; install Bun $pinned or pass it with --bun" >&2
  exit 1
fi

quote() {
  printf "'%s'" "${1//\'/\'\\\'\'}"
}

mkdir -p "$prefix"
temporary=$(mktemp "$prefix/.harnexus.XXXXXX")
trap 'rm -f "$temporary"' EXIT
{
  echo '#!/bin/sh'
  echo "exec $(quote "$bun_path") --no-env-file --config=/dev/null $(quote "$root/src/cli/harnexus.ts") \"\$@\""
} > "$temporary"
chmod 0755 "$temporary"
mv -f "$temporary" "$prefix/harnexus"
trap - EXIT
echo "installed $prefix/harnexus (Bun $actual at $bun_path, checkout $root)"
