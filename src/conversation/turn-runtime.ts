import type { EffortLevel } from "@anthropic-ai/claude-agent-sdk";
import type { InferErr } from "better-result";
import type { createCodexLink } from "../infra/codex/codex-link.ts";
import type { delegatedMessage } from "../infra/codex/delegations.ts";
import type { ThreadRecord } from "../infra/thread-store.ts";
import type { UserInput } from "../presentation/protocol.ts";
import type { Rendered, TurnOutcome, TurnState } from "../presentation/turn.ts";
import type { Mode, Refusal } from "./thread-request.ts";

// What the controller hands a runtime for one turn; the runtime reads the turn's state and moves it only through apply, finish and fail, so the order in which the app is told stays with the controller.
export type RunningTurn<Tag extends string> = {
  threadId: string;
  turnId: string;
  record: ThreadRecord;
  model: string;
  input: TurnInput;
  compaction: boolean;
  startedAtMs: number;
  state: () => TurnState;
  apply: (rendered: Rendered, error?: Tag | null) => void;
  finish: (outcome: TurnOutcome, error: Tag | null) => void;
  fail: (error: { _tag: Tag; message: string }) => void;
  isOpen: () => boolean;
  useLink: (link: TurnLink) => void;
  ask: (
    method: string,
    params: Record<string, unknown>,
    signal: AbortSignal,
  ) => Promise<unknown>;
};

// run sends the turn and reports its progress until it ends; threadBusy and threadIdle mark when the thread has turns accepted and when it has none left.
// listen takes how the runtime starts a turn its agent began on its own, such as after a background task reported back or to show an approval no turn could, which answers whether the turn will be shown.
export type TurnRuntime<Tag extends string> = {
  compactPrompt: string;
  closeSession: (threadId: string) => void;
  recordOf: (threadId: string, turnId: string) => string | null;
  run: (turn: RunningTurn<Tag>) => Promise<void>;
  steer: (turn: RunningTurn<Tag>, text: string) => Refusal | null;
  interrupt: (turn: RunningTurn<Tag>, repeated: boolean) => void;
  dropSession: (threadId: string, link: TurnLink) => void;
  // Called when a thread forked from another is adopted, and settles once the fork is pinned to where the source stood.
  noteFork: (threadId: string) => Promise<void>;
  threadBusy: (threadId: string) => void;
  threadIdle: (threadId: string) => void;
  listen: (startOwnTurn: (threadId: string) => boolean) => void;
  closeAll: () => void;
};

// The thread tool server of the session a turn ran on, read when the turn ends to see whether a write was left undecided.
export type TurnLink = Pick<
  ReturnType<typeof createCodexLink>,
  "hasUnsettledWrite" | "stopWrites"
>;

export type TextInput = {
  items: UserInput[];
  toolOutput: ToolOutput | null;
  text: string;
};

export type ToolOutput = NonNullable<
  ReturnType<typeof delegatedMessage>
>["toolOutput"];

// effort is the thread's level when the turn was accepted, so a change made while it waits or runs applies to the next turn.
// requester is the thread that delegated this turn's message, saved before the turn runs so Claude can answer it; startedBy says whether the app or the agent itself started the turn.
export type TurnInput = TextInput & {
  permissionMode: Mode;
  effort: EffortLevel | null;
  requester: string | null;
  startedBy: "app" | "claude";
};

export type ErrorTag<R> =
  InferErr<Awaited<R>> extends { _tag: infer T } ? T : never;
