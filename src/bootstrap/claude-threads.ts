import {
  createTurnController,
  type TurnEvent,
} from "../conversation/controller.ts";
import { createRouter, type RouteEvent } from "../conversation/route.ts";
import { createCodexLink } from "../infra/codex/codex-link.ts";
import { createDelegationWatch } from "../infra/codex/delegations.ts";
import type { ServerRequest } from "../infra/codex/server-requests.ts";
import type { ThreadStore } from "../infra/thread-store.ts";

type Controller = Parameters<typeof createTurnController>[0];

// The router, the turn controller and each session's thread tools share one store and one watch for created threads, so a reviewer is traced to its worker whichever of them sees it first.
export const connectClaudeThreads = ({
  store,
  request,
  startSession,
  findSession,
  send,
  log,
}: {
  store: ThreadStore;
  request: ServerRequest;
  startSession: Controller["startSession"];
  findSession: Controller["findSession"];
  send: (message: object) => void;
  log: (event: TurnEvent | RouteEvent) => void;
}) => {
  const delegations = createDelegationWatch(store.claimReviewer);
  const turns = createTurnController({
    store,
    startSession,
    findSession,
    materializeThread: (threadId) =>
      request(
        "thread/inject_items",
        { threadId, items: [THREAD_NOTE] },
        { timeoutMs: INJECT_TIMEOUT_MS },
      ),
    openLink: (callerThreadId) =>
      createCodexLink({ callerThreadId, store, request, delegations }),
    send,
    log,
  });
  const router = createRouter(turns, log, delegations.observe);
  return { router, closeAll: turns.closeAll };
};

// The server writes a thread to disk only once it holds some history, and Claude turns never reach it, so without this item the app cannot reopen a Claude thread after a restart; the note carries no conversation text.
const THREAD_NOTE = {
  type: "message",
  role: "developer",
  content: [
    {
      type: "input_text",
      text: "This thread runs on Claude through Harnexus; its conversation is kept in Claude's session record.",
    },
  ],
};

const INJECT_TIMEOUT_MS = 30_000;
