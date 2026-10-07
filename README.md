# harnexus

Use Claude in the Codex App.

## Concept

Choose Claude from the model picker and work in a regular chat. Ask it to explore a project, make changes, or work with a Codex reviewer—all from the same app.

harnexus uses your Claude subscription through the official Claude Agent SDK, or Claude on Google Vertex AI for the repositories you choose. It is experimental and currently runs on macOS.

## Features

- **Work with Claude**: Follow responses and tool execution as they appear in your chat.
- **Stay involved**: Send follow-up instructions, stop a task, approve or reject operations, and answer Claude's questions in the app.
- **Work with Codex**: Have Claude request a Codex review and continue from the feedback without copying messages between chats.
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

Open an existing Claude chat to send another request. You can choose another Claude model in the same chat. To work with a Codex model, use a separate chat; a Claude chat cannot switch back to Codex.

If the app closed during Claude's work, send a new message to continue. The chat shows an interruption notice, and Claude checks the current state before proceeding. Automatic retries and messages from other chats do not resume work with an unknown outcome. If recovery is unavailable with an older App/CLI pair, update the app and reopen it with harnexus.

Editing or rewinding a message rewinds the conversation. Files already changed remain as they are.

### Attach images

Attach or paste images to ask Claude about them, including while Claude is working. Reopened chats show the images you sent.

PNG, JPEG, GIF, and WebP are supported; large images are reduced automatically. Audio and other attachments are not supported.

### Reopen the app

Use `bun run open-app` each time you want to start the app with harnexus. The app reads its environment only at startup, so quit it first if it is already running.

To return to the app's standard setup, quit it and run:

```sh
bun run open-app --standard
```

Your Claude chats remain unavailable until you open the app with harnexus again.

## Troubleshooting

### Claude does not appear or a chat will not start

First, make sure you quit the app before opening it with `bun run open-app`. Then check your setup:

```sh
bun run doctor
```

The report checks installed versions, your Claude login, saved state, the launcher, and any bridge or Claude processes left running. It prints no conversation text or credentials.

### After an app update

harnexus warns when the app bundles a Codex CLI version it has not been checked on. To keep Claude disabled on an unverified version, launch with:

```sh
HARNEXUS_UNVERIFIED_CODEX=pause bun run open-app
```

## Use Google Vertex AI for a repository

Chats use your Claude subscription. To run a repository's chats on Claude through Google Vertex AI instead:

1. Set up Vertex AI in the repository's `.claude/settings.local.json`, as for `claude` in a terminal. If `claude` already runs on Vertex AI there, skip this step.

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
3. In a chat in that repository, pick a model marked `· Vertex AI`, such as `Claude Opus 5.5 · Vertex AI`.

Before Claude's first reply, the chat shows the Google Cloud project and region it runs on. Send `/session` to see them again. Other repositories stay on your subscription.

For the Google Cloud side, see [Claude Code on Google Vertex AI](https://code.claude.com/docs/en/google-vertex-ai). Keep Vertex AI settings out of `~/.claude/settings.json`, since they would apply to every repository.

harnexus never falls back to your subscription. Errors from Google Cloud, such as missing credentials or a model not enabled in your project, appear in the chat; the guide above covers them.

## Optional Settings

### Automatic approvals

Claude chats use auto mode by default to reduce routine permission prompts. Start the app normally with `bun run open-app`.

Claude's classifier allows or blocks actions before they run. Your explicit `ask` rules still require approval, and `deny` rules still block actions. Plan mode stays available; approving a plan returns Claude to the configured approval mode.

Auto mode requires a supported Claude model and an account where it is enabled. If Claude cannot enable it, the chat reports an error. Some classifier denials do not offer an approval prompt. The app's **Approve for me** setting does not control Claude approvals.

To use manual approvals, quit the app and reopen it with:

```sh
HARNEXUS_PERMISSION_MODE=default bun run open-app
```

Leaving the variable unset or setting it to `auto` uses auto mode. The choice applies to all Claude chats opened with that app launch, including resumed conversations.

### Claude effort

Choose the effort level in the app. A `maxEffortLevel` in your project's `.claude/settings.json` takes precedence: choosing `max` with `"maxEffortLevel": "low"` still runs Claude at `low`.

### Run Explore on Haiku

Claude's built-in Explore subagent uses the chat's model. To use Haiku instead, create `.claude/agents/Explore.md` in your project with `name: Explore`, `model: haiku`, and `tools: Glob, Grep, Read` in its frontmatter.

Write the agent's instructions in the file body: this replaces the built-in Explore agent, including its instructions. The same file also works in Claude Code on its own.

### Custom paths

Set `HARNEXUS_APP_PATH` if the app is installed somewhere else. `HARNEXUS_LOG_PATH` and `HARNEXUS_STATE_PATH` set in your shell are passed to the app by `bun run open-app`; both must be absolute paths.

## harnexus-task

`harnexus-task` launches task workers and requests reviews in the app for the `task-*` skills. It renders a fixed prompt from the installed skill templates in `$CODEX_HOME/skills`, creates the thread or sends the message through harnexus, and records each send under `~/.local/state/taskctl/` so a send with an unknown result is never repeated. Its subcommands are `launch`, `review`, `state` and `resolve`; it replaces the `taskctl` script and continues the sessions it recorded.

It needs the app opened with `HARNEXUS_CALL_SOCKET=on bun run open-app`, and runs outside the sandbox. Build a standalone executable at `dist/harnexus-task` with:

```sh
bun run build:task
```

Or run it from source with `bun run task <subcommand> ...`.
