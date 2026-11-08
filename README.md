# harnexus

Use Claude in the Codex App.

Lightweight and secure, with few dependencies.

Built on Anthropic's official Claude Agent SDK, following [Anthropic's authentication requirements](https://code.claude.com/docs/en/legal-and-compliance#authentication-and-credential-use). Sign-in is handled by Claude Code.

<img width="445" height="511" alt="Claude chat in the Codex App" src="https://github.com/user-attachments/assets/c5424fe5-50a6-48b9-bc43-98259c427658" />

## Get started

- Experimental; macOS only.
- ChatGPT app at `/Applications/ChatGPT.app` (override with `HARNEXUS_APP_PATH`).
- Claude Code already signed in.
- Anthropic [currently counts Agent SDK and third-party app usage toward subscription limits](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan).

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

- Claude chats cannot switch to Codex, but you can use Codex in a side chat.

You're all set. Go build something!

## Features

### Claude in the Codex App

Use Claude in regular app chats.
Claude can coordinate work with Codex through the Codex App Server, creating chats and messaging them directly.

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

## Return to standard Codex

Quit the app, then run:

```sh
bun run open-app --standard
```
