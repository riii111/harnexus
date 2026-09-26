# app-server fixtures

Synthetic JSON-RPC sessions between the Codex app and `codex app-server`, one `{ "direction", "message" }` record per line in wire order.

- The message shapes follow what codex-cli 0.155.0-alpha.16.4 (bundled with app 26.917.71314) emitted during a headless run, and its generated protocol types.
- `turn-failed-with-edits.jsonl` covers the reasoning, file change, MCP tool and failed-turn shapes the headless run did not produce; it follows the generated protocol types of codex-cli 0.155.1 only, so compare it with a recorded session when one becomes available.
- `create-thread-delegation.jsonl` is the app creating a reviewer for a Claude thread's `create_thread`: the thread's first `turn/start` carries the tool output that names the calling thread in `<source_thread_id>`. The shape follows a Codex rollout seen in P8b (codex-cli 0.158.0-alpha.2); only `<source_thread_id>` is read.
- Every id, path and text is made up. Text fields carry the `sk-fixture-secret` marker so tests can assert it never reaches the log.
- `src/rpc/relay.fixtures.test.ts` replays each file through the relay; refresh the files when a Codex update changes these shapes.
