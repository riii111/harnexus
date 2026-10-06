import { describe, expect, test } from "bun:test";
import {
  createDelegationWatch,
  delegatedMessage,
  delegationSource,
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

  test("gives each waiting create_thread the next thread started for its caller", async () => {
    const watch = createDelegationWatch(() => {});
    const first = watch.expect("th-claude");
    const second = watch.expect("th-claude");

    watch.observe("th-other", "th-foreign");
    watch.observe("th-claude", "th-reviewer-1");
    watch.observe("th-claude", "th-reviewer-2");

    expect((await first.wait(1_000))?.threadId).toBe("th-reviewer-1");
    expect((await second.wait(1_000))?.threadId).toBe("th-reviewer-2");
  });

  test("ignores a repeated first turn of a thread it already handed out", async () => {
    const watch = createDelegationWatch(() => {});
    const first = watch.expect("th-claude");
    watch.observe("th-claude", "th-reviewer-1");
    expect((await first.wait(1_000))?.threadId).toBe("th-reviewer-1");
    const second = watch.expect("th-claude");

    watch.observe("th-claude", "th-reviewer-1");

    expect(await second.wait(20)).toBeNull();
  });

  test("keeps a thread seen before anyone waits from answering a later create_thread when its turn comes again", async () => {
    const watch = createDelegationWatch(() => {});
    watch.observe("th-claude", "th-unrelated");
    const waiting = watch.expect("th-claude");

    watch.observe("th-claude", "th-unrelated");

    expect(await waiting.wait(20)).toBeNull();
  });
});

describe("createDelegationWatch first turn check", () => {
  test.each([
    {
      name: "the expected model and effort",
      actual: { model: "gpt-worker", effort: "low" },
      runs: true,
    },
    {
      name: "another model",
      actual: { model: "gpt-other", effort: "low" },
      runs: false,
    },
    {
      name: "another effort",
      actual: { model: "gpt-worker", effort: "high" },
      runs: false,
    },
    {
      name: "no model or effort",
      actual: { model: null, effort: null },
      runs: true,
    },
  ])("lets a first turn asking for $name run: $runs", async ({
    actual,
    runs,
  }) => {
    const watch = createDelegationWatch(() => {});
    const created = watch.expect("th-codex", { expected: EXPECTED });

    expect(watch.observe("th-codex", "th-worker", actual)).toBe(runs);
    expect(await created.wait(1_000)).toEqual({
      threadId: "th-worker",
      expected: EXPECTED,
      actual,
      refused: !runs,
    });
  });

  test("refuses a refused thread's first turn again when the app resends it", () => {
    const watch = createDelegationWatch(() => {});
    watch.expect("th-codex", { expected: EXPECTED });
    watch.observe("th-codex", "th-worker", MISMATCH);

    expect(watch.observe("th-codex", "th-worker", EXPECTED)).toBe(false);
  });

  test("tells a caller with an unconfirmed create from one without", () => {
    const watch = createDelegationWatch(() => {});
    const queued = watch.expect("th-codex");
    const named = watch.expect("th-claude");
    named.claim("th-reviewer");

    expect(["th-codex", "th-claude", "th-other"].map(watch.isWaiting)).toEqual([
      true,
      true,
      false,
    ]);
    queued.cancel();
    watch.observe("th-claude", "th-reviewer");
    expect(watch.isWaiting("th-codex") || watch.isWaiting("th-claude")).toBe(
      false,
    );
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
    const first = watch.expect("th-codex", { expected: EXPECTED });
    const second = watch.expect("th-codex", { expected: EXPECTED });

    expect(await first.wait(10)).toBeNull();
    expect(watch.observe("th-codex", "th-late", MISMATCH)).toBe(false);
    await Bun.sleep(80);

    expect(watch.observe("th-codex", "th-after", MISMATCH)).toBe(true);
    expect(await second.wait(10)).toBeNull();
  });

  test("checks the first turn of a thread the answer already named", async () => {
    const watch = createDelegationWatch(() => {});
    const created = watch.expect("th-codex", { expected: EXPECTED });
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

const EXPECTED = { model: "gpt-worker", effort: "low" };
const MISMATCH = { model: "gpt-other", effort: "low" };
