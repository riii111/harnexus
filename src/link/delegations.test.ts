import { describe, expect, test } from "bun:test";
import {
  createDelegationWatch,
  delegatedMessage,
  delegationSource,
} from "./delegations.ts";

describe("createDelegationWatch", () => {
  test("gives each waiting create_thread the next thread started for its caller", async () => {
    const watch = createDelegationWatch();
    const first = watch.expect("th-claude");
    const second = watch.expect("th-claude");

    watch.observe("th-other", "th-foreign");
    watch.observe("th-claude", "th-reviewer-1");
    watch.observe("th-claude", "th-reviewer-2");

    expect(await first.wait(1_000)).toBe("th-reviewer-1");
    expect(await second.wait(1_000)).toBe("th-reviewer-2");
  });

  test("ignores a repeated first turn of a thread it already handed out", async () => {
    const watch = createDelegationWatch();
    const first = watch.expect("th-claude");
    watch.observe("th-claude", "th-reviewer-1");
    expect(await first.wait(1_000)).toBe("th-reviewer-1");
    const second = watch.expect("th-claude");

    watch.observe("th-claude", "th-reviewer-1");

    expect(await second.wait(20)).toBeNull();
  });

  test("keeps a thread seen before anyone waits from answering a later create_thread when its turn comes again", async () => {
    const watch = createDelegationWatch();
    watch.observe("th-claude", "th-unrelated");
    const waiting = watch.expect("th-claude");

    watch.observe("th-claude", "th-unrelated");

    expect(await waiting.wait(20)).toBeNull();
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
          {
            type: "inputText",
            text: "<source_thread_id>th-claude</source_thread_id>",
          },
        ],
      },
      expected: "th-claude",
    },
    {
      name: "another tool's output",
      toolOutput: {
        name: "fork_thread",
        output: "<source_thread_id>th-claude</source_thread_id>",
      },
      expected: null,
    },
    {
      name: "no source id",
      toolOutput: { name: "create_thread", output: "created" },
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
      expected: { text: REPLY, sourceThreadId: "th-reviewer" },
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
        text: "<source_thread_id>th-codex\n</source_thread_id>",
        sourceThreadId: "th-codex",
      },
    },
    {
      name: "an output without a source",
      toolOutput: { name: "send_message_to_thread", output: "hello" },
      expected: { text: "hello", sourceThreadId: null },
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
