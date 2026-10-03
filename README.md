# harnexus

Use Claude in the Codex App.

## Concept

Choose Claude from the model picker and work in a regular chat. Ask it to explore a project, make changes, or work with a Codex reviewer—all from the same app.

harnexus uses your Claude subscription through the official Claude Agent SDK. It is experimental and currently runs on macOS.

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
- Claude Code signed in with your Claude subscription. API-key and cloud-provider authentication are not supported.

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

Claude chats currently accept text input only.

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

## Optional Settings

### Claude effort

Choose the effort level in the app. A `maxEffortLevel` in your project's `.claude/settings.json` takes precedence: choosing `max` with `"maxEffortLevel": "low"` still runs Claude at `low`.

### Run Explore on Haiku

Claude's built-in Explore subagent uses the chat's model. To use Haiku instead, create `.claude/agents/Explore.md` in your project with `name: Explore`, `model: haiku`, and `tools: Glob, Grep, Read` in its frontmatter.

Write the agent's instructions in the file body: this replaces the built-in Explore agent, including its instructions. The same file also works in Claude Code on its own.

### Custom paths

Set `HARNEXUS_APP_PATH` if the app is installed somewhere else. `HARNEXUS_LOG_PATH` and `HARNEXUS_STATE_PATH` set in your shell are passed to the app by `bun run open-app`; both must be absolute paths.

## Recording the app's traffic

To teach the bridge a feature it does not cover yet, such as the subagents panel Codex threads show, record how the app and the Codex CLI talk while you use that feature in a Codex thread. Set `HARNEXUS_TRACE_PATH` to an absolute path in the shell, then quit the app and open it again with `bun run open-app`:

```sh
export HARNEXUS_TRACE_PATH="$HOME/harnexus-trace.jsonl"
bun run open-app
```

Each line of the file is one message in either direction. Text is replaced by its length and each id by a token such as `<id 3>`, which stays the same across the file, so the trace shows which messages name the same thread without what anyone wrote; only kinds such as `type`, `status` and `method` stay as they are. Unset the variable and open the app again to stop recording.
