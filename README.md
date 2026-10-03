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
- Claude Code signed in with your Claude subscription, or [Google Vertex AI](#use-google-vertex-ai-for-a-repository) set up for the repositories that should use it. API keys and other cloud providers are not supported.

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

The report checks installed versions, your connection settings, your Claude login, saved state, the launcher, and any bridge or Claude processes left running. It prints no conversation text or credentials.

### After an app update

harnexus warns when the app bundles a Codex CLI version it has not been checked on. To keep Claude disabled on an unverified version, launch with:

```sh
HARNEXUS_UNVERIFIED_CODEX=pause bun run open-app
```

## Use Google Vertex AI for a repository

Every chat uses your Claude subscription unless you choose otherwise. To run the chats of a repository on Claude through Google Vertex AI instead, for example a side project billed to its own Google Cloud project, list the repository in `~/.config/harnexus/connections.json`:

```json
{
  "repositories": {
    "/Users/you/src/side-project": {
      "provider": "vertex",
      "projectId": "sidework-project",
      "region": "global"
    }
  }
}
```

- Use the repository's absolute path. Folders inside it and the worktrees Codex creates for it use the same connection.
- Other repositories stay on your subscription, and chats on different connections can run at the same time.
- harnexus reads the file for each message, so a change applies without restarting the app.

### Set up Google Cloud

Follow [Claude Code on Google Vertex AI](https://code.claude.com/docs/en/google-vertex-ai) for the Google Cloud side: enable the Vertex AI API in the project, enable the Claude models you want in Model Garden, and sign in with `gcloud auth application-default login`. harnexus passes the project and region to Claude Code; Google Cloud handles authentication and billing.

Keep the Vertex setup in this file only. If Claude Code's own settings set variables such as `CLAUDE_CODE_USE_VERTEX`, `ANTHROPIC_VERTEX_PROJECT_ID` or `CLOUD_ML_REGION`, for example in the `env` block that `/setup-vertex` writes to `~/.claude/settings.json`, remove them: harnexus refuses to start Claude when they would override the repository's connection or bypass the subscription.

### Optional keys

| Key | Use |
| --- | --- |
| `credentialsFile` | Absolute path to a service account key or credential configuration file to use instead of your Application Default Credentials. Keep the file outside your repositories. |
| `models` | Pins Claude Code's `opus`, `sonnet` and `haiku` aliases to model IDs enabled in your project, such as `{ "haiku": "claude-haiku-4-5@20251001" }`. Subagents and background tasks use these aliases. |
| `modelRegions` | Sets the region for a model not offered in `region`, such as `{ "VERTEX_REGION_CLAUDE_HAIKU_4_5": "us-east5" }`. |

To keep a folder inside a Vertex repository on your subscription, list that folder with `{ "provider": "subscription" }`. To use another file, set `HARNEXUS_CONNECTIONS_PATH` to its absolute path before `bun run open-app`.

### In a chat

- **First reply**: Before Claude's first reply, harnexus shows the provider Claude Code reported and the Google Cloud project and region from your settings. Claude Code reports the provider without contacting Google Cloud, so the note does not confirm your credentials or the billing account. Chats on your subscription show no note.
- **`/session`**: Shows the connection again, with a terminal command that resumes the conversation on the same project and region.
- **Changed settings**: A chat keeps the connection it started on. If you change the repository's setting later, harnexus stops before sending your next message and tells you what changed. Restore the setting to continue as before, or send `/switch-connection` to move the chat to the new connection.
- **Models**: The model picker lists the same Claude models for every repository. In a Vertex chat, pick a model enabled in your project.

### When something fails

harnexus never falls back to your subscription or another billing route. The failure appears in the chat:

| Message | What to do |
| --- | --- |
| `Could not load Google Cloud credentials` | Run `gcloud auth application-default login`, or check the path in `credentialsFile`. |
| `model not found` (404) | Enable the model in Model Garden, check that it is offered in your region, or set `models` or `modelRegions`. |
| `429` or a quota error | Request more quota in the Google Cloud console, or try the `global` region. |
| `harnexus connection settings in …` or `harnexus cannot read its connection settings …` | Fix the file named in the message. `bun run doctor` reports the same problem. |
| `Claude settings must not set …` | Remove the named variables from the `env` block of Claude Code's settings. |
| `Claude Code did not report Google Vertex AI …` | Check that no other provider variable reaches Claude Code, then send the message again. |

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
