import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Result } from "better-result";

import { createCloudCheckouts } from "../infra/claude/cloud-checkouts.ts";
import { cloudCli } from "../infra/claude/cloud.ts";
import { createModelCatalog, effortRule } from "../infra/claude/models.ts";
import { createMemoryCronRecord } from "../infra/codex/testing/cron-record.ts";
import { EMPTY_EXTERNAL_STATE } from "../infra/external-conversations.ts";
import { openThreadStore } from "../infra/thread-store.ts";
import { startLineProcess } from "../lib/process.boundary.ts";
import { connectClaudeThreads } from "./bridge-wiring.ts";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "harnexus-adapter-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("connectClaudeThreads with an outside conversation adapter", () => {
  test.each([{ mode: "write" as const }, { mode: "observe" as const }])(
    "starts the registered $mode adapter as a process spoken to without the call socket",
    async ({ mode }) => {
      const { threads, received } = await connectAdapter(mode);

      await until(async () =>
        (await received()).some((line) => line.type === "response"),
      );
      threads.closeAll();

      expect(await received()).toEqual([
        expect.objectContaining({ type: "hello", bridgeId: "bridge-1", mode }),
        expect.objectContaining({ type: "ready", bridgeId: "bridge-1" }),
        expect.objectContaining({
          type: "response",
          id: 1,
          outcome: "rejected",
          reason: mode === "write" ? "unknown_caller" : "observe_only",
        }),
      ]);
    },
  );
});

// An adapter that keeps every line it is sent and, once ready, asks to bind a chat the bridge does not hold.
const ADAPTER = `
const { createInterface } = require("node:readline");
const { appendFileSync } = require("node:fs");
const log = process.argv[2];
const say = (message) => process.stdout.write(JSON.stringify({ v: 1, ...message }) + "\\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  appendFileSync(log, line + "\\n");
  const message = JSON.parse(line);
  if (message.type === "hello") say({ type: "hello", adapterId: "my-adapter", bindings: [] });
  if (message.type === "ready")
    say({ type: "request", id: 1, op: "bind_conversation", conversationId: "c1", threadId: "chat-x" });
});
`;

const connectAdapter = async (mode: "observe" | "write") => {
  const script = join(dir, "adapter.cjs");
  const log = join(dir, "received.jsonl");
  await writeFile(script, ADAPTER);
  await writeFile(log, "");
  const store = (await openThreadStore(join(dir, "threads.json"))).unwrap();
  const catalog = createModelCatalog();
  const adapter = {
    id: "my-adapter",
    command: process.execPath,
    args: [script, log],
    mode,
  };
  const threads = connectClaudeThreads({
    store,
    request: async () => Result.ok({}),
    startSession: () => expect.unreachable("no Claude session is started"),
    findSession: async () => Result.ok(true),
    listConversations: async () => Result.ok([]),
    lastRecordOf: async () => Result.ok(null),
    readSession: async () => Result.ok([]),
    readSubagents: async () => Result.ok([]),
    effortRule: effortRule({}, catalog.effortsOf),
    claudeModels: catalog.models,
    codexHome: "/fixture/.codex",
    cronRecord: createMemoryCronRecord(),
    cloud: {
      cli: cloudCli({}),
      copyDir: join(dir, "cloud-copies"),
      checkouts: createCloudCheckouts(join(dir, "checkouts"), {}),
    },
    external: {
      adapter: {
        settings: adapter,
        spawn: (handlers) =>
          startLineProcess(adapter.command, adapter.args, handlers),
      },
      bridgeId: "bridge-1",
      store: {
        initial: EMPTY_EXTERNAL_STATE,
        read: async () => EMPTY_EXTERNAL_STATE,
        update: async (change) => ({
          state: EMPTY_EXTERNAL_STATE,
          result: change(EMPTY_EXTERNAL_STATE).result,
        }),
      },
    },
    send: () => {},
    log: () => {},
  });
  const received = async () =>
    (await readFile(log, "utf8"))
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  return { threads, received };
};

const until = async (done: () => Promise<boolean>) => {
  for (let tries = 0; tries < 200 && !(await done()); tries++)
    await new Promise((resolve) => setTimeout(resolve, 10));
};
