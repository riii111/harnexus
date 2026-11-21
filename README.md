# harnexus

Give Claude a seat next to Codex in ChatGPT.

Lightweight and secure, with few dependencies.

<img width="445" height="511" alt="Claude chat in the Codex App" src="https://github.com/user-attachments/assets/c5424fe5-50a6-48b9-bc43-98259c427658" />

Ask Claude to implement a change and have Codex review it in a separate chat.
Open the review from the sidebar and keep talking to Codex there.

Or try asking your ChatGPT dot to bring Claude in to review a plan.

## Get started

harnexus is experimental and runs on macOS with the ChatGPT app and a signed-in Claude Code account.
A macOS installer is not yet available.

With the harnexus CLI installed, quit the ChatGPT app completely and run:

```sh
harnexus open-app
```

Start a new chat in your project and choose a Claude model.
To return to standard Codex, quit the app completely and run `harnexus open-app --standard`.
Your chats stay in place.

## How it works

![The Codex App connects through harnexus to the bundled Codex app-server and the Claude Agent SDK. Claude can use the app-server to create and message another chat.](docs/harnexus.svg)

harnexus is a local app-server proxy.
Through the bundled Codex app-server, Claude can:

- Start a new Codex chat in your project.
- Send a message to another thread and read its reply.

Try a second opinion before you write any code: ask Claude to sketch a plan and have Codex look for a simpler approach.

Claude chats run through Anthropic’s [official Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview).
harnexus checks your Claude Code login before sending a prompt and rejects API-key or third-party provider authentication.

[Claude plan limits apply](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan).

## Features

### Claude chats

Use Codex in a separate chat or a side chat.

Claude can archive chats when the work is done.
A chat that archives itself is archived after its reply, unless that turn is stopped or another message is waiting.

### In-app browser

Ask a local Claude chat to check a page in the in-app browser.

### Claude Cloud sessions

Use [Claude Code cloud sessions](https://code.claude.com/docs/en/claude-code-on-the-web) from a new Claude chat:

- `/cloud <request>`: Start a new session.
- `/cloud <session ID or URL>`: Continue an existing session.

Each worker session opens its own chat in the same project.

- New sessions use Auto mode.
- Updates may take a few minutes to appear.
- Cloud chats are text-only.
- Stop Cloud sessions at claude.ai; the app only stops waiting for replies.

## Approvals

- Auto mode by default; requires a supported model and account.
- Claude Code permission rules still apply.
- The app's **Approve for me** setting does not control Claude approvals.

For manual approvals, quit the app completely and run:

```sh
HARNEXUS_PERMISSION_MODE=default harnexus open-app
```

## Troubleshooting

If Claude is missing or a chat will not start, quit the app completely and run `harnexus open-app` again.
To check your setup, run `harnexus doctor`.

To collect diagnostics from the last two hours, run:

```sh
harnexus feedback --since 2h
```

Review the output before attaching it to a [bug report](https://github.com/riii111/harnexus/issues/new?template=bug-report.yml).
Run `harnexus --help` for the full command list.
