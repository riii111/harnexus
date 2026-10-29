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

To report a bug, run this with `--since` covering when the problem happened, such as `30m`, `2h` or `2026-10-24T18:30`:

```sh
bun run feedback --since 2h
```

Read the output, then paste all of it into a [bug report](https://github.com/riii111/harnexus/issues/new?template=bug-report.yml).
It contains no conversation text, code or credentials; paths under your home folder appear as `~`.

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

The app's call socket lets processes running as your user create and message chats.
To disable it, launch with `HARNEXUS_CALL_SOCKET=off bun run open-app`.

## harnexus-task in Codex Cloud

`harnexus-task` can tell where it runs, and can run Claude inside a Cloud task.
It cannot create or resume other Cloud tasks, so those commands fail with that reason.

```sh
harnexus-task environment
```

prints `{"environment": "cloud" | "local" | "unknown", "source": ..., "note": ...}`.
The first match decides:

1. `HARNEXUS_EXECUTION_ENV=cloud|local`. Any other value is an error.
2. A nonempty `CODEX_ENVIRONMENT_ID` means `cloud`.
   This is a variable observed in Cloud tasks, not a documented guarantee; the value is never printed.
3. `local` only when the harnexus call socket accepts a connection.
   A missing variable alone never means local.
4. Otherwise `unknown`.

In Cloud, `launch`, `review`, `resolve`, `name`, `watch` and `state --request` need the Codex App, so they fail with a message naming Cloud.
Pin `HARNEXUS_EXECUTION_ENV=local` where `CODEX_ENVIRONMENT_ID` is set but the App is reachable.

Claude runs inside the current task through the `claude-cloud` wrapper (default `/workspace/.cloud-setup/bin/claude-cloud`, override with an absolute `HARNEXUS_CLAUDE_CLOUD_BIN`):

```sh
harnexus-task claude --session NAME --start  --prompt-file FILE [--model M] [--cwd DIR] [--permission-mode auto|plan]
harnexus-task claude --session NAME --resume --prompt-file FILE
harnexus-task claude --session NAME
```

- It runs `claude -p --output-format json --permission-mode auto`, with the prompt on stdin, and prints the result, the `sessionId` and the state path as JSON.
- `--resume` runs `--resume <session_id>` in the directory the session started in.
  The state is kept under `$XDG_STATE_HOME/taskctl/cloud-claude/`; only a well-formed `session_id` is recorded.
- A session is a fresh context in the same task, not another Cloud task.
  It lasts as long as the task's filesystem; a new Cloud task starts with none.
- A turn that fails after Claude started keeps its session, so the next call resumes it.
  An unreachable network (wrapper exit 75) sends nothing and records nothing.
