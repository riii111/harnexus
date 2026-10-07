import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runTask, TASK_DEPS, type TaskDeps } from "./cli.ts";
import { callApp, type SaveJson, saveJson } from "./session.ts";

const SKILLS = join(import.meta.dir, "../../../test/fixtures/task-skills");
const README = join(import.meta.dir, "../../../README.md");

// A connection closed without an answer, as when the bridge stops mid-call.
const DROP = "drop";

type Answer = Record<string, unknown> | typeof DROP;
type Call = {
  threadId: string;
  tool: string;
  arguments: {
    prompt: string;
    title?: string;
    model?: string;
    thinking?: string;
    threadId?: string;
    target: {
      projectId: string;
      environment: { type: string; startingState?: unknown };
    };
  };
};

const cleanups: (() => Promise<unknown>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const fakeHarnexus = async (path: string) => {
  const calls: Call[] = [];
  const answers: Answer[] = [];
  const server = createServer((socket) => {
    let data = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      data += chunk;
      if (!data.endsWith("\n")) return;
      calls.push(JSON.parse(data));
      const answer = answers.shift();
      socket.end(answer === DROP ? "" : `${JSON.stringify(answer)}\n`);
    });
  });
  await new Promise<void>((resolve) => server.listen(path, resolve));
  cleanups.push(() => new Promise((resolve) => server.close(resolve)));
  return { calls, answers };
};

const fixture = async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "harnexus-task-")));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const socket = join(root, "call.sock");
  const codex = join(root, "codex");
  await mkdir(codex);
  await symlink(SKILLS, join(codex, "skills"));
  const env: Record<string, string> = {
    CODEX_HOME: codex,
    CODEX_THREAD_ID: "caller",
    HARNEXUS_CALL_SOCKET: socket,
    XDG_STATE_HOME: join(root, "state"),
  };
  const harnexus = await fakeHarnexus(socket);
  const invoke = async (
    args: string[],
    answers: Answer[] = [],
    deps: Partial<Omit<TaskDeps, "env">> = {},
  ) => {
    harnexus.answers.push(...answers);
    const run = await runTask(args, {
      ...TASK_DEPS,
      ...deps,
      env: { ...process.env, ...env },
    });
    expect(harnexus.answers).toEqual([]);
    return {
      code: run.code,
      out: run.code === 0 ? JSON.parse(run.stdout) : null,
      err: run.stderr,
      stdout: run.stdout,
    };
  };
  const write = async (data: unknown) => {
    const path = join(root, "request.json");
    await writeFile(path, JSON.stringify(data));
    return path;
  };
  return { root, codex, socket, env, harnexus, invoke, write };
};

const created = (thread: string, model: string, effort = "medium") => ({
  outcome: "done",
  threadId: thread,
  model,
  effort,
});

const launchFixture = async () => {
  const base = await fixture();
  const document = join(base.root, "合意 {braces} $values.md");
  await writeFile(document, "PRIVATE_DOCUMENT_BODY_MUST_NOT_BE_COPIED");
  const data: Record<string, unknown> = {
    taskId: "TR1",
    documentRefs: [document, "https://linear.app/example/issue/EX-1"],
    completionTarget: "draft_pr",
    projectId: "project",
  };
  const launch = async (extra: string[] = [], answers: Answer[] = []) =>
    base.invoke(
      ["launch", "--request", await base.write(data), ...extra],
      answers,
    );
  return { ...base, data, launch };
};

describe("harnexus-task launch", () => {
  test("creates the worker once and reports the actual model", async () => {
    const { harnexus, invoke, write, data, launch } = await launchFixture();

    const first = await launch([], [created("w1", "claude-opus-5-5")]);

    expect([first.code, first.err]).toEqual([0, ""]);
    expect(first.out.threadId).toBe("w1");
    expect(first.out.model).toBe("claude-opus-5-5");
    const [call] = harnexus.calls;
    if (call === undefined) return expect.unreachable("nothing was sent");
    expect(call.threadId).toBe("caller");
    expect(call.tool).toBe("create_thread");
    const args = call.arguments;
    expect(args.title).toBe("Impl TR1");
    expect(args.target.environment.type).toBe("worktree");
    expect(args.target.projectId).toBe("project");
    expect([args.model, args.thinking]).toEqual(["claude-opus-5-5", "medium"]);
    for (const reference of data.documentRefs as string[])
      expect(args.prompt).toContain(reference);
    expect(args.prompt).toContain("Draft PR・CI成功まで");
    expect(args.prompt).toContain(
      await realpath(join(SKILLS, "task-worker/SKILL.md")),
    );
    expect(args.prompt).not.toContain("PRIVATE_DOCUMENT_BODY");

    const again = await launch();
    expect([again.code, again.out.existing]).toEqual([0, "w1"]);
    data.completionTarget = "merge";
    const changed = await launch();
    expect(changed.code).toBe(1);
    expect(changed.err).toContain("already has worker w1");
    expect(harnexus.calls).toHaveLength(1);
    const state = await invoke(["state", "--request", await write(data)]);
    expect(state.out.state.sent.prompt).toBe(args.prompt);
    expect(state.out.state.sent.actual.effort).toBe("medium");
  });

  test("stops at a model mismatch without a second create", async () => {
    const { harnexus, invoke, write, data, launch } = await launchFixture();
    const mismatch = {
      outcome: "model_mismatch",
      threadId: "w1",
      expected: "gpt-6.1-sol",
      actual: "gpt-5",
    };

    const refused = await launch(["--model", "gpt-6.1-sol"], [mismatch]);

    expect(refused.code).toBe(1);
    expect(refused.err).toContain("refused");
    expect(refused.err).toContain("gpt-5");
    expect((await launch(["--model", "gpt-6.1-sol"])).code).toBe(1);
    expect(harnexus.calls).toHaveLength(1);
    const request = await write(data);
    expect(
      (await invoke(["resolve", "--request", request, "--sent"])).code,
    ).toBe(1);
    const released = await invoke([
      "resolve",
      "--request",
      request,
      "--not-sent",
    ]);
    expect([released.code, released.err]).toEqual([0, ""]);
    const state = await invoke(["state", "--request", request]);
    expect(state.out.refused[0].actual).toBe("gpt-5");
    const retried = await launch([], [created("w2", "claude-opus-5-5")]);
    expect([retried.code, retried.out.threadId]).toEqual([0, "w2"]);
  });

  test("never resends a create whose answer was lost", async () => {
    const { harnexus, invoke, write, data, launch } = await launchFixture();

    const lost = await launch([], [DROP]);

    expect(lost.code).toBe(1);
    expect(lost.err).toContain("never resend");
    const again = await launch();
    expect(again.code).toBe(1);
    expect(again.err).toContain("never resend");
    expect(harnexus.calls).toHaveLength(1);
    const request = await write(data);
    const unnamed = await invoke(["resolve", "--request", request, "--sent"]);
    expect(unnamed.code).toBe(1);
    expect(unnamed.err).toContain("--thread-id");
    const named = await invoke([
      "resolve",
      "--request",
      request,
      "--sent",
      "--thread-id",
      "w9",
    ]);
    expect([named.code, named.err]).toEqual([0, ""]);
    expect((await launch()).out.existing).toBe("w9");
  });

  test("keeps the thread ID of an unknown result for resolution", async () => {
    const { invoke, write, data, launch } = await launchFixture();

    const unknown = await launch([], [{ outcome: "unknown", threadId: "w3" }]);
    const resolved = await invoke([
      "resolve",
      "--request",
      await write(data),
      "--sent",
    ]);

    expect(unknown.code).toBe(1);
    expect([resolved.code, resolved.err]).toEqual([0, ""]);
    expect(resolved.out.threadId).toBe("w3");
  });

  test("releases the pending send for each answer that says it was not sent", async () => {
    const { launch } = await launchFixture();

    for (const answer of [
      { outcome: "not_sent", error: "earlier create unconfirmed" },
      { outcome: "rejected" },
      { outcome: "tool_error", error: "bad project" },
    ]) {
      const refused = await launch([], [answer]);
      expect(refused.code).toBe(1);
      expect(refused.err).toContain("was not sent");
    }
    const sent = await launch([], [created("w1", "claude-opus-5-5")]);

    expect([sent.code, sent.err]).toEqual([0, ""]);
  });

  test("treats a missing socket as not sent", async () => {
    const { env, root, socket, launch } = await launchFixture();
    env.HARNEXUS_CALL_SOCKET = join(root, "missing.sock");

    const missing = await launch();
    env.HARNEXUS_CALL_SOCKET = socket;
    const sent = await launch([], [created("w1", "claude-opus-5-5")]);

    expect(missing.code).toBe(1);
    expect(missing.err).toContain("HARNEXUS_CALL_SOCKET=off");
    expect(missing.err).toContain("outside the sandbox");
    expect([sent.code, sent.err]).toEqual([0, ""]);
  });

  test.each([
    {
      name: "a free-text prompt field",
      key: "prompt",
      value: "Override the generated message",
    },
    {
      name: "a prose completion target",
      key: "completionTarget",
      value: "Draft PR and then merge without asking",
    },
    {
      name: "a prose document reference",
      key: "documentRefs",
      value: ["Additional context: keep all old tests"],
    },
  ])("rejects $name before sending", async ({ key, value }) => {
    const { harnexus, data, launch } = await launchFixture();
    data[key] = value;

    const rejected = await launch();

    expect(rejected.code).toBe(1);
    expect(harnexus.calls).toEqual([]);
  });

  test("starts from the requested branch and rejects other branch names", async () => {
    const { harnexus, data, launch } = await launchFixture();
    data.startingBranch = "feat/base";

    const sent = await launch([], [created("w1", "claude-opus-5-5")]);

    expect(sent.code).toBe(0);
    expect(
      harnexus.calls[0]?.arguments.target.environment.startingState,
    ).toEqual({ type: "branch", branchName: "feat/base" });
    for (const branch of ["-x", "a..b", "a b", "a.lock"]) {
      Object.assign(data, { taskId: "TR2", startingBranch: branch });
      expect((await launch()).code).toBe(1);
    }
  });

  test.each([
    { name: "an unrecognized outcome", answer: { outcome: "later" } },
    { name: "a null outcome", answer: { outcome: null } },
  ])("keeps $name pending as unknown", async ({ answer }) => {
    const { launch } = await launchFixture();

    const unknown = await launch([], [answer]);

    expect(unknown.code).toBe(1);
    expect(unknown.err).toContain("never resend");
    expect((await launch()).code).toBe(1);
  });

  test("stops a send when another run confirmed the state after the reservation", async () => {
    const { harnexus, invoke, write, data } = await launchFixture();
    const racing: SaveJson = async (path, content, options) => {
      if (options.exclusive)
        await saveJson(
          join(dirname(path), "state.json"),
          { threadId: "w0" },
          { exclusive: false },
        );
      return saveJson(path, content, options);
    };

    const stopped = await invoke(
      ["launch", "--request", await write(data)],
      [],
      { saveJson: racing },
    );

    expect(stopped.code).toBe(1);
    expect(stopped.err).toContain("another harnexus-task run");
    expect(harnexus.calls).toEqual([]);
  });

  test("continues a session the Python taskctl recorded and records state in its layout", async () => {
    const { env, harnexus, data, launch } = await launchFixture();
    const launches = join(env.XDG_STATE_HOME ?? "", "taskctl/launch");
    // The key the Python version derives from "project\nTR1".
    const session = join(launches, "6279de90d3447943");
    await mkdir(session, { recursive: true });
    await writeFile(
      join(session, "state.json"),
      `{\n "threadId": "w1",\n "request": ${JSON.stringify(data)}\n}`,
    );

    const resumed = await launch();
    data.taskId = "TR9";
    const lost = await launch([], [DROP]);
    const other =
      (await readdir(launches)).find((name) => name !== "6279de90d3447943") ??
      "";
    const pending = JSON.parse(
      await readFile(join(launches, other, "pending.json"), "utf8"),
    );

    expect(resumed.out).toEqual({
      existing: "w1",
      state: join(session, "state.json"),
    });
    expect(lost.code).toBe(1);
    expect(harnexus.calls).toHaveLength(1);
    const workspace = {
      type: "project",
      projectId: "project",
      environment: { type: "worktree" },
    };
    expect(pending).toEqual({
      status: "unknown",
      tool: "create_thread",
      arguments: {
        prompt: expect.any(String),
        target: workspace,
        title: "Impl TR9",
        model: "claude-opus-5-5",
        thinking: "medium",
      },
      request: data,
      workspace,
      threadId: null,
      answer: { outcome: "unknown", error: expect.any(String) },
    });
  });

  test("records a confirmed launch in the Python state layout", async () => {
    const { data, launch } = await launchFixture();

    const sent = await launch([], [created("w1", "claude-opus-5-5")]);
    const state = JSON.parse(await readFile(sent.out.state, "utf8"));

    expect(state).toEqual({
      threadId: "w1",
      request: data,
      sent: {
        tool: "create_thread",
        prompt: expect.any(String),
        expected: { model: "claude-opus-5-5", effort: "medium" },
        actual: { model: "claude-opus-5-5", effort: "medium" },
        workspace: {
          type: "project",
          projectId: "project",
          environment: { type: "worktree" },
        },
        answer: created("w1", "claude-opus-5-5"),
      },
    });
  });

  test("keeps a done answer it cannot confirm pending as unknown", async () => {
    const { invoke, write, data, launch } = await launchFixture();

    const unconfirmed = await launch([], [{ outcome: "done" }]);
    const request = await write(data);
    const state = await invoke(["state", "--request", request]);
    const blocked = await launch();
    const resolved = await invoke([
      "resolve",
      "--request",
      request,
      "--sent",
      "--thread-id",
      "w1",
    ]);

    expect(unconfirmed.code).toBe(1);
    expect(unconfirmed.err).toContain("thread ID is unknown");
    expect(state.out.pending).toMatchObject({
      status: "unknown",
      threadId: null,
      answer: { outcome: "done" },
    });
    expect(blocked.err).toContain("never resend");
    expect([resolved.code, resolved.out.threadId]).toEqual([0, "w1"]);
  });

  test("ignores relative state and Codex directories", async () => {
    const { root, env, launch } = await launchFixture();
    await mkdir(join(root, ".codex"));
    await symlink(SKILLS, join(root, ".codex/skills"));
    Object.assign(env, {
      HOME: root,
      CODEX_HOME: "harnexus-task-relative-codex",
      XDG_STATE_HOME: "harnexus-task-relative-state",
    });

    const sent = await launch([], [created("w1", "claude-opus-5-5")]);

    expect([sent.code, sent.err]).toEqual([0, ""]);
    expect(sent.out.state.startsWith(join(root, ".local/state/taskctl/"))).toBe(
      true,
    );
  });

  test("treats a stale socket file as not sent", async () => {
    const { env, root, socket, launch } = await launchFixture();
    const stale = join(root, "stale.sock");
    await writeFile(stale, "");
    env.HARNEXUS_CALL_SOCKET = stale;

    const refused = await launch();
    env.HARNEXUS_CALL_SOCKET = socket;
    const sent = await launch([], [created("w1", "claude-opus-5-5")]);

    expect(refused.code).toBe(1);
    expect(refused.err).toContain("was not sent");
    expect([sent.code, sent.err]).toEqual([0, ""]);
  });
});

describe("callApp", () => {
  test("reports a connected call without an answer in time as unknown", async () => {
    const { root } = await fixture();
    const silent = join(root, "silent.sock");
    const server = createServer(() => {});
    await new Promise<void>((resolve) => server.listen(silent, resolve));
    cleanups.push(async () => {
      server.close();
    });

    const answer = await callApp(
      { HARNEXUS_CALL_SOCKET: silent },
      "caller",
      "create_thread",
      {},
      50,
    );

    expect(answer.outcome).toBe("unknown");
  });
});

const reviewFixture = async () => {
  const base = await fixture();
  const checkout = join(base.codex, "worktrees/ab12/checkout");
  await mkdir(checkout, { recursive: true });
  const git = (...args: string[]) => {
    const ran = Bun.spawnSync(
      [
        "git",
        "-C",
        checkout,
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "-c",
        "commit.gpgsign=false",
        ...args,
      ],
      { stderr: "pipe" },
    );
    expect([ran.exitCode, ran.stderr.toString()]).toEqual([
      0,
      expect.any(String),
    ]);
    return ran.stdout.toString().trim();
  };
  const commit = (message: string) => {
    git("commit", "--allow-empty", "-qm", message);
    return git("rev-parse", "HEAD");
  };
  git("init", "-q");
  const initial = commit("test: initial");
  git("branch", "base");
  base.env.CODEX_THREAD_ID = "worker";
  const data: Record<string, unknown> = {
    taskId: "example",
    workerAI: "Codex",
    projectId: "project",
    checkout,
    baseBranch: "base",
    documentRefs: [README, "https://example.com/task/1"],
    prUrl: null,
  };
  const review = async (extra: string[] = [], answers: Answer[] = []) =>
    base.invoke(
      ["review", "--request", await base.write(data), ...extra],
      answers,
    );
  return { ...base, checkout, git, commit, initial, data, review };
};

describe("harnexus-task review", () => {
  test("sends each head once, re-reviews going to the same reviewer", async () => {
    const { harnexus, checkout, git, commit, initial, data, review } =
      await reviewFixture();
    const head = commit("test: candidate");
    const before = (await readdir(checkout)).sort();

    const first = await review([], [created("r1", "gpt-6.1-sol")]);

    expect([first.code, first.err]).toEqual([0, ""]);
    const [call] = harnexus.calls;
    if (call === undefined) return expect.unreachable("nothing was sent");
    expect([call.threadId, call.tool]).toEqual(["worker", "create_thread"]);
    const args = call.arguments;
    expect([args.model, args.thinking]).toEqual(["gpt-6.1-sol", "medium"]);
    expect(args.title).toBe("Review example");
    expect(args.prompt).toContain(`${initial}...${head}`);
    expect(args.prompt).toContain("workerのチャットID: worker");
    expect(git("status", "--porcelain")).toBe("");
    const repeated = await review();
    expect(repeated.code).toBe(1);
    expect(repeated.err).toContain("already sent to reviewer r1");
    const fixed = commit("test: fix");
    data.prUrl = "https://github.com/example/repo/pull/1";
    const again = await review([], [{ outcome: "done" }]);
    expect([again.code, again.err]).toEqual([0, ""]);
    expect(again.out.threadId).toBe("r1");
    const last = harnexus.calls.at(-1);
    expect(last?.tool).toBe("send_message_to_thread");
    expect(last?.arguments.threadId).toBe("r1");
    expect(last?.arguments).not.toHaveProperty("model");
    expect(last?.arguments.prompt).toContain(`${initial}...${fixed}`);
    expect(last?.arguments.prompt).toContain(String(data.prUrl));
    expect((await review()).code).toBe(1);
    expect(harnexus.calls).toHaveLength(2);
    expect((await readdir(checkout)).sort()).toEqual(before);
  });

  test("keeps a reviewer it cannot accept pending as unknown", async () => {
    const { invoke, write, data, review } = await reviewFixture();

    const itself = await review([], [created("worker", "gpt-6.1-sol")]);
    const state = await invoke(["state", "--request", await write(data)]);
    const blocked = await review();

    expect(itself.code).toBe(1);
    expect(itself.err).toContain("cannot review itself");
    expect(state.out.pending).toMatchObject({
      status: "unknown",
      threadId: "worker",
    });
    expect(blocked.err).toContain("never resend");
  });

  test("records a confirmed review in the Python state layout", async () => {
    const { checkout, initial, data, review } = await reviewFixture();

    const sent = await review([], [created("r1", "gpt-6.1-sol")]);
    const state = JSON.parse(await readFile(sent.out.state, "utf8"));

    expect(state).toEqual({
      reviewer: "r1",
      candidate: {
        ...data,
        checkout,
        workerChatId: "worker",
        head: initial,
        base: initial,
      },
      sent: {
        tool: "create_thread",
        prompt: expect.any(String),
        expected: { model: "gpt-6.1-sol", effort: "medium" },
        actual: { model: "gpt-6.1-sol", effort: "medium" },
        workspace: checkout,
        answer: created("r1", "gpt-6.1-sol"),
      },
    });
  });

  test("keeps a re-review tool_error unknown", async () => {
    const { harnexus, commit, review } = await reviewFixture();
    expect((await review([], [created("r1", "gpt-6.1-sol")])).code).toBe(0);
    commit("test: fix");

    const failed = await review(
      [],
      [{ outcome: "tool_error", error: "may or may not have taken effect" }],
    );
    const again = await review();

    expect(failed.code).toBe(1);
    expect(failed.err).toContain("never resend");
    expect(again.code).toBe(1);
    expect(again.err).toContain("never resend");
    expect(harnexus.calls).toHaveLength(2);
  });

  test("refuses a directory nested in the worktree", async () => {
    const { harnexus, checkout, git, data, review } = await reviewFixture();
    const nested = join(checkout, "nested");
    await mkdir(nested);
    data.checkout = nested;

    const refused = await review();
    git("init", "-q", "nested");
    const refusedRepository = await review();

    expect(refused.code).toBe(1);
    expect(refused.err).toContain("top level");
    expect(refusedRepository.code).toBe(1);
    expect(harnexus.calls).toEqual([]);
  });

  test("never fetches a missing commit", async () => {
    const { harnexus, root, checkout, git, review } = await reviewFixture();
    const marker = join(root, "marker");
    git("config", "core.repositoryformatversion", "1");
    git("config", "extensions.partialClone", "origin");
    git("config", "remote.origin.url", join(root, "nowhere"));
    git("config", "remote.origin.promisor", "true");
    git("config", "remote.origin.uploadpack", `touch ${marker}; false`);
    await writeFile(
      join(checkout, ".git/refs/heads/base"),
      `${"1".repeat(40)}\n`,
    );

    const refused = await review();

    expect(refused.code).toBe(1);
    expect(await Bun.file(marker).exists()).toBe(false);
    expect(harnexus.calls).toEqual([]);
  });

  test("blocks a resend after a lost re-review answer", async () => {
    const { harnexus, invoke, write, commit, data, review } =
      await reviewFixture();
    expect((await review([], [created("r1", "gpt-6.1-sol")])).code).toBe(0);
    commit("test: fix");

    const lost = await review([], [DROP]);
    commit("test: another fix");
    const blocked = await review();

    expect(lost.code).toBe(1);
    expect(blocked.code).toBe(1);
    expect(blocked.err).toContain("never resend");
    expect(harnexus.calls).toHaveLength(2);
    const resolved = await invoke([
      "resolve",
      "--request",
      await write(data),
      "--sent",
    ]);
    expect([resolved.code, resolved.err]).toEqual([0, ""]);
    expect(resolved.out.threadId).toBe("r1");
  });

  test("keeps the base until it is updated explicitly", async () => {
    const { harnexus, git, commit, data, review } = await reviewFixture();
    expect((await review([], [created("r1", "gpt-6.1-sol")])).code).toBe(0);
    git("checkout", "-qb", "upstream");
    const upstream = commit("test: upstream");
    git("checkout", "-q", "-");
    git("merge", "-q", "--no-edit", upstream);
    const head = commit("test: worker");
    data.baseBranch = "upstream";

    const kept = await review();
    const updated = await review(["--update-base"], [{ outcome: "done" }]);

    expect(kept.code).toBe(1);
    expect(kept.err).toContain("--update-base");
    expect([updated.code, updated.err]).toEqual([0, ""]);
    expect(harnexus.calls.at(-1)?.arguments.prompt).toContain(
      `${upstream}...${head}`,
    );
  });

  test("runs only plumbing git, and only in worker worktrees", async () => {
    const { root, codex, invoke, write, data } = await reviewFixture();
    const runs: { argv: readonly string[]; env: Record<string, unknown> }[] =
      [];
    const runGit: TaskDeps["runGit"] = (argv, env) => {
      runs.push({ argv, env });
      return TASK_DEPS.runGit(argv, env);
    };

    const sent = await invoke(
      ["review", "--request", await write(data)],
      [created("r1", "gpt-6.1-sol")],
      { runGit },
    );

    expect([sent.code, sent.err]).toEqual([0, ""]);
    expect(runs).not.toEqual([]);
    for (const { argv, env } of runs) {
      expect(argv).toContain("protocol.allow=never");
      expect(["rev-parse", "merge-base"]).toContain(argv[9] ?? "");
      expect(env.GIT_NO_LAZY_FETCH).toBe("1");
    }
    const outside = join(root, "outside");
    await mkdir(outside);
    data.checkout = outside;
    const refused = await invoke(["review", "--request", await write(data)]);
    expect(refused.code).toBe(1);
    expect(refused.err).toContain("worker worktree");
    const link = join(codex, "worktrees/link");
    await symlink(outside, link);
    data.checkout = link;
    expect(
      (await invoke(["review", "--request", await write(data)])).code,
    ).toBe(1);
  });

  test("refuses the worker as its own reviewer and a request naming another worker", async () => {
    const { invoke, write, data, review } = await reviewFixture();
    data.workerChatId = "worker";
    expect((await review([], [DROP])).code).toBe(1);

    const itself = await invoke([
      "resolve",
      "--request",
      await write(data),
      "--sent",
      "--thread-id",
      "worker",
    ]);
    data.workerChatId = "someone-else";
    const other = await review();

    expect(itself.code).toBe(1);
    expect(itself.err).toContain("cannot review itself");
    expect(other.code).toBe(1);
    expect(other.err).toContain("must equal CODEX_THREAD_ID");
  });

  test("refuses to run without a caller thread", async () => {
    const { env, review } = await reviewFixture();
    env.CODEX_THREAD_ID = "";

    const refused = await review();

    expect(refused.code).toBe(1);
    expect(refused.err).toContain("CODEX_THREAD_ID");
  });

  test("resumes a confirmed reviewctl state and refuses a pending one", async () => {
    const { harnexus, checkout, commit, initial, review } =
      await reviewFixture();
    const legacy = {
      identifier: "example",
      worker: "Codex",
      workerId: "worker",
      projectId: "project",
      checkout,
      base: initial,
      head: initial,
    };
    const state = join(checkout, ".reviewctl/state.json");
    await mkdir(dirname(state));
    await writeFile(
      state,
      JSON.stringify({
        reviewer: null,
        pending_create: true,
        candidate: legacy,
      }),
    );

    const pending = await review();
    await writeFile(
      state,
      JSON.stringify({ reviewer: "r0", candidate: legacy }),
    );
    commit("test: fix");
    const resumed = await review([], [{ outcome: "done" }]);

    expect(pending.code).toBe(1);
    expect(pending.err).toContain("legacy reviewctl creation is pending");
    expect([resumed.code, resumed.err]).toEqual([0, ""]);
    expect(harnexus.calls.at(-1)?.arguments.threadId).toBe("r0");
    expect(JSON.parse(await readFile(state, "utf8")).reviewer).toBe("r0");
  });

  test.each([
    {
      name: "an existing file",
      content: '{"reviewer": "r0", "candidate": {}}',
    },
    { name: "nothing", content: null },
  ])("refuses a reviewctl state symlinked to $name", async ({ content }) => {
    const { root, checkout, review } = await reviewFixture();
    const target = join(root, "elsewhere.json");
    if (content !== null) await writeFile(target, content);
    await mkdir(join(checkout, ".reviewctl"));
    await symlink(target, join(checkout, ".reviewctl/state.json"));

    const refused = await review();

    expect(refused.code).toBe(1);
    expect(refused.err).toContain("symlinked");
  });
});
