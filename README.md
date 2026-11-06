# harnexus

Use Claude alongside Codex in the Codex App.

Claude chats sit next to your Codex chats in the same workspace, with the app's approvals, questions, stop and history.
Chats can send messages to each other without copying them by hand.
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

## In-app browser

A local Claude chat can open a page in the app's in-app browser, read it, and click or type in it, so Claude can check a page it built. Each action follows your approval mode.
A message can also carry the app's own reference to a tab you have open (not an ordinary web address); the @ tab picker has not been verified for getting that reference. Claude then asks you to type `Allow` for that tab, and the permission lasts for that turn only. The site approvals the app shows still apply.

## Claude Cloud sessions

To follow a [Claude Code cloud session](https://code.claude.com/docs/en/claude-code-on-the-web), start a new Claude chat and send its session ID or URL:

```text
/cloud https://claude.ai/code/session_01AbC...
```

The conversation appears in the chat, and messages you send go to the Cloud session.
The chat stays busy until the session is done, including while it waits for a message it scheduled to itself or for work it left running in the background.
Worker sessions it creates also open as chats in the same project.
To start a new Cloud session instead, send `/cloud` followed by your request, or ask an agent in the app to do it in the Cloud. This needs `claude` signed in on this Mac. The session starts in Auto mode, so it and the workers it starts rarely stop for permission prompts.
Updates may take a few minutes to appear when you are not sending messages.

To let a skill act as `/cloud` when you pick it in an empty Claude chat, list it in `~/.config/harnexus/connection.json` and restart the app:

```json
{ "cloudSkills": ["my-cloud-skill"] }
```

To show another tool's conversations in their own chats, register its adapter program in the same file by an absolute path. Harnexus starts only that program and talks to it over its standard input and output. With `observe` it only reads the Cloud sessions shown here; with `write` it may also open chats, answer them and send to those sessions.

```json
{
  "externalConversationAdapter": {
    "id": "my-adapter",
    "command": "/absolute/path/to/adapter",
    "args": [],
    "mode": "observe"
  }
}
```

To open Cloud chats from scripts or skills, install the `harnexus` command, which runs this checkout with the current Bun:

```sh
bun run install:cli            # ~/.local/bin/harnexus; use --prefix DIR for another folder
harnexus cloud --link https://claude.ai/code/session_01AbC...
harnexus cloud --prompt-file request.md
```

Run it from a chat in the app. It opens a new chat for the session, or answers with the chat already showing it; it never switches the chat it runs in.
It remembers the chat it opened for each session, so a session never gets a second one.

To move those records to or from another tool, quit the app and stop every program that uses Harnexus, then run:

```sh
harnexus state export-cloud-links > cloud-links.json
harnexus state import-cloud-links --file cloud-links.json
```

Both refuse while a Harnexus bridge is running, and an app opened meanwhile starts without Claude. Import only adds records; it never removes or changes one already kept.

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
