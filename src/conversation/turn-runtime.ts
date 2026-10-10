import type { EffortLevel } from "@anthropic-ai/claude-agent-sdk";
import type { InferErr } from "better-result";
import type { ImageSource } from "../infra/claude/images.ts";
import type { createCodexLink } from "../infra/codex/codex-link.ts";
import type { delegatedMessage } from "../infra/codex/delegations.ts";
import type { ThreadRecord } from "../infra/thread-store.ts";
import type { UserInput } from "../presentation/protocol.ts";
import type { Rendered, TurnOutcome, TurnState } from "../presentation/turn.ts";
import type { Mode, Refusal } from "./thread-request.ts";

// A runtime reads the turn's state and moves it only through apply, finish and fail, so the order in which the app is told stays with the controller.
export type RunningTurn<Tag extends string> = {
  threadId: string;
  turnId: string;
  record: ThreadRecord;
  model: string;
  input: TurnInput;
  compaction: boolean;
  recovering?: boolean;
  startedAtMs: number;
  state: () => TurnState;
  apply: (rendered: Rendered, error?: Tag | null) => void;
  finish: (outcome: TurnOutcome, error: Tag | null) => void;
  fail: (error: { _tag: Tag; message: string }) => void;
  markOutcomeUnknown: () => void;
  isOpen: () => boolean;
  useLink: (link: TurnLink) => void;
  ask: (
    method: string,
    params: Record<string, unknown>,
    signal: AbortSignal,
  ) => Promise<unknown>;
};

export type TurnRuntime<Tag extends string> = {
  compactPrompt: string;
  closeSession: (threadId: string) => void;
  pauseMessages: (threadId: string) => () => void;
  recordOf: (threadId: string, turnId: string) => string | null;
  run: (turn: RunningTurn<Tag>) => Promise<void>;
  // Settles once the steer reaches the agent or is refused, which for an attached image waits for the image to be read.
  steer: (
    turn: RunningTurn<Tag>,
    input: Pick<MessageInput, "text" | "images">,
  ) => Promise<Refusal | null>;
  interrupt: (turn: RunningTurn<Tag>, repeated: boolean) => void;
  dropSession: (threadId: string, link: TurnLink) => void;
  // Called when a thread forked from another is adopted, and settles once the fork is pinned to where the source stood.
  noteFork: (threadId: string) => Promise<void>;
  threadBusy: (threadId: string) => void;
  threadIdle: (threadId: string) => void;
  listen: (startOwnTurn: (threadId: string) => boolean) => void;
  closeAll: () => void;
};

export type TurnLink = Pick<
  ReturnType<typeof createCodexLink>,
  "hasUnsettledWrite" | "stopWrites"
>;

// items are what the app shows as the user's message; text and images are what the agent is sent.
export type MessageInput = {
  items: UserInput[];
  toolOutput: ToolOutput | null;
  text: string;
  images: ImageSource[];
};

export type ToolOutput = NonNullable<
  ReturnType<typeof delegatedMessage>
>["toolOutput"];

// effort is the thread's level when the turn was accepted, so a change made while it waits or runs applies to the next turn.
// requester is the thread that delegated this turn's message, saved before the turn runs so Claude can answer it.
export type TurnInput = MessageInput & {
  permissionMode: Mode;
  effort: EffortLevel | null;
  requester: string | null;
  startedBy: "app" | "claude";
};

export type ErrorTag<R> =
  InferErr<Awaited<R>> extends { _tag: infer T } ? T : never;
