#!/usr/bin/env bash
# Builds harnexus-task from this checkout and places it under a directory of your choice, for Codex Cloud
# where ~/.local/bin does not persist and the macOS-only install:task does not apply.
# It changes nothing else: no PATH, shell profile or environment setting.
set -euo pipefail

prefix=${HARNEXUS_TASK_PREFIX:-/workspace/.cloud-setup/bin}
bun_bin=bun

usage() {
  echo "usage: scripts/install-cloud-task.sh [--prefix ABSOLUTE_DIR] [--bun ABSOLUTE_PATH_TO_BUN]" >&2
  exit 2
}

while [[ $# -gt 0 ]]; do
  case $1 in
    --prefix) [[ $# -ge 2 ]] || usage; prefix=$2; shift 2 ;;
    --bun) [[ $# -ge 2 ]] || usage; bun_bin=$2; shift 2 ;;
    *) usage ;;
  esac
done

[[ $prefix == /* ]] || { echo "install-cloud-task: --prefix must be an absolute path" >&2; exit 2; }
if [[ $bun_bin != bun && $bun_bin != /* ]]; then
  echo "install-cloud-task: --bun must be an absolute path" >&2
  exit 2
fi
if ! command -v "$bun_bin" >/dev/null 2>&1; then
  cat >&2 <<MSG
install-cloud-task: Bun is not available.
Install the pinned version once, for example with the Node of the Cloud setup:
  PATH=/workspace/.cloud-setup/tools/node-v22.16.0-linux-x64/bin:\$PATH npm install --prefix /workspace/.cloud-setup/bun bun@$(sed -n 's/.*"packageManager": "bun@\(.*\)".*/\1/p' "$(dirname "$0")/../package.json")
then rerun with --bun /workspace/.cloud-setup/bun/node_modules/.bin/bun
MSG
  exit 1
fi

root=$(cd "$(dirname "$0")/.." && pwd)
bun_dir=$(dirname "$(command -v "$bun_bin")")
cd "$root"
# bun run build:task starts bun by name, so the chosen one comes first on PATH.
export PATH="$bun_dir:$PATH"
"$bun_bin" install --frozen-lockfile
"$bun_bin" run build:task

mkdir -p "$prefix"
temporary=$(mktemp "$prefix/.harnexus-task.XXXXXX")
trap 'rm -f "$temporary"' EXIT
install -m 0755 "$root/dist/harnexus-task" "$temporary"
mv -f "$temporary" "$prefix/harnexus-task"
trap - EXIT
echo "installed $prefix/harnexus-task"
echo "call it by this absolute path; nothing was added to PATH"
