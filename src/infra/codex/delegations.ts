import { parseJson } from "../../runtime/json.boundary.ts";
import { isObject } from "../../runtime/object.ts";

export type DelegationWatch = ReturnType<typeof createDelegationWatch>;

// null where the request gave none.
export type TurnSettings = { model: string | null; effort: string | null };

export type FirstTurn = {
  threadId: string;
  expected: TurnSettings;
  actual: TurnSettings;
  refused: boolean;
  // The caller's own create_thread ran at the same time, so this turn may be that thread's.
  ambiguous: boolean;
};

// The app answers create_thread with a provisional id only; the real id first appears in the new thread's turn/start, whose tool output names the calling thread.
// claim runs before the caller's wait resumes, so the thread is known as that caller's from the moment it is seen.
export const createDelegationWatch = (
  claim: (sourceThreadId: string, threadId: string) => void,
  { armedMs = CHECK_ARMED_MS }: { armedMs?: number } = {},
) => {
  // At most one unconfirmed create per caller, since nothing in the first turn tells two creates of one caller apart.
  const waiters = new Map<string, Waiter>();
  // So a late or repeated first turn never answers a later create_thread.
  const claimed = new Set<string>();
  // So the app resending a refused first turn never gets it run.
  const refusedThreads = new Set<string>();
  // A Codex thread's own create_thread calls, by item id, until they complete.
  const ownCreates = new Map<string, OwnCreate>();

  // A thread nobody waits for is ignored, so it can never become someone's reviewer; the answer is whether the turn may run.
  const observe = (
    sourceThreadId: string,
    threadId: string,
    actual: TurnSettings = NOT_GIVEN,
  ) => {
    if (refusedThreads.has(threadId)) return false;
    const waiter = waiters.get(sourceThreadId);
    if (waiter?.named === threadId) {
      waiters.delete(sourceThreadId);
      return settle(waiter, threadId, actual);
    }
    if (claimed.has(threadId)) return true;
    claimed.add(threadId);
    if (waiter === undefined || waiter.named !== null) return true;
    // Either turn may be the overlapping own create's, so each is held to the expectation and neither settles alone.
    if (waiter.overlaps > 0) {
      waiter.overlaps -= 1;
      waiter.ambiguous = true;
      return check(waiter, threadId, actual).refused === false;
    }
    waiters.delete(sourceThreadId);
    if (waiter.record) claim(sourceThreadId, threadId);
    return settle(waiter, threadId, actual);
  };

  // Registered before create_thread is sent, since the new thread's turn/start can arrive before the tool answer; null while the caller has an unconfirmed create.
  // A timed-out wait leaves the check armed, so a late first turn on the wrong model is still refused until armedMs passes or cancel is called.
  const expect = (
    sourceThreadId: string,
    {
      expected = NOT_GIVEN,
      record = true,
    }: { expected?: TurnSettings; record?: boolean } = {},
  ) => {
    if (waiters.has(sourceThreadId)) return null;
    let resolve: (turn: FirstTurn | null) => void = () => {};
    const seen = new Promise<FirstTurn | null>((done) => {
      resolve = done;
    });
    let settled = false;
    const disarm = setTimeout(() => cancel(), armedMs);
    disarm.unref();
    const waiter: Waiter = {
      expected,
      record,
      named: null,
      overlaps: 0,
      ambiguous: false,
      settle: (turn) => {
        settled = true;
        clearTimeout(disarm);
        resolve(turn);
      },
    };
    waiters.set(sourceThreadId, waiter);
    const cancel = () => {
      if (waiters.get(sourceThreadId) === waiter) {
        waiters.delete(sourceThreadId);
      }
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
      claim: (threadId: string) => {
        claimed.add(threadId);
        if (!settled) waiter.named = threadId;
      },
    };
  };

  // A Codex thread's own codex_app calls reach the app over the codex_app pipe, never through the bridge, so they cannot be refused; their item notifications only let the watch account for them.
  const noteAppCall = (method: string, params: Record<string, unknown>) => {
    const call = ownCreateCall(params);
    if (call === null) return;
    if (method === "item/started") {
      const waiting = waiters.get(call.threadId);
      if (waiting !== undefined && waiting.named === null) {
        waiting.overlaps += 1;
        ownCreates.set(call.itemId, { overlapped: waiting });
        return;
      }
      const created = expect(call.threadId, { record: false });
      if (created !== null) ownCreates.set(call.itemId, { created });
      return;
    }
    if (method !== "item/completed") return;
    const own = ownCreates.get(call.itemId);
    ownCreates.delete(call.itemId);
    if (own === undefined || call.status !== "failed") return;
    // A failed create makes no thread, so no first turn is left to wait for.
    if ("created" in own) own.created.cancel();
    else if (own.overlapped.overlaps > 0) own.overlapped.overlaps -= 1;
  };

  const check = (waiter: Waiter, threadId: string, actual: TurnSettings) => {
    const refused =
      differs(waiter.expected.model, actual.model) ||
      differs(waiter.expected.effort, actual.effort);
    if (refused) refusedThreads.add(threadId);
    return {
      threadId,
      expected: waiter.expected,
      actual,
      refused,
      ambiguous: waiter.ambiguous,
    };
  };

  const settle = (waiter: Waiter, threadId: string, actual: TurnSettings) => {
    const turn = check(waiter, threadId, actual);
    waiter.settle(turn);
    return !turn.refused;
  };

  return { observe, expect, noteAppCall };
};

type Waiter = {
  expected: TurnSettings;
  record: boolean;
  // The thread the app's answer named, whose first turn alone settles this waiter.
  named: string | null;
  // Own create_thread calls of the caller started while this create waits, each owing a first turn.
  overlaps: number;
  ambiguous: boolean;
  settle: (turn: FirstTurn | null) => void;
};

type CreatedThread = NonNullable<ReturnType<DelegationWatch["expect"]>>;

type OwnCreate = { created: CreatedThread } | { overlapped: Waiter };

// Only a model's own call has a turn; the bridge's mcpServer/tool/call runs outside one.
const ownCreateCall = (params: Record<string, unknown>) => {
  const item = params.item;
  if (
    !isObject(item) ||
    item.type !== "mcpToolCall" ||
    item.server !== CODEX_APP_SERVER ||
    item.tool !== "create_thread" ||
    typeof item.id !== "string" ||
    typeof params.threadId !== "string" ||
    typeof params.turnId !== "string"
  ) {
    return null;
  }
  return { itemId: item.id, threadId: params.threadId, status: item.status };
};

const CODEX_APP_SERVER = "codex_app";

// Only an explicit difference refuses a turn; a value the app leaves out is reported as null for the caller to judge.
const differs = (expected: string | null, actual: string | null) =>
  expected !== null && actual !== null && expected !== actual;

const NOT_GIVEN: TurnSettings = { model: null, effort: null };

// Creating a worktree can take long, so the first turn is waited for this long before the answer says the outcome is unknown.
export const FIRST_TURN_WAIT_MS = 120_000;
const CHECK_ARMED_MS = 600_000;

// A provisional id such as clientThreadId is not a thread id, so only an explicit threadId or thread.id in the app's create_thread answer counts.
export const answeredThreadId = (answer: unknown) => {
  if (!isObject(answer)) return null;
  const structured = threadIdField(answer.structuredContent);
  if (structured !== null) return structured;
  const content = Array.isArray(answer.content) ? answer.content : [];
  for (const item of content) {
    if (!isObject(item) || item.type !== "text") continue;
    if (typeof item.text !== "string") continue;
    const parsed = parseJson(item.text);
    const threadId = parsed.isOk() ? threadIdField(parsed.value) : null;
    if (threadId !== null) return threadId;
  }
  return null;
};

const threadIdField = (value: unknown): string | null => {
  if (!isObject(value)) return null;
  if (typeof value.threadId === "string" && value.threadId !== "") {
    return value.threadId;
  }
  const nested = isObject(value.thread) ? value.thread.id : undefined;
  return typeof nested === "string" && nested !== "" ? nested : null;
};

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
