# harnexus
[draft] An intermediary for using multiple agent execution environments from the Codex App.

## Claude effort levels

The effort shown in the app's model picker for a Claude thread is the level harnexus asks Claude to use. With no level picked, it is the `effortLevel` in your user Claude settings (`~/.claude/settings.json`), or `high` when none is set, lowered to the `maxEffortLevel` there if any.

Claude may still run lower than shown when a cap is set outside your user settings, such as in a project's settings or by your organization. For example, with `{"maxEffortLevel": "low"}` in a project's `.claude/settings.json`, a thread in that project shows `max` when you pick it, while Claude runs at `low`.
