# harnexus

Use Claude in the Codex App.

<img width="445" height="511" alt="image" src="https://github.com/user-attachments/assets/c5424fe5-50a6-48b9-bc43-98259c427658" />

Also supported:

- Side chats
- Rewind
- Image attachments
- Conversation resume

Claude and Codex can exchange messages across chats, and Claude can create Codex chats.

Experimental, macOS only.
Claude runs on your own Claude Code login through the official Claude Agent SDK; harnexus never reads or stores your credentials.
Usage counts toward your own Claude plan under [Anthropic's terms](https://code.claude.com/docs/en/legal-and-compliance).

## Quick Start

### Before you start

You need:

- macOS with Codex available in the ChatGPT app at `/Applications/ChatGPT.app`.
- Bun installed. This project pins Bun 1.4.4.
- Claude Code signed in to your Claude account.
  API keys and cloud providers are not supported.

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

Setup persists across Dock launches, app updates, and logins.
Keep this checkout and Bun at their current paths.
To change paths or options, quit the app and rerun `bun run open-app`; omitted options are cleared.
To remove the setup, quit the app and run `bun run open-app --standard`.

After updating Bun or the Claude Agent SDK, wait for running tasks to finish,
then quit and reopen the app with `bun run open-app` to use the updated runtime and dependencies.

## Troubleshooting

If Claude does not appear or a chat will not start, quit the app completely and reopen with `bun run open-app`.
If the problem persists, run:

```sh
bun run doctor
```

To report a bug, run this with `--since` covering when the problem happened, such as `30m`, `2h` or `2026-10-24T18:30`:

```sh
bun run feedback --since 2h
```

Read the output, then paste all of it into a [bug report](https://github.com/riii111/harnexus/issues/new?template=bug-report.yml).
It contains no conversation text, code or credentials; paths under your home folder appear as `~`.

If harnexus cannot start, the app falls back to standard Codex.
If incompatibility is detected while running, Claude becomes unavailable for that connection.
Run `bun run doctor` for details.

To use standard Codex whenever the bundled Codex CLI is unverified, quit the app and run:

```sh
HARNEXUS_UNVERIFIED_CODEX=fallback bun run open-app
```

## Optional Settings

Claude uses auto mode by default, which requires a supported model and account.
Your `ask` and `deny` rules still apply.
The app's **Approve for me** setting does not control Claude approvals.

For manual approvals, quit the app and reopen with:

```sh
HARNEXUS_PERMISSION_MODE=default bun run open-app
```

The choice applies to all Claude chats for that app launch, including resumed chats.

Set `HARNEXUS_APP_PATH` if the app is installed outside `/Applications/ChatGPT.app`.

The app's call socket lets processes running as your user create and message chats.
To disable it, launch with `HARNEXUS_CALL_SOCKET=off bun run open-app`.

## Claude Cloud sessions in a chat

A Claude chat can show a [Claude Code cloud session](https://code.claude.com/docs/en/claude-code-on-the-web) and send it your messages.
Start a new Claude chat and send:

```text
/cloud session_01AbC...
```

The session id or its `claude.ai/code/...` URL both work.
The chat then shows the session's conversation; what you send there goes to the session, and its replies appear as they are copied.

- Messages are sent with `claude -p --cloud <id>`, and the session is copied with `claude --teleport <id> -p /cost`, which answers without a model turn.
  Both use the claude binary the Claude Agent SDK ships, which already holds the sign-in harnexus runs with; set `HARNEXUS_CLAUDE_CLI` to an absolute path to use another one.
  Copies are kept beside the thread state in `cloud-copies/`, and only the latest one per chat.
- After you send a message, the chat copies the session until Claude ends its turn, or for at most an hour: for the first 20 seconds, once a copy has worked, the next one starts 1.5 seconds after the one before it started without waiting for it to end, then it waits 3 seconds between copies until a minute has passed and 10 seconds after that.
  Otherwise it copies every 5 minutes, and shows what the session did meanwhile as a turn of Claude's own.
  While the Mac sleeps nothing is copied; the first copy after waking shows what happened.
- Stopping a turn here only stops waiting; the session keeps working until you stop it on claude.ai.
- A Cloud chat sends text only, and cannot be rewound, compacted or opened as a side chat.
  Messages sent while Claude is working are queued by the session and read between its tool calls.
- If the session compacts its conversation, earlier messages no longer appear in a later copy; the chat shows the conversation from the compaction on.
- A copy that ran a model turn, or did not report its turns, stops copies of that chat until the bridge restarts.
  `bun run doctor` shows whether `claude` offers `--cloud` and `--teleport`, and whether copies stopped in the last 24 hours.

## harnexus-task in Codex Cloud

`harnexus-task` can tell where it runs, and can run Claude inside a Cloud task.
It cannot create or resume other Cloud tasks, so those commands fail with that reason.

```sh
harnexus-task environment
```

prints `{"environment": "cloud" | "local" | "unknown", "source": ..., "note": ...}`, with `"host": "codex" | "claude" | null` for a Cloud, null when it cannot tell which.
The first match decides:

1. `HARNEXUS_EXECUTION_ENV=cloud|local`. Any other value is an error.
2. A nonempty `CODEX_ENVIRONMENT_ID` means `cloud`.
   This is a variable observed in Cloud tasks, not a documented guarantee; the value is never printed.
3. `CLAUDE_CODE_REMOTE=true`, set in Claude Code cloud sessions, means `cloud` on Claude.
4. `local` only when the harnexus call socket accepts a connection.
   A missing variable alone never means local.
5. Otherwise `unknown`.

In Cloud, `launch`, `review`, `resolve`, `name`, `watch` and `state --request` need the Codex App, so they fail with a message naming Cloud.
In a Claude Code cloud session the message points to starting a worker as a new cloud session instead, and `review` runs there (below).
Pin `HARNEXUS_EXECUTION_ENV=local` where `CODEX_ENVIRONMENT_ID` or `CLAUDE_CODE_REMOTE=true` is set but the App is reachable.

`harnexus-task` is not on `PATH` in Cloud.
Build it once from a checkout with Bun 1.4.4 and call it by its absolute path:

```sh
bash scripts/install-cloud-task.sh [--prefix DIR] [--bun /absolute/path/to/bun]
# installs /workspace/.cloud-setup/bin/harnexus-task by default; nothing is added to PATH
```

If Bun is missing, the script prints the `npm install --prefix /workspace/.cloud-setup/bun bun@1.4.4` command to run first.
It does not change the Cloud environment settings.

Claude runs inside the current task through the `claude-cloud` wrapper (default `/workspace/.cloud-setup/bin/claude-cloud`, override with an absolute `HARNEXUS_CLAUDE_CLOUD_BIN`; a relative value is an error):

```sh
harnexus-task claude --session NAME --start  --prompt-file FILE [--model M] [--cwd DIR] [--permission-mode auto|plan]
harnexus-task claude --session NAME --resume --prompt-file FILE [--permission-mode auto|plan]
harnexus-task claude --session NAME [--start|--resume ...] --recover adopt|discard
harnexus-task claude --session NAME
```

- It runs `claude -p --output-format json --permission-mode ...` with the prompt on stdin, and prints the result, the `sessionId` and the state path as JSON.
  A start names its session up front with `--session-id`.
- A resume keeps the session's permission mode unless `--permission-mode` is given.
  It runs in the directory the session started in.
- The check, the Claude run and the saved state all happen under one lock that fails at once instead of waiting.
  A dead holder's lock is taken over once; a lock a run did not take is never removed by it.
- A `pending.json` is written before Claude runs and removed once the state is saved.
  If Claude ends without a result (no JSON, timeout, output over 16 MiB, or the state cannot be saved) the turn is unknown and nothing runs again on its own.
  Check what it did, then use `--recover adopt` with `--resume` to continue the pre-named session, or `--recover discard` to drop the record.
  Only an unreachable network (wrapper exit 75) or a process that never started releases the record by itself.
- `HARNEXUS_CLAUDE_TIMEOUT_MS` (default 1 hour) stops a turn: SIGTERM to its process group, SIGKILL after `HARNEXUS_CLAUDE_KILL_GRACE_MS` (default 5 s), and the command waits for the exit before it releases the lock.
- The state is kept under `$XDG_STATE_HOME/taskctl/cloud-claude/`; only a well-formed `session_id` is recorded.
- A session is a fresh context in the same task, not another Cloud task.
  It lasts as long as the task's filesystem; a new Cloud task starts with none.

Verified with the real CLI: a parent Codex session ran `--start` and `--resume` against Claude Code with a login (session `47be678c-e1ef-4049-8521-4a267f4e95c2`, state in `/tmp/harnexus-parent-smoke-state`), and the resume recalled the first turn.
A run from a Claude session nested inside a task without a login reached only `Not logged in`; that run exercised the error path, not a reply.

### Review in a Claude Code cloud session

In a Claude Code cloud session (`CLAUDE_CODE_REMOTE=true`), `review --request REQUEST [--model M] [--thinking T] [--update-base] [--recover discard]` runs the reviewer itself with the Codex CLI in the same machine and answers when it is done:

```json
{"status":"completed","verdict":"LGTM","taskId":"...","base":"<sha>","head":"<sha>","reviewer":"<codex thread id>","answer":"<the reviewer's full answer>","state":"..."}
```

- The request is the same as in the app, but `checkout` may be any repository's top level, and `workerChatId` defaults to `CLAUDE_CODE_SESSION_ID`.
- The reviewer prompt is the `reviewer` template with `{reply_to}` set to `Cloud`; elsewhere `{reply_to}` is the `workerAI`.
- The first head starts `codex exec --json --sandbox read-only -C <checkout>` (by default with `-m gpt-6.1-sol` and `model_reasoning_effort="medium"`); later heads resume the same reviewer with `codex exec resume <id> -c sandbox_mode="read-only"` in the checkout. The prompt goes in on stdin.
- `verdict` is read from the answer's `判定:` line, and is `null` when the answer has none.
- A head already reviewed is refused. A run that failed, such as one without a login, records nothing, so the same head can be sent again.
- A reviewer whose record is gone, such as after the machine was rebuilt, is forgotten, and the next run starts a new one.
- A run that ended without a result leaves `pending.json`; check the reviewer, then send the head again with `--recover discard`.
- A review takes a minute or two, longer than a Bash tool call waits by default, so run it in the background or with a timeout of at least `HARNEXUS_REVIEW_TIMEOUT_MS`; a caller stopped early leaves the run going, and its result unknown.
- `codex` is found on `PATH` unless `HARNEXUS_CODEX_BIN` names an absolute path. `HARNEXUS_REVIEW_TIMEOUT_MS` (default 30 minutes) and `HARNEXUS_REVIEW_KILL_GRACE_MS` bound a run, and the state is kept under `$XDG_STATE_HOME/taskctl/cloud-review/`.
