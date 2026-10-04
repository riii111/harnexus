import type { readClaudeSession } from "../infra/claude/session.ts";
import type { ServerRequest } from "../infra/codex/server-requests.ts";
import type { RewindPoint, ThreadStore } from "../infra/thread-store.ts";
import { buildHistory } from "../presentation/history.ts";
import { resumeCursors } from "../presentation/history-page.ts";
import { isObject } from "../runtime/object.ts";
import type { createTurnController } from "./controller.ts";
import type { AppRequest } from "./thread-request.ts";
import type { ThreadValues } from "./thread-values.ts";
import type { TurnRuntime } from "./turn-runtime.ts";

export const createRevertRequests =
  ({
    store,
    threads,
    turns,
    runtime,
    readSession,
    request,
    send,
  }: {
    store: ThreadStore;
    threads: ThreadValues;
    turns: Pick<ReturnType<typeof createTurnController>, "changeConversation">;
    runtime: Pick<
      TurnRuntime<string>,
      "closeSession" | "recordsOf" | "forgetUnsent"
    >;
    readSession: typeof readClaudeSession;
    request: ServerRequest;
    send: (message: object) => void;
  }) =>
  async (method: "thread/revert" | "thread/rollback", app: AppRequest) => {
    const threadId = String(app.params.threadId);
    const reject = (message: string) =>
      send({ id: app.id, error: { code: -32600, message } });
    const changed = await turns.changeConversation(threadId, async () => {
      const thread = threads.threadOf(threadId);
      const sessionId = threads.sessionIdOf(threadId);
      if (thread === undefined || sessionId === null) {
        reject("there is no Claude conversation to rewind");
        return false;
      }
      const read = await readSession(sessionId);
      if (read.isErr()) {
        reject(
          "the Claude conversation could not be read, so it was not rewound",
        );
        return false;
      }
      const rewind = threads.rewindOf(threadId);
      const end =
        rewind === undefined
          ? read.value.length
          : rewind.at === null
            ? 0
            : read.value.findIndex((entry) => entry.uuid === rewind.at) + 1;
      if (rewind?.at != null && end === 0) {
        reject("the retained Claude record is missing");
        return false;
      }
      const messages = read.value.slice(0, end);
      const history = buildHistory(messages, { threadId, cwd: thread.cwd });
      let target: string | null = null;
      let after: RewindPoint | null = null;
      if (method === "thread/revert") {
        const id = app.params.beforeTurnId;
        if (typeof id === "string") {
          if (id.startsWith("harnexus-history-")) {
            target = id.slice("harnexus-history-".length);
          } else {
            const record = runtime.recordsOf(threadId).get(id) ?? null;
            if (record !== null) {
              if ("before" in record) target = record.before;
              else after = record.after;
            }
          }
        }
      } else {
        const positions = history.map((entry) => ({
          index: messages.findIndex(
            (message) => entry.turn.id === `harnexus-history-${message.uuid}`,
          ),
          target: entry.turn.id.slice("harnexus-history-".length) as
            | string
            | null,
          after: null as RewindPoint | null,
        }));
        for (const record of runtime.recordsOf(threadId).values()) {
          if (!("after" in record)) continue;
          const index = indexAfter(record.after, sessionId, messages);
          if (index >= 0)
            positions.push({ index, target: null, after: record.after });
        }
        positions.sort(
          (left, right) =>
            left.index - right.index ||
            Number(right.after !== null) - Number(left.after !== null),
        );
        const count = app.params.numTurns;
        if (
          typeof count === "number" &&
          Number.isInteger(count) &&
          count > 0 &&
          count <= positions.length
        ) {
          const selected = positions[positions.length - count];
          target = selected?.target ?? null;
          after = selected?.after ?? null;
        }
      }
      const index =
        after !== null
          ? indexAfter(after, sessionId, messages)
          : target === null
            ? -1
            : messages.findIndex((entry) => entry.uuid === target);
      if (
        index < 0 ||
        (after === null &&
          !history.some(
            (entry) => entry.turn.id === `harnexus-history-${target}`,
          ))
      ) {
        reject("the turn to rewind was not found in this Claude conversation");
        return false;
      }
      const metadata = await request(
        "thread/read",
        { threadId, includeTurns: false },
        { timeoutMs: 10000 },
      );
      if (
        metadata.isErr() ||
        !isObject(metadata.value) ||
        !isObject(metadata.value.thread)
      ) {
        reject(
          "the thread could not be read, so the conversation was not rewound",
        );
        return false;
      }
      const kept = messages.slice(0, index);
      const saved = await store.setRewind(threadId, {
        sessionId,
        at: kept.at(-1)?.uuid ?? null,
      });
      const held = store.get(threadId)?.rewind;
      const applied =
        held?.sessionId === sessionId &&
        held.at === (kept.at(-1)?.uuid ?? null);
      if (applied) {
        runtime.closeSession(threadId);
        runtime.forgetUnsent(threadId);
      }
      if (saved.isErr()) {
        reject(
          applied
            ? "the rewind was written but could not be confirmed; reopen the thread to check its retained history"
            : "the rewind could not be saved, so the conversation was not rewound",
        );
        return false;
      }
      const cleared = await store.resolveOutcomeUnknown(threadId);
      if (cleared.isErr()) {
        reject(
          "the conversation was rewound, but its interrupted turn could not be cleared; check the state directory permissions",
        );
        return false;
      }
      const retained = buildHistory(kept, { threadId, cwd: thread.cwd });
      const result = {
        thread: {
          ...metadata.value.thread,
          turns:
            method === "thread/rollback"
              ? retained.map((entry) => entry.turn)
              : [],
        },
        ...resumeCursors(retained),
      };
      send({ id: app.id, result });
      send({ method: "thread/reverted", params: { threadId } });
      return true;
    });
    if (changed === null)
      reject("stop the running Claude turn before rewinding the conversation");
  };

const indexAfter = (
  point: RewindPoint,
  sessionId: string,
  messages: readonly { uuid: string }[],
): number => {
  if (point.at === null) return point.sessionId === sessionId ? 0 : -1;
  const index = messages.findIndex((message) => message.uuid === point.at);
  return index < 0 ? -1 : index + 1;
};
