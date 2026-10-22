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
- Bun installed. This project pins Bun 1.3.13.
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

For the `task-*` skills, install the worker and review launcher:

```sh
bun run install:task
```

This installs `harnexus-task` in `~/.local/bin`.
It requires the `task-*` skills in `$CODEX_HOME/skills`.
Coordinate from a Codex chat by default, or explicitly select Claude; workers default to Claude and reviewers to Codex.
A worker that opened its PR runs `harnexus-task name --pr <URL>`, which keeps its chat's launch title and appends `PR#<number>` so a search for the PR finds it.
Reviewers read the worker's checkout and run in `~/review-home` instead of a worktree of their own, so create that empty folder and add it to the Codex app as a project before the first review.

The command runs outside the sandbox.
Allow-list only the installed command, such as `harnexus-task launch`, without leading environment assignments.
Never allow-list `bun run task` or the repository's `dist/` binary: sandboxed agents can modify those files.
Keep the installed executable outside sandbox-writable paths.

The app's call socket lets processes running as your user create and message chats.
To disable it, launch with `HARNEXUS_CALL_SOCKET=off bun run open-app`.
