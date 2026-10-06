import { isObject } from "../../runtime/object.ts";

export type DelegationWatch = ReturnType<typeof createDelegationWatch>;

// The model and effort a turn/start asks for, or that a create_thread asked the app for; null where none was given.
export type TurnSettings = { model: string | null; effort: string | null };

export type FirstTurn = {
  threadId: string;
  expected: TurnSettings;
  actual: TurnSettings;
  // The turn asked for another model or effort than expected, so it must not run.
  refused: boolean;
};

type Waiter = {
  sourceThreadId: string;
  expected: TurnSettings;
  record: boolean;
  settle: (turn: FirstTurn | null) => void;
};

// The app answers create_thread with a provisional id only; the real thread id first appears in the turn/start the app sends to the new thread, whose tool output names the thread that asked for it.
// claim runs as a thread is handed to a caller that records it, before the caller's wait resumes, so the thread is known as that caller's from the moment it is seen.
export const createDelegationWatch = (
  claim: (sourceThreadId: string, threadId: string) => void,
  { armedMs = CHECK_ARMED_MS }: { armedMs?: number } = {},
) => {
  const waiters = new Map<string, Waiter[]>();
  // Waiters whose thread the app's answer already named, still waiting for its first turn.
  const named = new Map<string, Waiter>();
  // Every thread seen or named by an answer, so its late or repeated first turn never answers a later create_thread.
  const claimed = new Set<string>();
  // Threads whose first turn was refused, so the app sending that turn again never gets it run.
  const refusedThreads = new Set<string>();

  const remove = (sourceThreadId: string, waiter: Waiter) => {
    const left = (waiters.get(sourceThreadId) ?? []).filter(
      (queued) => queued !== waiter,
    );
    if (left.length === 0) waiters.delete(sourceThreadId);
    else waiters.set(sourceThreadId, left);
    for (const [threadId, bound] of named) {
      if (bound === waiter) named.delete(threadId);
    }
  };

  const settle = (waiter: Waiter, threadId: string, actual: TurnSettings) => {
    const refused =
      differs(waiter.expected.model, actual.model) ||
      differs(waiter.expected.effort, actual.effort);
    if (refused) refusedThreads.add(threadId);
    waiter.settle({ threadId, expected: waiter.expected, actual, refused });
    return !refused;
  };

  // A thread created from anywhere but a pending create_thread is ignored, so it can never become someone's reviewer; the answer tells the router whether the turn may run.
  const observe = (
    sourceThreadId: string,
    threadId: string,
    actual: TurnSettings = NOT_GIVEN,
  ) => {
    if (refusedThreads.has(threadId)) return false;
    const bound = named.get(threadId);
    if (bound !== undefined) {
      named.delete(threadId);
      return settle(bound, threadId, actual);
    }
    if (claimed.has(threadId)) return true;
    claimed.add(threadId);
    const queue = waiters.get(sourceThreadId);
    const next = queue?.shift();
    if (queue?.length === 0) waiters.delete(sourceThreadId);
    if (next === undefined) return true;
    if (next.record) claim(sourceThreadId, threadId);
    return settle(next, threadId, actual);
  };

  // Registered before create_thread is sent, since the new thread's turn/start can arrive before the tool answer.
  // A wait that times out leaves the check armed, so a late first turn with the wrong model is still refused until armedMs passes or cancel is called.
  const expect = (
    sourceThreadId: string,
    {
      expected = NOT_GIVEN,
      record = true,
    }: { expected?: TurnSettings; record?: boolean } = {},
  ) => {
    let resolve: (turn: FirstTurn | null) => void = () => {};
    const seen = new Promise<FirstTurn | null>((done) => {
      resolve = done;
    });
    let settled = false;
    const disarm = setTimeout(() => cancel(), armedMs);
    disarm.unref();
    const waiter: Waiter = {
      sourceThreadId,
      expected,
      record,
      settle: (turn) => {
        settled = true;
        clearTimeout(disarm);
        resolve(turn);
      },
    };
    waiters.set(sourceThreadId, [
      ...(waiters.get(sourceThreadId) ?? []),
      waiter,
    ]);
    const cancel = () => {
      remove(sourceThreadId, waiter);
      waiter.settle(null);
    };
    return {
      wait: async (timeoutMs: number) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timedOut = new Promise<null>((done) => {
          timer = setTimeout(() => done(null), timeoutMs);
        });
        const turn = await Promise.race([seen, timedOut]);
        clearTimeout(timer);
        return turn;
      },
      cancel,
      // The app's answer named the thread itself, so its first turn arriving later must not answer another create_thread, but is still checked.
      claim: (threadId: string) => {
        claimed.add(threadId);
        remove(sourceThreadId, waiter);
        if (!settled) named.set(threadId, waiter);
      },
    };
  };

  // A caller with a create still waiting for its first turn, whose thread a new create's first turn could otherwise be paired with.
  const isWaiting = (sourceThreadId: string) =>
    waiters.has(sourceThreadId) ||
    [...named.values()].some(
      (waiter) => waiter.sourceThreadId === sourceThreadId,
    );

  return { observe, expect, isWaiting };
};

// Only an explicit difference refuses a turn; a value the app leaves out is reported as null for the caller to judge.
const differs = (expected: string | null, actual: string | null) =>
  expected !== null && actual !== null && expected !== actual;

const NOT_GIVEN: TurnSettings = { model: null, effort: null };

// Creating a worktree can take long, so the first turn is waited for this long before the answer says the outcome is unknown.
export const FIRST_TURN_WAIT_MS = 120_000;
const CHECK_ARMED_MS = 600_000;

// Only the create_thread tool output names the thread that created the one it starts.
export const delegationSource = (params: Record<string, unknown>) => {
  const message = delegatedMessage(params);
  return message?.tool === "create_thread" ? message.sourceThreadId : null;
};

// A message from another thread arrives as the output of the codex_app call that sent it, with the sender as <source_thread_id>…</source_thread_id> in text the app writes; only an output made of text can reach Claude.
export const delegatedMessage = (params: Record<string, unknown>) => {
  const output = params.toolOutput;
  if (
    !isObject(output) ||
    typeof output.name !== "string" ||
    !DELEGATING_TOOLS.has(output.name)
  ) {
    return null;
  }
  const texts = outputTexts(output.output);
  if (texts === null) return null;
  const text = texts.join("\n");
  return {
    tool: output.name,
    text,
    sourceThreadId: SOURCE_THREAD.exec(text)?.[1] ?? null,
    toolOutput: {
      name: output.name,
      namespace: typeof output.namespace === "string" ? output.namespace : null,
      output:
        typeof output.output === "string" ? output.output : textItems(texts),
    },
  };
};

const textItems = (
  texts: readonly string[],
): readonly { type: "input_text"; text: string }[] =>
  texts.map((text) => ({ type: "input_text", text }));

const outputTexts = (body: unknown) => {
  if (typeof body === "string") return [body];
  if (!Array.isArray(body) || body.length === 0) return null;
  const texts: string[] = [];
  for (const item of body) {
    if (
      !isObject(item) ||
      item.type !== "input_text" ||
      typeof item.text !== "string"
    ) {
      return null;
    }
    texts.push(item.text);
  }
  return texts;
};

const DELEGATING_TOOLS: ReadonlySet<string> = new Set([
  "create_thread",
  "send_message_to_thread",
]);

const SOURCE_THREAD =
  /<source_thread_id>\s*([0-9A-Za-z_-]+)\s*<\/source_thread_id>/;
