# harnexus

Use Claude in the Codex App.

## Concept

Choose Claude from the model picker and work in a regular chat. Ask it to explore a project, make changes, or coordinate Claude workers and Codex reviewers—all from the same app.

harnexus uses your Claude subscription through the official Claude Agent SDK, or Claude on Google Vertex AI for the repositories you choose. It is experimental and currently runs on macOS.

## Features

- **Work with Claude**: Follow responses and tool execution as they appear in your chat.
- **Stay involved**: Send follow-up instructions, stop a task, approve or reject operations, and answer Claude's questions in the app.
- **Work with Codex**: Have Claude request a Codex review and continue from the feedback without copying messages between chats. As in a Codex chat, a message another chat sends while Claude is working reaches Claude at its next step.
- **Pick up where you left off**: Reopen Claude chats after restarting the app and continue the conversation.
- **Use your project instructions**: Work with your existing `CLAUDE.md` and attach skills from the app.

## Quick Start

### Before you start

You need:

- macOS with Codex available in the ChatGPT app at `/Applications/ChatGPT.app`.
- Bun installed. This project pins Bun 1.3.13.
- Claude Code signed in with your Claude subscription, or [Google Vertex AI](#use-google-vertex-ai-for-a-repository) set in the Claude Code settings of the repositories that should use it. API keys and other cloud providers are not supported.

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

In Codex, start a new chat in your project, choose a Claude model from the model picker, and send a request. For example:

> Explain what this project does and where its main user flow starts.

Claude's response and tool activity appear in the chat. Run all `bun run` commands below from the harnexus directory.

## Everyday Use

### Continue a conversation

Reopen a Claude chat to continue or choose another Claude model. To use Codex, start a
separate chat; Claude chats cannot switch back to Codex.

If the app closed during a task, send a new message to resume. Claude checks the current
state before proceeding. Editing or rewinding a message rewinds the conversation, but
keeps files already changed.

### Open a side chat

Open a side chat from Claude or Codex and choose either model before its first message.
After that, its model is fixed.

The side chat receives a snapshot of the main conversation, without tool calls or their
output. Later messages are not shared, and long conversations may omit turns. Restate
any instructions it needs. Claude side chats follow the app's side chat instructions,
including not editing files unless you ask.

If the conversation could not be read, the side chat keeps the main chat's model. If it
stops accepting messages, open a new side chat.

### Attach images

Paste or attach PNG, JPEG, GIF, or WebP images, including while Claude is working. Large
images are reduced automatically. Audio and other attachments are not supported.

### Reopen the app

Quit the app, then run `bun run open-app` each time you want to use harnexus.

To return to the app's standard setup, quit it and run:

```sh
bun run open-app --standard
```

Your Claude chats become available again when you reopen with harnexus.

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
   [Claude Code on Google Vertex AI](https://code.claude.com/docs/en/google-vertex-ai):

   ```json
   {
     "env": {
       "CLAUDE_CODE_USE_VERTEX": "1",
       "ANTHROPIC_VERTEX_PROJECT_ID": "your-project",
       "CLOUD_ML_REGION": "global"
     }
   }
   ```

2. Open the app with `HARNEXUS_VERTEX=on bun run open-app`.
3. Pick a model marked `· Vertex AI` in a chat in that repository.

The chat shows the Google Cloud project and region before Claude's first reply;
`/session` shows them again. Other repositories stay on your subscription. Vertex AI
errors appear in the chat, without falling back to your subscription.

Keep Vertex AI settings out of `~/.claude/settings.json`, where they would apply to
every repository.

## Optional Settings

### Approvals

Claude uses auto mode by default. Explicit `ask` and `deny` rules still apply. Auto mode
requires a supported model and account; if unavailable, the chat reports an error. Some
blocked actions offer no approval prompt. The app's **Approve for me** setting does not
control Claude approvals.

For manual approvals, quit the app and reopen with:

```sh
HARNEXUS_PERMISSION_MODE=default bun run open-app
```

The choice applies to all Claude chats for that app launch, including resumed chats.

### Effort and paths

Choose Claude's effort level in the app. Your project's `maxEffortLevel` setting takes
precedence.

- `HARNEXUS_APP_PATH`: Use an app installed somewhere else.
- `HARNEXUS_STATE_PATH`: Set an absolute path for saved state.
- `HARNEXUS_LOG_PATH`: Set an absolute log path, or `off` to disable file logging.
  By default, the log is beside the state file.

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
