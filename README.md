# harnexus
[draft] An intermediary for using multiple agent execution environments from the Codex App.

## Claude effort levels

A `maxEffortLevel` in a project's `.claude/settings.json` takes precedence, so Claude may run at a lower effort than the one picked in the Codex App (e.g. `max` picked, `low` run with `"maxEffortLevel": "low"`).

## Unverified Codex CLI versions

The bridge logs the Codex CLI version the app bundles and warns when harnexus was not checked on it. Set `HARNEXUS_UNVERIFIED_CODEX=pause` to hide the Claude models and refuse Claude turns on such a version instead.

## Checking the setup

Run `bun run doctor` to check the app, Codex CLI, Claude Agent SDK and Bun versions, the Claude login, the state file, the launcher, and bridges or Claude processes left running. It prints no conversation text or credentials.
