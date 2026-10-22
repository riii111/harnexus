import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Result } from "better-result";
import type { Fields } from "../format.ts";
import { saveJson } from "../session.ts";
import type { GitHub, PrComment, PrDetail, PrSummary } from "./github.ts";
import { loadWatchState, recordLink, type WatchState } from "./store.ts";
import { runCycle } from "./watcher.ts";

const PR = "https://github.com/org/pay/pull/7";
const HEAD = "a".repeat(40);
const LINKED_AT = "2026-10-20T00:00:00.000Z";
// Local noon, so the default quiet hours never apply unless a test asks for them.
const NOON = new Date(2026, 9, 23, 12, 0);

const cleanups: (() => Promise<unknown>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const summary = (fields: Partial<PrSummary> = {}): PrSummary => ({
  state: "OPEN",
  isDraft: false,
  head: HEAD,
  updatedAt: "2026-10-23T01:00:00Z",
  mergeable: "MERGEABLE",
  coderabbit: {
    state: "SUCCESS",
    description: "Review completed",
    createdAt: "2026-10-23T01:00:00Z",
  },
  rollup: "SUCCESS",
  ...fields,
});

const comment = (fields: Partial<PrComment>): PrComment => ({
  id: "inline:1",
  kind: "inline",
  author: "coderabbitai[bot]",
  url: `${PR}#discussion_r1`,
  createdAt: "2026-10-23T00:30:00Z",
  body: "**🟠 Major**",
  path: "src/pay.kt",
  line: 42,
  reply: false,
  resolved: false,
  ...fields,
});

const detailOf = (
  polled: PrSummary,
  comments: PrComment[],
  extra: Partial<PrDetail> = {},
): PrDetail => ({
  ...polled,
  url: PR,
  title: "Pay",
  failedRequired: [],
  comments,
  noActionableSummary: false,
  ...extra,
});

type Turn = Fields;

const turn = (fields: Fields = {}): Turn => ({
  status: "completed",
  startedAt: Math.floor(NOON.getTime() / 1000) - 3600,
  completedAt: Math.floor(NOON.getTime() / 1000) - 3500,
  items: [{ type: "userMessage", content: [{ type: "text", text: "go" }] }],
  ...fields,
});

// A turn another thread started, as a Claude worker shows it.
const delegatedTurn = (
  startedAt: Date,
  input: unknown,
  answer: string,
  source = "reviewer",
) =>
  turn({
    startedAt: Math.floor(startedAt.getTime() / 1000),
    completedAt: Math.floor(startedAt.getTime() / 1000) + 60,
    items: [
      {
        type: "userMessage",
        codexDelegation: { sourceThreadId: source, input: String(input) },
        content: [{ type: "text", text: "<codex_delegation>" }],
      },
      { type: "agentMessage", phase: "final_answer", text: answer },
    ],
  });

const fixture = async (config: Fields = {}) => {
  const root = await mkdtemp(join(tmpdir(), "harnexus-watch-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const env = {
    HOME: root,
    XDG_STATE_HOME: join(root, "state"),
    XDG_CONFIG_HOME: join(root, "config"),
  };
  await mkdir(join(root, "config/harnexus"), { recursive: true });
  await writeFile(
    join(root, "config/harnexus/pr-watch.json"),
    JSON.stringify({
      repositories: { "org/pay": { account: "owner" } },
      quietHours: null,
      ...config,
    }),
  );
  await recordLink(env, saveJson, {
    repo: "org/pay",
    number: 7,
    url: PR,
    worker: "worker",
    linkedAt: LINKED_AT,
  });
  const review = join(root, "state/taskctl/review/r1");
  await mkdir(review, { recursive: true });
  await writeFile(
    join(review, "state.json"),
    JSON.stringify({
      reviewer: "reviewer",
      candidate: { workerChatId: "worker" },
    }),
  );

  const world = {
    summary: summary(),
    comments: [] as PrComment[],
    extra: {} as Partial<PrDetail>,
    turns: [turn()] as Turn[],
    active: false,
    gone: false,
    sendOutcome: "done",
    now: NOON,
  };
  const calls = { summaries: 0, details: 0, sent: [] as Fields[] };

  const github: GitHub = {
    summaries: async (_account, refs) => {
      calls.summaries += 1;
      return Result.ok(refs.map(() => world.summary));
    },
    detail: async () => {
      calls.details += 1;
      return Result.ok(detailOf(world.summary, world.comments, world.extra));
    },
    openPulls: async () => Result.ok([]),
  };

  const callApp = async (caller: string, tool: string, args: Fields) => {
    if (tool === "read_thread") {
      if (world.gone)
        return {
          outcome: "tool_error",
          result: {
            content: [
              { type: "text", text: "No Codex thread found for threadId" },
            ],
            isError: true,
          },
        };
      const read = {
        thread: {
          id: args.threadId,
          status: { type: world.active ? "active" : "idle" },
        },
        turns: world.turns,
      };
      return {
        outcome: "done",
        result: { content: [{ type: "text", text: JSON.stringify(read) }] },
      };
    }
    calls.sent.push({ caller, tool, ...args });
    return { outcome: world.sendOutcome };
  };

  const logs: Fields[] = [];
  const cycle = async () => {
    const ran = await runCycle({
      env,
      saveJson,
      github,
      callApp,
      now: () => world.now,
      log: (entry) => logs.push(entry),
    });
    expect(ran.isOk()).toBe(true);
  };
  const state = async (): Promise<WatchState> =>
    (await loadWatchState(env, { repo: "org/pay", number: 7 })).unwrapOr(
      null as never,
    );
  const later = (minutes: number) => {
    world.now = new Date(world.now.getTime() + minutes * 60_000);
    world.summary = { ...world.summary, updatedAt: world.now.toISOString() };
  };
  return { env, world, calls, logs, cycle, state, later };
};

describe("runCycle", () => {
  test("sends a completed CodeRabbit review with its new findings in one message from the worker's reviewer", async () => {
    const { world, calls, cycle, state } = await fixture();
    world.comments = [
      comment({}),
      comment({ id: "inline:2", reply: true, url: `${PR}#discussion_r2` }),
      comment({
        id: "inline:3",
        createdAt: "2026-10-19T00:00:00Z",
        url: `${PR}#discussion_r3`,
      }),
      comment({
        id: "issue:4",
        kind: "issue_comment",
        author: "owner",
        url: `${PR}#issuecomment-4`,
      }),
    ];

    await cycle();

    expect(calls.sent).toHaveLength(1);
    const [sent] = calls.sent;
    expect([sent?.caller, sent?.tool, sent?.threadId]).toEqual([
      "reviewer",
      "send_message_to_thread",
      "worker",
    ]);
    expect(String(sent?.prompt)).toStartWith("$task-worker\n");
    expect(String(sent?.prompt)).toContain(
      `1. [CodeRabbit・Major] src/pay.kt:42 ${PR}#discussion_r1`,
    );
    for (const skipped of ["discussion_r2", "discussion_r3", "issuecomment-4"])
      expect(String(sent?.prompt)).not.toContain(skipped);
    const saved = await state();
    expect([
      saved.status,
      saved.pending,
      saved.delivered?.findings.length,
    ]).toEqual(["watching", [], 1]);
  });

  test("never sends an event again and checks the answer before the next message", async () => {
    const { world, calls, cycle, state, later } = await fixture();
    world.comments = [comment({})];
    await cycle();

    later(1);
    world.comments = [
      comment({}),
      comment({
        id: "issue:5",
        kind: "issue_comment",
        author: "tanaka",
        url: `${PR}#issuecomment-5`,
        createdAt: world.now.toISOString(),
      }),
    ];
    await cycle();
    expect(calls.sent).toHaveLength(1);

    world.turns = [
      delegatedTurn(NOON, calls.sent[0]?.prompt, `1. ${PR}#discussion_r1 直す`),
    ];
    later(1);
    await cycle();

    expect(calls.sent).toHaveLength(2);
    expect(String(calls.sent[1]?.prompt)).toContain(`${PR}#issuecomment-5`);
    expect(String(calls.sent[1]?.prompt)).not.toContain("discussion_r1");
    expect((await state()).followUp).toEqual([]);
  });

  test("sends one follow-up for the findings the answer left out", async () => {
    const { world, calls, cycle, later } = await fixture();
    world.comments = [
      comment({}),
      comment({ id: "inline:2", url: `${PR}#discussion_r2` }),
    ];
    await cycle();

    world.turns = [
      delegatedTurn(
        NOON,
        calls.sent[0]?.prompt,
        `${PR}#discussion_r1 のみ判定`,
      ),
    ];
    later(1);
    await cycle();
    world.turns = [
      delegatedTurn(world.now, calls.sent[1]?.prompt, "判定できません"),
      ...world.turns,
    ];
    later(1);
    await cycle();

    expect(calls.sent).toHaveLength(2);
    expect(String(calls.sent[1]?.prompt)).toContain(
      "次の判定が回答にありません",
    );
    expect(String(calls.sent[1]?.prompt)).toContain("discussion_r2");
    expect(String(calls.sent[1]?.prompt)).not.toContain("discussion_r1");
  });

  test("takes only the turn our message started as its answer", async () => {
    const { world, calls, cycle, later } = await fixture();
    world.comments = [comment({})];
    await cycle();
    const sent = calls.sent[0]?.prompt;
    later(1);
    world.comments = [
      comment({}),
      comment({
        id: "issue:5",
        kind: "issue_comment",
        author: "tanaka",
        url: `${PR}#issuecomment-5`,
        createdAt: world.now.toISOString(),
      }),
    ];

    world.turns = [
      delegatedTurn(NOON, sent, "unrelated", "coordinator"),
      delegatedTurn(NOON, "another message", "unrelated"),
      delegatedTurn(new Date(NOON.getTime() - 60_000), sent, "earlier"),
    ];
    await cycle();
    expect(calls.sent).toHaveLength(1);

    world.turns = [
      delegatedTurn(NOON, sent, `${PR}#discussion_r1`),
      ...world.turns,
    ];
    later(1);
    await cycle();

    expect(calls.sent).toHaveLength(2);
    expect(String(calls.sent[1]?.prompt)).toContain("issuecomment-5");
  });

  test("holds CodeRabbit's findings while its review runs and sends a person's comment at once", async () => {
    const { world, calls, cycle, later } = await fixture();
    world.summary = summary({
      coderabbit: {
        state: "PENDING",
        description: "Review in progress",
        createdAt: "2026-10-23T01:00:00Z",
      },
    });
    world.comments = [
      comment({}),
      comment({
        id: "inline:9",
        author: "tanaka",
        url: `${PR}#discussion_r9`,
      }),
    ];
    await cycle();

    expect(calls.sent).toHaveLength(1);
    expect(String(calls.sent[0]?.prompt)).toContain("[tanaka]");
    expect(String(calls.sent[0]?.prompt)).not.toContain("discussion_r1");

    world.turns = [
      delegatedTurn(NOON, calls.sent[0]?.prompt, `${PR}#discussion_r9`),
    ];
    world.summary = summary({ updatedAt: "2026-10-23T02:00:00Z" });
    later(1);
    await cycle();

    expect(calls.sent).toHaveLength(2);
    expect(String(calls.sent[1]?.prompt)).toContain("CodeRabbitのレビュー完了");
    expect(String(calls.sent[1]?.prompt)).toContain("discussion_r1");
  });

  test("tells a review without findings to report no findings", async () => {
    const { world, calls, cycle } = await fixture();
    world.extra = { noActionableSummary: true };

    await cycle();

    expect(String(calls.sent[0]?.prompt)).toContain(
      "「指摘なし」とだけ報告してください",
    );
    expect(String(calls.sent[0]?.prompt)).not.toContain("一致しない");
  });

  test.each([
    {
      name: "the worker's turn is running",
      set: (world: Fields) => {
        world.active = true;
      },
    },
    {
      name: "the owner talked to the worker a minute ago",
      set: (world: Fields) => {
        world.turns = [
          turn({ completedAt: Math.floor(NOON.getTime() / 1000) - 60 }),
        ];
      },
    },
    {
      name: "it is within the quiet hours",
      config: { quietHours: { start: "22:00", end: "05:00" } },
      set: (world: Fields) => {
        world.now = new Date(2026, 9, 23, 23, 30);
      },
    },
  ])("queues without sending while $name", async ({ config, set }) => {
    const { world, calls, cycle, state } = await fixture(config);
    world.comments = [comment({})];
    set(world);

    await cycle();

    expect(calls.sent).toEqual([]);
    expect((await state()).pending.map((event) => event.type)).toEqual([
      "coderabbit_done",
      "finding",
    ]);
  });

  test("halts on an unconfirmed send and never sends for the PR again", async () => {
    const { world, calls, cycle, state, later } = await fixture();
    world.comments = [comment({})];
    world.sendOutcome = "unknown";
    await cycle();

    world.sendOutcome = "done";
    later(5);
    await cycle();

    const saved = await state();
    expect(calls.sent).toHaveLength(1);
    expect([saved.status, typeof saved.halted?.prompt]).toEqual([
      "halted",
      "string",
    ]);
  });

  test("keeps the message queued when the app is not reachable", async () => {
    const { world, calls, cycle, state, later } = await fixture();
    world.comments = [comment({})];
    world.sendOutcome = "not_sent";
    await cycle();

    world.sendOutcome = "done";
    later(1);
    await cycle();

    expect(calls.sent).toHaveLength(2);
    expect((await state()).pending).toEqual([]);
  });

  test("pauses a draft without reading its detail and resumes when it is ready", async () => {
    const { world, calls, cycle, state, later } = await fixture();
    world.summary = summary({ isDraft: true });
    world.comments = [comment({})];
    await cycle();
    expect([calls.details, (await state()).status]).toEqual([0, "draft"]);

    world.summary = summary({ isDraft: false });
    later(1);
    await cycle();

    expect(calls.details).toBe(1);
    expect(calls.sent).toHaveLength(1);
  });

  test.each([
    {
      name: "a merged PR",
      set: (world: Fields) => {
        world.summary = summary({ state: "MERGED" });
      },
      expected: ["ended", "merged"],
    },
    {
      name: "a PR whose worker thread is gone",
      set: (world: Fields) => {
        world.gone = true;
        world.comments = [comment({})];
      },
      expected: ["stopped", "worker thread is gone"],
    },
  ])("stops watching $name", async ({ set, expected }) => {
    const { world, calls, cycle, state, later } = await fixture();
    set(world);
    await cycle();
    const polls = calls.summaries;

    later(5);
    await cycle();

    const saved = await state();
    expect([saved.status, saved.reason]).toEqual([...expected]);
    expect(calls.summaries).toBe(polls);
    expect(calls.sent).toEqual([]);
  });

  test("reads the detail only when the light poll changed", async () => {
    const { world, calls, cycle } = await fixture();
    await cycle();

    world.now = new Date(NOON.getTime() + 60_000);
    await cycle();

    expect([calls.summaries, calls.details]).toEqual([2, 1]);
  });

  test("polls a PR idle for longer than idleAfterHours at the idle interval", async () => {
    const { world, calls, cycle } = await fixture({
      idleAfterHours: 1,
      idleIntervalSeconds: 600,
    });
    await cycle();

    world.now = new Date(NOON.getTime() + 2 * 3_600_000);
    await cycle();
    world.now = new Date(world.now.getTime() + 60_000);
    await cycle();
    world.now = new Date(world.now.getTime() + 600_000);
    await cycle();

    expect(calls.summaries).toBe(3);
  });

  test("tells a conflict once per head and a failed required check once per head", async () => {
    const { world, calls, cycle, later } = await fixture();
    world.summary = summary({ mergeable: "CONFLICTING", rollup: "FAILURE" });
    world.extra = {
      failedRequired: [{ name: "build", url: "https://ci.example/1" }],
    };
    await cycle();

    world.turns = [delegatedTurn(NOON, calls.sent[0]?.prompt, "ok")];
    later(1);
    await cycle();

    expect(calls.sent).toHaveLength(1);
    expect(String(calls.sent[0]?.prompt)).toContain("[コンフリクト]");
    expect(String(calls.sent[0]?.prompt)).toContain("[必須CIの失敗] build");
  });

  test("leaves a PR of a repository the config does not list unpolled", async () => {
    const { calls, cycle, state } = await fixture({ repositories: {} });

    await cycle();

    expect([calls.summaries, calls.sent]).toEqual([0, []]);
    expect((await state()).reason).toBe("repository is not configured");
  });
});
