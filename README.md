# harnexus

Use Claude in the Codex App.

<img width="445" height="511" alt="Claude chat in the Codex App" src="https://github.com/user-attachments/assets/c5424fe5-50a6-48b9-bc43-98259c427658" />

Ask Claude to implement a change and have Codex review it in a separate chat. Open the review from the sidebar and keep talking to Codex there.

## Get started

Clone, install, and reopen your ChatGPT app. You can switch back to standard Codex at any time.

On macOS, sign in to Claude Code if you haven’t already, then run:

```sh
git clone https://github.com/riii111/harnexus.git
cd harnexus
bun install
```

Quit the ChatGPT app completely, then open it with harnexus:

```sh
bun run open-app
```

Start a new chat in your project and choose a Claude model.

To switch back, quit the app completely and run `bun run open-app --standard`. Your chats stay in place.

## How it works

![The Codex App connects through harnexus to the bundled Codex app-server and the Claude Agent SDK. Claude can use the app-server to create and message another chat.](docs/harnexus.svg)

harnexus is a local app-server proxy. Claude uses the bundled Codex app-server to create chats, send messages, and read replies.

Claude chats run through Anthropic’s [official Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview). harnexus checks your Claude Code login before sending a prompt and rejects API-key or third-party provider authentication. [Claude plan limits apply](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan).

## Features

### Claude chats

Use Codex in a separate chat or a side chat. Claude can archive chats when the work is done.
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

For manual approvals, quit the app and reopen with:

```sh
HARNEXUS_PERMISSION_MODE=default bun run open-app
```

- Launch options persist until you rerun `bun run open-app`; omitted options are cleared.

## Troubleshooting

harnexus is experimental and expects the app at `/Applications/ChatGPT.app`. Set `HARNEXUS_APP_PATH` if yours is elsewhere.

`open-app` configures the macOS launch environment and a LaunchAgent. `--standard` clears those settings and removes the LaunchAgent.

If Claude is missing or a chat will not start, quit the app completely and run `bun run open-app` again.
Also rerun it after moving the harnexus folder or changing Bun's location.
Run diagnostics:

```sh
bun run doctor
```

Collect diagnostics for a bug report:

```sh
bun run feedback --since 2h
```

Review the output before attaching it to a [bug report](https://github.com/riii111/harnexus/issues/new?template=bug-report.yml).
