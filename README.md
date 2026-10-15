# harnexus

Use Claude in the Codex App.

Also supported:

- Side chats
- Rewind
- Image attachments
- Conversation resume
- Claude workers and Codex reviewers

Experimental, macOS only. Uses your Claude subscription through the official
Claude Agent SDK, with optional Google Vertex AI support per repository.

## Quick Start

### Before you start

You need:

- macOS with Codex available in the ChatGPT app at `/Applications/ChatGPT.app`.
- Bun installed. This project pins Bun 1.3.13.
- Claude Code signed in with your Claude subscription, or
  [Google Vertex AI](#use-google-vertex-ai-for-a-repository) configured per repository.
  API keys and other cloud providers are not supported.

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

Launch with `bun run open-app` whenever you use harnexus. To return to the standard
app, quit it and run `bun run open-app --standard`.

## Troubleshooting

If Claude does not appear or a chat will not start, quit the app completely and reopen
with `bun run open-app`. If the problem persists, run:

```sh
bun run doctor
```

You can paste the report into a bug report; it contains no conversation text or
credentials.

After an app update, harnexus warns about unverified Codex CLI versions. To keep Claude
disabled until the version is verified, launch with:

```sh
HARNEXUS_UNVERIFIED_CODEX=pause bun run open-app
```

## Use Google Vertex AI for a repository

To use Vertex AI instead of your Claude subscription:

1. Configure Vertex AI in the repository's `.claude/settings.local.json`, following
   [Claude Code on Google Vertex AI](https://code.claude.com/docs/en/google-vertex-ai).
2. Open the app with `HARNEXUS_VERTEX=on bun run open-app`.
3. Pick a model marked `· Vertex AI` in a chat in that repository.

Other repositories stay on your subscription. Vertex AI errors never fall back to
subscription access. Keep Vertex AI settings out of `~/.claude/settings.json`,
where they would apply to every repository.

## Optional Settings

Claude uses auto mode by default, which requires a supported model and account.
Your `ask` and `deny` rules still apply. The app's **Approve for me** setting does
not control Claude approvals.

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

This installs `harnexus-task` in `~/.local/bin`. It requires the `task-*` skills in
`$CODEX_HOME/skills`. Coordinate from a Codex chat by default, or explicitly select
Claude; workers default to Claude and reviewers to Codex.

The command runs outside the sandbox. Allow-list only the installed command, such as
`harnexus-task launch`, without leading environment assignments. Never allow-list
`bun run task` or the repository's `dist/` binary: sandboxed agents can modify those files.
Keep the installed executable outside sandbox-writable paths.

The app's call socket lets processes running as your user create and message chats. To
disable it, launch with `HARNEXUS_CALL_SOCKET=off bun run open-app`.
