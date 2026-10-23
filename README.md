# harnexus

Use Claude in the Codex App.

<img width="445" height="511" alt="image" src="https://github.com/user-attachments/assets/c5424fe5-50a6-48b9-bc43-98259c427658" />


Also supported:

- Side chats
- Rewind
- Image attachments
- Conversation resume

Claude and Codex can exchange messages across chats, and Claude can create Codex chats.

Experimental, macOS only.
Claude runs on your own Claude Code login through the official Claude Agent SDK; harnexus never reads or stores your credentials.
Usage counts toward your own Claude plan under [Anthropic's terms](https://code.claude.com/docs/en/legal-and-compliance).

## Quick Start

### Before you start

You need:

- macOS with Codex available in the ChatGPT app at `/Applications/ChatGPT.app`.
- Bun installed. This project pins Bun 1.4.4.
- Claude Code signed in to your Claude account.
  API keys and cloud providers are not supported.

### Install and open

Clone the repository and install its dependencies:

```sh
git clone https://github.com/riii111/harnexus.git
cd harnexus
bun install
```

Quit the ChatGPT app completely, then open it with harnexus:

```sh
bun run open-app
```

In Codex, start a new chat in your project and choose a Claude model.
Claude chats cannot switch back to Codex; use a separate chat for Codex.

Setup persists across Dock launches, app updates, and logins.
Keep this checkout and Bun at their current paths.
To change paths or options, quit the app and rerun `bun run open-app`; omitted options are cleared.
To remove the setup, quit the app and run `bun run open-app --standard`.

After updating Bun or the Claude Agent SDK, wait for running tasks to finish,
then quit and reopen the app with `bun run open-app` to use the updated runtime and dependencies.

## Troubleshooting

If Claude does not appear or a chat will not start, quit the app completely and reopen with `bun run open-app`.
If the problem persists, run:

```sh
bun run doctor
```

You can paste the report into a bug report; it contains no conversation text or credentials.

If harnexus cannot start, the app falls back to standard Codex.
If incompatibility is detected while running, Claude becomes unavailable for that connection.
Run `bun run doctor` for details.

To use standard Codex whenever the bundled Codex CLI is unverified, quit the app and run:

```sh
HARNEXUS_UNVERIFIED_CODEX=fallback bun run open-app
```

## Optional Settings

Claude uses auto mode by default, which requires a supported model and account.
Your `ask` and `deny` rules still apply.
The app's **Approve for me** setting does not control Claude approvals.

For manual approvals, quit the app and reopen with:

```sh
HARNEXUS_PERMISSION_MODE=default bun run open-app
```

The choice applies to all Claude chats for that app launch, including resumed chats.

Set `HARNEXUS_APP_PATH` if the app is installed outside `/Applications/ChatGPT.app`.

## harnexus-task

`harnexus-task` starts worker chats in Git worktrees and sends their commits to reviewer chats, with first messages built from [templates](#prompt-templates) you write.
Install it:

```sh
bun run install:task
```

This installs `harnexus-task` in `~/.local/bin`.
The executable includes the Bun runtime used to build it. Run `bun run install:task`
again with the pinned Bun version after a runtime security update.
Coordinate from a Codex chat by default, or explicitly select Claude; workers default to Claude and reviewers to Codex.
A worker that opened its PR runs `harnexus-task name --pr <URL>`, which keeps its chat's launch title and appends `PR#<number>` so a search for the PR finds it.
Reviewers read the worker's checkout and run in `~/review-home` instead of a worktree of their own, so create that empty folder and add it to the Codex app as a project before the first review.

The command runs outside the sandbox.
Allow-list only the installed command, such as `harnexus-task launch`, without leading environment assignments.
Never allow-list `bun run task` or the repository's `dist/` binary: sandboxed agents can modify those files.
Keep the installed executable outside sandbox-writable paths.

The app's call socket lets processes running as your user create and message chats.
To disable it, launch with `HARNEXUS_CALL_SOCKET=off bun run open-app`.

### Prompt templates

Set the templates in `~/.config/harnexus/task.json`:

```json
{
  "templates": {
    "worker": "/Users/you/.config/harnexus/templates/worker.md",
    "reviewer": "/Users/you/.config/harnexus/templates/reviewer.md"
  }
}
```

The folder is `$XDG_CONFIG_HOME/harnexus` when `XDG_CONFIG_HOME` is an absolute path, and `~/.config/harnexus` otherwise.
`launch` reads `worker` and `review` reads `reviewer`; each fails before sending anything when its template is not set or missing.
Paths must be absolute.

A template is the chat's first message, with `{name}` replaced by the request's value.
Write `{{` and `}}` for literal braces; any other brace or an unknown name is an error.

- Worker: `task_id`, `document_refs` (one `- ` line per reference) and `completion_target` (`implementation`, `draft_pr` or `merge`).
- Reviewer: `task_id`, `document_refs`, `worker_ai` (`Claude` or `Codex`), `worker_chat_id`, `checkout`, `base`, `head` and `pr_url` (`null` without a PR).

A relative inline Markdown link target is resolved against the folder of the template's real file and replaced with that file's real path.
This is how a template attaches a skill, since the app attaches a skill named as `[$name](/absolute/path/SKILL.md)`.
Write the target bare, without angle brackets, spaces or a title; a missing file, or a real path with a space, parenthesis, `#` or backslash, is an error.
Fields may appear inside such a target, as in `reply-{worker_ai}.md`, when their values hold only letters, digits, `_` and `-`.
Links in code spans and fenced code blocks, reference definitions, absolute paths, URLs, `#` anchors and targets that open with a field, such as `{pr_url}`, are left to their values, and links inside the request's values are never resolved.

```md
Task {task_id}. Go as far as {completion_target}.
{document_refs}

[$my-worker](skills/my-worker/SKILL.md)
```

The templates and the skills they link to become instructions to chats that can act outside the sandbox, so keep them, like the config, outside sandbox-writable paths.
The author's own templates and skills, in Japanese, are in [riii111/dotfiles](https://github.com/riii111/dotfiles/tree/main/dot_codex/skills) as an example; they are not supported for other setups.

### Watching PRs

`harnexus-task watch` runs until stopped and tells the worker of each PR named with `name --pr` what needs its attention: review comments, a finished review by an AI review bot such as CodeRabbit, a conflict with the base, and a failed required check.
It sends one message per PR, with each item's kind, place and link but not its text.
Every message comes from one chat you register: run `harnexus-task watch --sender` once in a chat you keep for that.
Until a chat is registered, nothing is sent, and `name --pr`, `watch --link` and `watch --status` say so.
It never writes to GitHub.

It waits while the worker's turn runs, for five minutes after you talk to the worker, and during the quiet hours.
It watches open PRs that are not drafts, ends with a merge or close, and stops for a worker chat that no longer exists.
The first time it reads a PR, it takes everything already there as seen and sends nothing; from then on only what is new is reported.
If it cannot confirm that a message arrived, it stops sending for that PR; check the worker chat, then run `harnexus-task watch --release <PR URL>` to resume.

Configure it in `~/.config/harnexus/pr-watch.json`:

```json
{
  "repositories": { "owner/repo": { "account": "your-login" } },
  "reviewBots": ["coderabbit"],
  "ignore": [{ "author": "github-actions[bot]", "kind": "issue_comment" }]
}
```

- `repositories`: the gh account that reads each repository, so switching the active account never breaks the watch.
  That account's own comments are never reported.
- `reviewBots`: the AI review bots to wait for, `["coderabbit"]` when left out.
  Name the preset `coderabbit`, or describe another bot:

  ```json
  {
    "id": "other",
    "name": "OtherBot",
    "login": "other-reviewer[bot]",
    "status": { "context": "Other Review", "completed": "Review completed" },
    "actionableReview": "Actionable comments",
    "noActionable": "No issues found",
    "severity": "\\*\\*(Critical|Major|Minor)\\*\\*"
  }
  ```

  `id` keys the bot's reviews in the watch's records, so keep it when other fields change.
  `status` is the commit status the bot keeps while it reviews; the watch holds the bot's findings until it reads `completed` there and then sends them with the completion in one message.
  Without `status`, findings are sent as they come.
  `actionableReview`, `noActionable` and `severity` are optional: review bodies without the first are skipped, a PR comment with the second is checked against the findings, and the first group of `severity` labels each inline finding.
  A bot's replies and its findings resolved before the watch read them are never reported.
- `ignore`: comments to skip by `author`, optionally narrowed by `kind` (`inline`, `review` or `issue_comment`) and `bodyIncludes`.
- `pollIntervalSeconds` (60), `idleIntervalSeconds` (600) after `idleAfterHours` (72) without changes, and `quietHours` (`{"start": "22:00", "end": "05:00"}`, or `null`).

To see what would be sent without sending anything, run `harnexus-task watch --dry-run`, optionally with `--pr <URL>` for each PR to check.
A PR the watch has not read yet shows `firstRead: true` and no message.
`harnexus-task watch --status` lists the registered sender and each linked PR with what its watch is doing.

`name --pr <URL>` links the PR to the calling chat whether or not `launch` started it, and renames only a launched worker.
It fails when it cannot link, as for a PR number alone, so a PR the watch cannot see is never taken as watched.
To have any chat told about a PR without renaming it, run `harnexus-task watch --link <URL>` from that chat.
`--link` refuses a PR whose watch still runs for another chat, including one halted on a message that may have reached it; a worker naming its PR with `name --pr` takes it over.
The running watch notices the new chat on its next cycle, sends it again the findings only the last chat was told, drops the answer it awaited from that chat, and resumes a watch that was stopped or halted for it. `watch --status` shows `handingOver` until then.
Both print a `warning` when nothing can send to the chat yet, and `name --pr` reports a rename the app did not apply as `renameError` while the PR stays watched.
A running watch notices when its `harnexus-task` is replaced, as by `bun run install:task`, and exits with a failure before its next cycle, so a LaunchAgent that restarts it on failure (`KeepAlive` with `SuccessfulExit: false`) starts the new binary.
It never exits in the middle of sending a message.
A watch started by hand ends the same way and has to be started again.
Run from source, or when it cannot inspect its binary at start, it logs `replace_check_off` and does not watch for a new binary.

Between cycles the watch only sleeps.
It keeps each gh account's token in memory for ten minutes rather than starting gh for every request, and stops reading the records of merged or closed PRs until it restarts.
A PR stopped because its worker chat was gone is watched again once another worker names it with `name --pr`.
The detection under `src/prwatch` reaches workers only through the `Workers` interface that `harnexus-task` fills with Codex chats.
