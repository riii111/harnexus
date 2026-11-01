# harnexus

Use Claude alongside Codex in the Codex App.

Keep Claude and Codex in the same workspace, with separate chats for each.
Ask Claude to work on a task and Codex to review it, or send messages between chats without copying them by hand.
Claude chats support image attachments, side chats, rewind, and resuming conversations.

<img width="445" height="511" alt="Claude chat in the Codex App" src="https://github.com/user-attachments/assets/c5424fe5-50a6-48b9-bc43-98259c427658" />

Experimental. macOS only. Requires a Claude account signed in through Claude Code.
Usage counts toward your Claude plan under [Anthropic's terms](https://code.claude.com/docs/en/legal-and-compliance).
API keys and cloud provider accounts are not supported.

## Get started

You need the ChatGPT app with Codex at `/Applications/ChatGPT.app`, [Bun](https://bun.sh) 1.4.4, and Claude Code already signed in.
If the app is installed elsewhere, set `HARNEXUS_APP_PATH` when launching.

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
Use a separate chat for Codex; a Claude chat cannot switch back to Codex.

After setup, you can open the app from the Dock as usual.
Keep this checkout and Bun at their current paths.
After updating harnexus, Bun, or its dependencies, finish running tasks, quit the app, and run `bun run open-app` again.

## Approvals

Claude uses auto mode by default, which requires a supported model and account.
Your Claude Code `ask` and `deny` rules still apply.
The app's **Approve for me** setting does not control Claude approvals.

To approve tool requests manually, quit the app and reopen it with:

```sh
HARNEXUS_PERMISSION_MODE=default bun run open-app
```

Launch options are saved for future app launches.
Running `bun run open-app` again without an option clears that option.

## Claude Cloud sessions

To follow a [Claude Code cloud session](https://code.claude.com/docs/en/claude-code-on-the-web), start a new Claude chat and send its session ID or URL:

```text
/cloud https://claude.ai/code/session_01AbC...
```

The conversation appears in the chat, and messages you send go to the Cloud session.
Worker sessions it creates also open as chats in the same project.
To start a new Cloud session instead, send `/cloud` followed by your request, or ask an agent in the app to do it in the Cloud. This needs `claude` signed in on this Mac.
Updates may take a few minutes to appear when you are not sending messages.

Cloud chats support text only. Rewind, compact, and side chats are unavailable.
Stopping a turn in the app stops waiting for replies; to stop the Cloud session itself, use claude.ai.

## Troubleshooting

If Claude is missing or a chat will not start, quit the app completely and run `bun run open-app` again.
For diagnostics:

```sh
bun run doctor
```

To report a problem, collect diagnostics for the time it happened:

```sh
bun run feedback --since 2h
```

Read the output, then include it in a [bug report](https://github.com/riii111/harnexus/issues/new?template=bug-report.yml).
The report excludes conversation text, code, and credentials, and replaces your home directory with `~`.

## Return to standard Codex

Quit the app, then run:

```sh
bun run open-app --standard
```
