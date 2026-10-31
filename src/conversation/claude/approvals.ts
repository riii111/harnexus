import type { CanUseTool } from "@anthropic-ai/claude-agent-sdk";
import { promptFor } from "../../presentation/permission.ts";
import {
  markToolDeclined,
  renderToolRequest,
  runningToolItem,
  runsAgent,
  type TurnOutcome,
} from "../../presentation/turn.ts";
import { ABORTED, waitForAbort } from "../../runtime/wait-for-abort.ts";
import type { Subagents } from "../subagents.ts";
import type { RunningTurn } from "../turn-runtime.ts";

type HeldApprovals<Tag extends string> = {
  turn: RunningTurn<Tag> | null;
  waiting: number;
  answered: () => void;
  ended: AbortController;
};

type Approval<Tag extends string> = {
  held: HeldApprovals<Tag> | null;
  signal: AbortSignal;
};

export const createApprovals = <Tag extends string>({
  permissionMode,
  now,
  log,
  subagents,
  isClosed,
  runningTurnOf,
  isBusy,
  pausedOf,
  startOwnTurn,
}: {
  permissionMode: "default" | "auto";
  now: () => number;
  log: (event: { event: "claude_turn"; step: "approval_turn" }) => void;
  subagents: Pick<Subagents, "decline">;
  isClosed: () => boolean;
  runningTurnOf: (threadId: string) => RunningTurn<Tag> | undefined;
  isBusy: (threadId: string) => boolean;
  pausedOf: (threadId: string) => Promise<void> | undefined;
  startOwnTurn: (threadId: string) => boolean;
}) => {
  type Turn = RunningTurn<Tag>;

  const heldApprovals = new Map<string, HeldApprovals<Tag>>();
  const turnWaiters = new Map<string, (() => void)[]>();

  // Claude may ask for a tool before the app has been shown the turn the thread accepted, such as a turn of its own, so the approval waits until a turn is shown or the thread has none left.
  const turnShown = (threadId: string) =>
    new Promise<void>((resolve) => {
      turnWaiters.set(threadId, [
        ...(turnWaiters.get(threadId) ?? []),
        resolve,
      ]);
    });

  const showTurn = (threadId: string) => {
    for (const resolve of turnWaiters.get(threadId) ?? []) resolve();
    turnWaiters.delete(threadId);
  };

  const showAllTurns = () => {
    for (const threadId of [...turnWaiters.keys()]) showTurn(threadId);
  };

  const hold = async (turn: Turn, held: HeldApprovals<Tag>) => {
    held.turn = turn;
    showTurn(turn.threadId);
    while (held.waiting > 0) {
      await new Promise<void>((resolve) => {
        held.answered = resolve;
      });
    }
    if (heldApprovals.get(turn.threadId) === held) {
      heldApprovals.delete(turn.threadId);
    }
    turn.finish(heldOutcome(turn, held), null);
  };

  const heldOutcome = (turn: Turn, held: HeldApprovals<Tag>): TurnOutcome => {
    if (turn.state().interrupting) return { status: "interrupted" };
    // Ending as completed would read as if each approval had been answered.
    if (held.ended.signal.aborted) {
      return { status: "failed", message: APPROVALS_UNANSWERED };
    }
    return { status: "completed" };
  };

  // The SDK reports no message when a call is refused here, so the refusal is recorded on the turn to show its item as declined.
  const approveTool =
    (threadId: string): CanUseTool =>
    async (toolName, input, options) => {
      const approval: Approval<Tag> = { held: null, signal: options.signal };
      try {
        return await decideTool(threadId, approval, toolName, input, options);
      } finally {
        if (approval.held !== null) leaveHeld(approval.held);
      }
    };

  const decideTool = async (
    threadId: string,
    approval: Approval<Tag>,
    ...[toolName, input, options]: Parameters<CanUseTool>
  ) => {
    const turn = await turnToAsk(threadId, approval);
    if (turn === undefined || turn.state().interrupting) {
      return declineTool(threadId, turn, options.toolUseID, NO_TURN);
    }
    const block = { id: options.toolUseID, name: toolName, input };
    // A subagent's call shows as its own item while its agent runs in the turn; one from a background agent would outlive the turn, which would close its item as failed, so its prompt carries an id of its own, as does every call a turn holding approvals shows.
    if (options.agentID === undefined && approval.held?.turn !== turn) {
      turn.apply(renderToolRequest(turn.state(), block, now()));
    } else if (runsAgent(turn.state())) {
      turn.apply(renderToolRequest(turn.state(), block, now(), false));
    }
    const item = runningToolItem(turn.state(), options.toolUseID);
    const prompt = promptFor(
      {
        toolName,
        input,
        item,
        title: options.title,
        reason: options.decisionReason,
        defaultToNo: options.defaultToNo === true,
        suggestions: options.suggestions ?? [],
        suppressAlwaysAllow: options.suppressAlwaysAllowRule === true,
      },
      {
        threadId,
        turnId: turn.turnId,
        itemId: item?.id ?? `${turn.turnId}-${options.toolUseID}`,
        now: now(),
        implementationMode: permissionMode,
      },
    );
    const answer = await turn.ask(
      prompt.method,
      prompt.params,
      approval.signal,
    );
    const decision = prompt.decide(answer);
    return decision.behavior === "deny"
      ? declineTool(threadId, turn, options.toolUseID, decision.message)
      : decision;
  };

  // An approval whose holding turn could not be shown is declined rather than held again, so a thread whose turns cannot run does not keep opening them.
  // A turn the user stopped before the approval was shown cannot show it, while one asked as the user stops a turn showing it is declined with that turn.
  const turnToAsk = async (threadId: string, approval: Approval<Tag>) => {
    let waited = false;
    while (!isClosed() && !approval.signal.aborted) {
      const paused = pausedOf(threadId);
      if (paused !== undefined) {
        const resumed = await waitForAbort(paused, approval.signal);
        if (resumed === ABORTED) return undefined;
        continue;
      }
      const turn = openTurn(threadId);
      const held = heldApprovals.get(threadId);
      if (held !== undefined && (held.turn === null || held.turn === turn)) {
        joinHeld(approval, held);
      }
      const stoppedAhead =
        waited &&
        turn?.state().interrupting === true &&
        approval.held?.turn !== turn;
      if (turn !== undefined && !stoppedAhead) return turn;
      if (held === undefined && !isBusy(threadId)) {
        if (approval.held !== null || !openHeld(threadId, approval)) {
          return undefined;
        }
      }
      const shown = await waitForAbort(turnShown(threadId), approval.signal);
      if (shown === ABORTED) return undefined;
      waited = true;
    }
    return undefined;
  };

  const openHeld = (threadId: string, approval: Approval<Tag>) => {
    const held: HeldApprovals<Tag> = {
      turn: null,
      waiting: 0,
      answered: () => {},
      ended: new AbortController(),
    };
    heldApprovals.set(threadId, held);
    joinHeld(approval, held);
    if (startOwnTurn(threadId)) {
      log({ event: "claude_turn", step: "approval_turn" });
      return true;
    }
    heldApprovals.delete(threadId);
    approval.held = null;
    return false;
  };

  const joinHeld = (approval: Approval<Tag>, held: HeldApprovals<Tag>) => {
    if (approval.held !== null) return;
    held.waiting += 1;
    approval.held = held;
    approval.signal = AbortSignal.any([approval.signal, held.ended.signal]);
  };

  const leaveHeld = (held: HeldApprovals<Tag>) => {
    held.waiting -= 1;
    if (held.waiting === 0) held.answered();
  };

  const openTurn = (threadId: string) => {
    const turn = runningTurnOf(threadId) ?? heldApprovals.get(threadId)?.turn;
    return turn?.isOpen() ? turn : undefined;
  };

  const declineTool = (
    threadId: string,
    turn: Turn | undefined,
    toolUseId: string,
    message: string,
  ) => {
    subagents.decline(threadId, toolUseId);
    if (turn !== undefined) {
      turn.apply({
        state: markToolDeclined(turn.state(), toolUseId),
        notifications: [],
      });
    }
    return { behavior: "deny" as const, message };
  };

  return {
    approveTool,
    hold,
    showTurn,
    showAllTurns,
    isHeld: (threadId: string) => heldApprovals.has(threadId),
    awaitingTurn: (threadId: string) => {
      const held = heldApprovals.get(threadId);
      return held?.turn === null ? held : undefined;
    },
    forget: (threadId: string) => {
      heldApprovals.delete(threadId);
    },
    // What the app answers can no longer reach a Claude that is gone.
    end: (threadId: string) => {
      heldApprovals.get(threadId)?.ended.abort();
    },
  };
};

const NO_TURN = "no Claude turn is running to ask the app for approval";

const APPROVALS_UNANSWERED =
  "Claude's session ended before the approval was answered";
