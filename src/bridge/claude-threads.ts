import { createDelegationWatch } from "../link/delegations.ts";
import { createCodexLink } from "../mcp/codex-link.ts";
import { createRouter, type RouteEvent } from "../rpc/route.ts";
import type { ServerRequest } from "../rpc/server-requests.ts";
import type { ThreadStore } from "../state/thread-store.ts";
import { createTurnController, type TurnEvent } from "../turn/controller.ts";

type Controller = Parameters<typeof createTurnController>[0];

// The router, the turn controller and each session's thread tools share one store and one watch for created threads, so a reviewer is traced to its worker whichever of them sees it first.
export const connectClaudeThreads = ({
  store,
  request,
  startSession,
  send,
  log,
}: {
  store: ThreadStore;
  request: ServerRequest;
  startSession: Controller["startSession"];
  send: (message: object) => void;
  log: (event: TurnEvent | RouteEvent) => void;
}) => {
  const delegations = createDelegationWatch(store.claimReviewer);
  const turns = createTurnController({
    store,
    startSession,
    openLink: (callerThreadId) =>
      createCodexLink({ callerThreadId, store, request, delegations }),
    send,
    log,
  });
  const router = createRouter(turns, log, delegations.observe);
  return { router, closeAll: turns.closeAll };
};
