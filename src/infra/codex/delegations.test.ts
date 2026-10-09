import { describe, expect, test } from "bun:test";
import {
  answeredThreadId,
  createDelegationWatch,
  delegatedMessage,
  delegationSource,
  refusalOf,
} from "./delegations.ts";

describe("createDelegationWatch", () => {
  test("claims a thread for its caller as it is handed out and never one nobody waits for", () => {
    const claims: string[][] = [];
    const watch = createDelegationWatch((source, threadId) =>
      claims.push([source, threadId]),
    );
    watch.expect("th-claude");

    watch.observe("th-other", "th-foreign");
    watch.observe("th-claude", "th-reviewer-1");

    expect(claims).toEqual([["th-claude", "th-reviewer-1"]]);
  });

  test("takes no second create of a caller until the first is confirmed or cancelled", async () => {
    const watch = createDelegationWatch(() => {});
    const first = expecting(watch, "th-claude");

    expect(watch.expect("th-claude")).toBeNull();
    expect(watch.expect("th-other")).not.toBeNull();
    watch.observe("th-claude", "th-reviewer-1");
    expect((await first.wait(1_000))?.threadId).toBe("th-reviewer-1");
    expecting(watch, "th-claude").cancel();
    expect(watch.expect("th-claude")).not.toBeNull();
  });

  test("keeps a caller unconfirmed while the thread its answer named has not started", () => {
    const watch = createDelegationWatch(() => {});
    expecting(watch, "th-claude").claim("th-reviewer");

    watch.observe("th-claude", "th-other-thread");
    expect(watch.expect("th-claude")).toBeNull();
    watch.observe("th-claude", "th-reviewer");

    expect(watch.expect("th-claude")).not.toBeNull();
  });

  test("ignores a repeated first turn of a thread it already handed out", async () => {
    const watch = createDelegationWatch(() => {});
    const first = expecting(watch, "th-claude");
    watch.observe("th-claude", "th-reviewer-1");
    expect((await first.wait(1_000))?.threadId).toBe("th-reviewer-1");
    const second = expecting(watch, "th-claude");

    watch.observe("th-claude", "th-reviewer-1");

    expect(await second.wait(20)).toBeNull();
  });

  test("keeps a thread seen before anyone waits from answering a later create_thread when its turn comes again", async () => {
    const watch = createDelegationWatch(() => {});
    watch.observe("th-claude", "th-unrelated");
    const waiting = expecting(watch, "th-claude");

    watch.observe("th-claude", "th-unrelated");

    expect(await waiting.wait(20)).toBeNull();
  });
});

describe("createDelegationWatch first turn check", () => {
  test("refuses a first turn on another effort and reports it", async () => {
    const watch = createDelegationWatch(() => {});
    const created = expecting(watch, "th-codex", { expected: EXPECTED });
    const actual = { model: "gpt-worker", effort: "high" };

    expect(watch.observe("th-codex", "th-worker", actual)).toBe(false);
    expect(await created.wait(1_000)).toEqual({
      threadId: "th-worker",
      expected: EXPECTED,
      actual,
      refused: true,
      refusal: null,
    });
  });

  test("settles a first turn the bridge runs only once it reports whether it took the turn", async () => {
    const watch = createDelegationWatch(() => {});
    const created = expecting(watch, "th-codex", { expected: EXPECTED });

    expect(watch.observe("th-codex", "th-worker", EXPECTED, true)).toBe(true);
    expect(await created.wait(0)).toBeNull();
    watch.started("th-worker", "directory_unknown");

    expect(await created.wait(1_000)).toEqual({
      threadId: "th-worker",
      expected: EXPECTED,
      actual: EXPECTED,
      refused: false,
      refusal: "directory_unknown",
    });
  });

  test("refuses a first turn the bridge refused again when the app resends it", () => {
    const watch = createDelegationWatch(() => {});
    watch.expect("th-codex", { expected: EXPECTED });
    watch.observe("th-codex", "th-worker", EXPECTED, true);
    watch.started("th-worker", "directory_unknown");

    expect(watch.observe("th-codex", "th-worker", EXPECTED, true)).toBe(false);
  });

  test("refuses a refused thread's first turn again when the app resends it", () => {
    const watch = createDelegationWatch(() => {});
    watch.expect("th-codex", { expected: EXPECTED });
    watch.observe("th-codex", "th-worker", MISMATCH);

    expect(watch.observe("th-codex", "th-worker", EXPECTED)).toBe(false);
  });

  test.each([
    {
      name: "no model",
      actual: { model: null, effort: "medium" },
    },
    {
      name: "no effort",
      actual: { model: "gpt-worker", effort: null },
    },
  ])("refuses a first turn that gives $name for one that was asked", async ({
    actual,
  }) => {
    const watch = createDelegationWatch(() => {});
    const created = expecting(watch, "th-codex", { expected: EXPECTED });

    expect(watch.observe("th-codex", "th-worker", actual)).toBe(false);
    expect(await created.wait(1_000)).toEqual({
      threadId: "th-worker",
      expected: EXPECTED,
      actual,
      refused: true,
      refusal: null,
    });
  });

  test("checks nothing a create_thread did not ask for", () => {
    const watch = createDelegationWatch(() => {});
    watch.expect("th-codex", {
      expected: { model: "gpt-worker", effort: null },
    });

    expect(
      watch.observe("th-codex", "th-worker", {
        model: "gpt-worker",
        effort: "xhigh",
      }),
    ).toBe(true);
  });

  test("keeps the check armed after a wait times out until it is disarmed", async () => {
    const watch = createDelegationWatch(() => {}, { armedMs: 60 });
    const first = expecting(watch, "th-codex", { expected: EXPECTED });

    expect(await first.wait(10)).toBeNull();
    expect(watch.observe("th-codex", "th-late", MISMATCH)).toBe(false);
    expecting(watch, "th-codex", { expected: EXPECTED });
    await Bun.sleep(80);

    expect(watch.observe("th-codex", "th-after", MISMATCH)).toBe(true);
  });

  test("checks the first turn of a thread the answer already named", async () => {
    const watch = createDelegationWatch(() => {});
    const created = expecting(watch, "th-codex", { expected: EXPECTED });
    created.claim("th-worker");

    expect(watch.observe("th-codex", "th-worker", MISMATCH)).toBe(false);
    expect((await created.wait(1_000))?.refused).toBe(true);
  });

  test("records nothing for a caller that asked not to be recorded", () => {
    const claims: string[][] = [];
    const watch = createDelegationWatch((source, threadId) =>
      claims.push([source, threadId]),
    );
    watch.expect("th-codex", { record: false });

    watch.observe("th-codex", "th-worker");

    expect(claims).toEqual([]);
  });
});

describe("answeredThreadId", () => {
  test.each([
    {
      name: "a structured threadId",
      answer: { content: [], structuredContent: { threadId: "th-new" } },
      expected: "th-new",
    },
    {
      name: "a thread.id in text",
      answer: {
        content: [{ type: "text", text: '{"thread":{"id":"th-new"}}' }],
      },
      expected: "th-new",
    },
    {
      name: "a provisional id only",
      answer: {
        content: [
          { type: "text", text: '{"clientThreadId":"client-new-thread:1"}' },
        ],
      },
      expected: null,
    },
  ])("reads $name", ({ answer, expected }) => {
    expect(answeredThreadId(answer)).toBe(expected);
  });
});

describe("delegationSource", () => {
  test.each([
    {
      name: "a create_thread output",
      toolOutput: {
        name: "create_thread",
        output: "<source_thread_id> th-claude </source_thread_id>",
      },
      expected: "th-claude",
    },
    {
      name: "an output split into items",
      toolOutput: {
        name: "create_thread",
        output: [
          { type: "input_text", text: "<source_thread_id>th-claude" },
          { type: "input_text", text: "</source_thread_id>" },
        ],
      },
      expected: "th-claude",
    },
    {
      name: "a send_message_to_thread output",
      toolOutput: {
        name: "send_message_to_thread",
        output: "<source_thread_id>th-claude</source_thread_id>",
      },
      expected: null,
    },
  ])("reads $expected from $name", ({ toolOutput, expected }) => {
    expect(delegationSource({ threadId: "th-new", toolOutput })).toBe(expected);
  });
});

describe("delegatedMessage", () => {
  test.each([
    {
      name: "a send_message_to_thread output",
      toolOutput: {
        name: "send_message_to_thread",
        namespace: "codex_app",
        output: REPLY,
      },
      expected: {
        tool: "send_message_to_thread",
        text: REPLY,
        sourceThreadId: "th-reviewer",
        toolOutput: {
          name: "send_message_to_thread",
          namespace: "codex_app",
          output: REPLY,
        },
      },
    },
    {
      name: "a create_thread output split into text items",
      toolOutput: {
        name: "create_thread",
        output: [
          { type: "input_text", text: "<source_thread_id>th-codex" },
          { type: "input_text", text: "</source_thread_id>" },
        ],
      },
      expected: {
        tool: "create_thread",
        text: "<source_thread_id>th-codex\n</source_thread_id>",
        sourceThreadId: "th-codex",
        toolOutput: {
          name: "create_thread",
          namespace: null,
          output: [
            { type: "input_text", text: "<source_thread_id>th-codex" },
            { type: "input_text", text: "</source_thread_id>" },
          ],
        },
      },
    },
    {
      name: "an output without a source",
      toolOutput: { name: "send_message_to_thread", output: "hello" },
      expected: {
        tool: "send_message_to_thread",
        text: "hello",
        sourceThreadId: null,
        toolOutput: {
          name: "send_message_to_thread",
          namespace: null,
          output: "hello",
        },
      },
    },
    {
      name: "an output with an image",
      toolOutput: {
        name: "send_message_to_thread",
        output: [
          { type: "input_text", text: REPLY },
          { type: "input_image", image_url: "data:," },
        ],
      },
      expected: null,
    },
    {
      name: "an output with an item of another type",
      toolOutput: {
        name: "send_message_to_thread",
        output: [{ type: "output_text", text: REPLY }],
      },
      expected: null,
    },
    {
      name: "another tool's output",
      toolOutput: { name: "fork_thread", output: REPLY },
      expected: null,
    },
    { name: "no tool output", toolOutput: undefined, expected: null },
  ])("reads $name", ({ toolOutput, expected }) => {
    expect(delegatedMessage({ threadId: "th-worker", toolOutput })).toEqual(
      expected,
    );
  });
});

const REPLY =
  "<codex_delegation>\n  <source_thread_id>th-reviewer</source_thread_id>\n  <input>looks good</input>\n</codex_delegation>";

test.each([
  {
    name: "a value left out as not said",
    actual: { model: null, effort: "low" },
    text: "did not say which model (expected gpt-worker)",
  },
  {
    name: "each differing setting",
    actual: { model: "gpt-other", effort: null },
    text: "asked for model gpt-other instead of gpt-worker and did not say which effort (expected low)",
  },
])("refusalOf names $name", ({ actual, text }) => {
  expect(refusalOf(EXPECTED, actual)).toBe(text);
});

const EXPECTED = { model: "gpt-worker", effort: "low" };
const MISMATCH = { model: "gpt-other", effort: "low" };

const expecting = (
  watch: ReturnType<typeof createDelegationWatch>,
  ...args: Parameters<ReturnType<typeof createDelegationWatch>["expect"]>
) => watch.expect(...args) ?? expect.unreachable("the caller already waits");
