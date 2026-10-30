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

## harnexus-task in Codex Cloud

`harnexus-task` can tell where it runs, and can run Claude inside a Cloud task.
It cannot create or resume other Cloud tasks, so those commands fail with that reason.

```sh
harnexus-task environment
```

prints `{"environment": "cloud" | "local" | "unknown", "source": ..., "note": ...}`.
The first match decides:

1. `HARNEXUS_EXECUTION_ENV=cloud|local`. Any other value is an error.
2. A nonempty `CODEX_ENVIRONMENT_ID` means `cloud`.
   This is a variable observed in Cloud tasks, not a documented guarantee; the value is never printed.
3. `local` only when the harnexus call socket accepts a connection.
   A missing variable alone never means local.
4. Otherwise `unknown`.

In Cloud, `launch`, `review`, `resolve`, `name`, `watch` and `state --request` need the Codex App, so they fail with a message naming Cloud.
Pin `HARNEXUS_EXECUTION_ENV=local` where `CODEX_ENVIRONMENT_ID` is set but the App is reachable.

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

### Issue orchestration

`harnexus-task orchestrate` drives several Issues from one plan, each with its own Claude worker, worktree and branch, up to a Draft PR.
The independent review is done by you or your agent; the command records its result and refuses to publish without it.
It must run from a thread (`CODEX_THREAD_ID`), which scopes the state.

```sh
harnexus-task orchestrate --request PLAN.json                                   # state and next step per Issue
harnexus-task orchestrate --request PLAN.json --prepare
harnexus-task orchestrate --request PLAN.json --work ISSUE [--prompt-file FILE] [--recover adopt|discard]
harnexus-task orchestrate --request PLAN.json --candidate ISSUE
harnexus-task orchestrate --request PLAN.json --review ISSUE --review-file FILE
harnexus-task orchestrate --request PLAN.json --publish ISSUE [--body-file FILE]
```

```json
{
  "planId": "demo-1",
  "repository": "/abs/path/to/repo",
  "baseRef": "main",
  "issues": [
    { "id": "api", "instruction": "...", "test": ["bun", "test"], "title": "feat: api", "body": "Why this change." },
    { "id": "ui", "promptFile": "/abs/ui.md", "dependsOn": ["api"], "test": ["bun", "test"], "title": "feat: ui", "body": "..." }
  ]
}
```

- `instruction` or `promptFile` (one of them) is what the worker is first told; `test` runs without a shell in the Issue's worktree.
- An Issue with `dependsOn` starts from the approved head of the Issue it builds on, and its PR targets that Issue's branch.
  With several dependencies, `baseTask` names the one to build on, and it must itself depend on all the others.
- `--prepare` creates a worktree and the branch `harnexus/<planId>/<id>` for every Issue whose dependencies are approved; running it again reuses them and never overwrites a branch or path that is not its own.
- `--work` starts the worker with the instruction, then resumes the same worker only with `--prompt-file` (for example the review findings).
- `--candidate` accepts a clean, committed head only when `test` passes and the head did not change meanwhile.
- `--review` takes `{"reviewerId", "base", "head", "verdict": "lgtm|changes_requested", "findings": []}`.
  A review of any head but the current candidate is refused, and every later review must come from the first `reviewerId`.
- `--publish` needs a `lgtm` on the tested head.
  It checks GitHub for an existing PR, pushes with a normal push, and creates the PR as a draft with `gh`; it never forces, merges or pushes `baseRef`.
  When a push or PR result is unknown, run it again: GitHub is checked first, so nothing is created twice.
- The state is kept under `$XDG_STATE_HOME/taskctl/orchestration/`, per thread, plan and repository.
  Changing a plan's content needs a new `planId`.
