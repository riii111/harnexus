# harnexus
[draft] An intermediary for using multiple agent execution environments from the Codex App.

## Claude effort levels

A `maxEffortLevel` in a project's `.claude/settings.json` takes precedence, so Claude may run at a lower effort than the one picked in the Codex App (e.g. `max` picked, `low` run with `"maxEffortLevel": "low"`).

## Unverified Codex CLI versions

The bridge logs the Codex CLI version the app bundles and warns when harnexus was not checked on it. Set `HARNEXUS_UNVERIFIED_CODEX=pause` to hide the Claude models and refuse Claude turns on such a version instead.

## Opening the app with harnexus

Quit the ChatGPT app, then run `bun run open-app` to open it with harnexus, and `bun run doctor` to check the setup. Run `bun run open-app --standard` after quitting it to go back to the app as it normally runs; Claude threads then stay unavailable until the app is opened with harnexus again. The app reads these settings only when it starts, so each launch needs the command. `HARNEXUS_LOG_PATH`, `HARNEXUS_STATE_PATH` and `HARNEXUS_UNVERIFIED_CODEX` set in the shell are passed on.

## Checking the setup

Run `bun run doctor` to check the app, Codex CLI, Claude Agent SDK and Bun versions, the Claude login, the state file, the launcher, and bridges or Claude processes left running. It prints no conversation text or credentials.
