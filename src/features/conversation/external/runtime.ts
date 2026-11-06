import { delegationFields } from "../../link/delegations.ts";
import type {
  RunningTurn,
  TurnInput,
  TurnRuntime,
} from "../turn/turn-runtime.ts";
import { renderNotice } from "../turn/turn.view.ts";
import type { ExternalConversations } from "./conversations.ts";

type ExternalFailureTag =
  | "ExternalConversationStopped"
  | "ExternalConversationFailed"
  | "ExternalAdapterUnavailable";

// Runs every turn of a chat bound to an outside conversation through the adapter, and never through Claude; other chats go to the inner runtime.
export const createExternalRuntime = <Tag extends string>(
  inner: TurnRuntime<Tag>,
  conversations: ExternalConversations | null,
  now: () => number = Date.now,
): TurnRuntime<Tag | ExternalFailureTag> => {
  type Turn = RunningTurn<Tag | ExternalFailureTag>;
  // The turn each bound chat has with the adapter, so a stop reaches it.
  const live = new Map<string, { turnId: string; stop: () => void }>();

  const run = async (turn: Turn) => {
    if (conversations === null) {
      await inner.run(turn as RunningTurn<Tag>);
      return;
    }

    // A stop while the chat's route is looked up, which may wait for the adapter, is kept, so the turn is sent nowhere afterwards.
    let stoppedEarly = false;
    const waiting = {
      turnId: turn.turnId,
      stop: () => {
        stoppedEarly = true;
      },
    };
    live.set(turn.threadId, waiting);
    const route = await conversations.route(
      turn.threadId,
      firstTurnOf(turn.input),
    );
    if (live.get(turn.threadId) === waiting) live.delete(turn.threadId);
    if (stoppedEarly || turn.state().interrupting) {
      turn.finish({ status: "interrupted" }, null);
      return;
    }

    if (route.kind === "normal") {
      await inner.run(turn as RunningTurn<Tag>);
      return;
    }

    if (route.kind === "stopped") {
      turn.fail({
        _tag: "ExternalConversationStopped",
        message: route.message,
      });
      return;
    }

    if (turn.input.startedBy === "claude") {
      const posted = conversations.takePost(turn.threadId);
      if (posted !== null)
        turn.apply(
          renderNotice(turn.state(), posted.text, "final_answer", now()),
        );
      turn.finish({ status: "completed" }, null);
      posted?.shown();
      return;
    }

    if (turn.compaction || turn.input.images.length > 0) {
      turn.fail({
        _tag: "ExternalConversationFailed",
        message: TEXT_ONLY,
      });
      return;
    }

    await new Promise<void>((resolve) => {
      let open = true;
      const settle = (end: () => void) => {
        if (!open) return;
        open = false;
        live.delete(turn.threadId);
        end();
        resolve();
      };

      const opened = conversations.openTurn(
        {
          turnId: turn.turnId,
          threadId: turn.threadId,
          conversationId: route.conversationId,
          kind: route.opened ? "opened" : "input",
          text: route.opened ? "" : turn.input.text,
        },
        {
          output: (text, phase) => {
            if (!open) return;
            turn.apply(
              renderNotice(
                turn.state(),
                text,
                phase === "final" ? "final_answer" : "commentary",
                now(),
              ),
            );
          },
          end: (status, message) =>
            settle(() => {
              if (status === "completed") {
                turn.finish({ status: "completed" }, null);
                return;
              }

              turn.fail({
                _tag: "ExternalConversationFailed",
                message: message ?? FAILED,
              });
            }),
          lost: () =>
            settle(() =>
              turn.fail({
                _tag: "ExternalAdapterUnavailable",
                message: DISCONNECTED,
              }),
            ),
        },
      );
      if (!opened) {
        settle(() =>
          turn.fail({
            _tag: "ExternalAdapterUnavailable",
            message: NOT_CONNECTED,
          }),
        );
        return;
      }

      live.set(turn.threadId, {
        turnId: turn.turnId,
        stop: () =>
          settle(() => {
            conversations.stopTurn(turn.turnId);
            turn.apply(
              renderNotice(turn.state(), STOPPED, "commentary", now()),
            );
            turn.finish({ status: "interrupted" }, null);
          }),
      });
    });
  };

  return {
    ...inner,
    run,
    // A bound chat takes one message per turn, so a message sent while its turn runs is refused rather than run elsewhere.
    steer: (turn, input) =>
      conversations?.isBound(turn.threadId) === true
        ? Promise.resolve("steer_not_sent")
        : inner.steer(turn as RunningTurn<Tag>, input),
    interrupt: (turn, repeated) => {
      const held = live.get(turn.threadId);
      if (held?.turnId === turn.turnId) {
        held.stop();
        return;
      }

      inner.interrupt(turn as RunningTurn<Tag>, repeated);
    },
    listen: (start) => {
      conversations?.listen(start);
      inner.listen(start);
    },
    closeAll: () => {
      for (const held of live.values()) held.stop();
      conversations?.close();
      inner.closeAll();
    },
  };
};

// The text and sender of a chat's first message when another chat made it with create_thread, the only way a chat for a conversation is opened.
const firstTurnOf = (input: TurnInput) => {
  const output = input.toolOutput;
  if (output?.name !== "create_thread") return null;
  const text =
    typeof output.output === "string"
      ? output.output
      : output.output.map((item) => item.text).join("\n");
  const { source, input: sent } = delegationFields(text);
  return { text: sent, source: source === "" ? null : source };
};

const TEXT_ONLY =
  "This chat shows an outside conversation, which takes text messages only.";

const FAILED = "The outside conversation could not answer this message.";

const NOT_CONNECTED =
  "The adapter that answers this chat is not connected, so the message was not sent; send it again once it is back.";

const DISCONNECTED =
  "The adapter that answers this chat stopped before it finished; the message may have reached it, so check before sending it again.";

const STOPPED =
  "Stopped here. The adapter was told to stop; anything it already started may still finish.";
