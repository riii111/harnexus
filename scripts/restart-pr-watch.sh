#!/usr/bin/env bash
set -euo pipefail

# The PR watch keeps running the binary it started with, so install:task restarts it after replacing harnexus-task.
# harnexus owns this label; dotfiles loads the agent under the same one.
label="io.github.riii111.pr-watch"

if ! command -v launchctl >/dev/null 2>&1; then
  echo "PR watch: launchctl not found; nothing to restart"
  exit 0
fi

service="gui/$(id -u)/$label"
if ! launchctl print "$service" >/dev/null 2>&1; then
  echo "PR watch: $label is not loaded; nothing to restart"
  exit 0
fi

launchctl kickstart -k "$service"
echo "PR watch: restarted $label on the new harnexus-task"
