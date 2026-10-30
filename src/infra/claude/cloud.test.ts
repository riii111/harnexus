import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Result } from "better-result";
import { runCommand } from "../../runtime/process.boundary.ts";
import {
  type CloudCli,
  claudeCliFile,
  copyCloudSession,
  parseCloudSessionId,
  sendToCloud,
  stabilizeCopy,
} from "./cloud.ts";
import { createCloudCheckouts } from "./cloud-checkouts.ts";
import {
  bundledClaude,
  type ClaudeRun,
  ClaudeRunFailed,
} from "./run.boundary.ts";

const COPY = "467614f6-4ec9-44b7-a282-e2c79981140d";

type Call = {
  file: string;
  args: readonly string[];
  input: string;
  cwd: string;
};

const cliAnswering = (
  answer: Result<ClaudeRun, ClaudeRunFailed>,
  calls: Call[] = [],
): CloudCli => ({
  file: "/usr/local/bin/claude",
  env: { HOME: "/Users/someone" },
  run: async (file, args, input, options) => {
    calls.push({ file, args, input, cwd: options.cwd });
    return answer;
  },
});

const exited = (stdout: string, status = 0, stderr = ""): ClaudeRun => ({
  status,
  stdout,
  stderr,
  ended: "exit",
});

describe("parseCloudSessionId", () => {
  test.each([
    { name: "a bare session id", text: "session_01NfjPqrX1AK5RmKyV182VYD" },
    {
      name: "a page URL with its query",
      text: "https://claude.ai/code/session_01NfjPqrX1AK5RmKyV182VYD?from=cli&m=0",
    },
    {
      name: "a URL without the scheme",
      text: "claude.ai/code/session_01NfjPqrX1AK5RmKyV182VYD",
    },
    {
      name: "surrounding spaces",
      text: "  session_01NfjPqrX1AK5RmKyV182VYD\n",
    },
  ])("reads $name", ({ text }) => {
    expect(parseCloudSessionId(text)).toBe("session_01NfjPqrX1AK5RmKyV182VYD");
  });

  test.each([
    { name: "a local session id", text: COPY },
    {
      name: "another site",
      text: "https://example.com/code/session_01NfjPqrX1AK5RmKy",
    },
    { name: "an id with a shell character", text: "session_01Nfj;rm" },
    { name: "an empty text", text: "" },
  ])("refuses $name", ({ text }) => {
    expect(parseCloudSessionId(text)).toBeNull();
  });
});

describe("claudeCliFile", () => {
  test("prefers HARNEXUS_CLAUDE_CLI, then the SDK's claude, then claude on the PATH", () => {
    expect(
      claudeCliFile(
        { HARNEXUS_CLAUDE_CLI: "/opt/claude" },
        () => "/sdk/claude",
      ),
    ).toBe("/opt/claude");
    expect(claudeCliFile({}, () => "/sdk/claude")).toBe("/sdk/claude");
    expect(claudeCliFile({}, () => null)).toBe("claude");
  });

  test("finds the SDK's claude for this platform", () => {
    const found = bundledClaude();

    expect(found).toEndWith(
      `/claude-agent-sdk-${process.platform}-${process.arch}/claude`,
    );
  });
});

describe("sendToCloud", () => {
  test("passes the message on stdin and reports a queued message as sent", async () => {
    const calls: Call[] = [];
    const cli = cliAnswering(
      Result.ok(
        exited(
          JSON.stringify({
            ok: true,
            session_id: "session_01Nfj",
            url: "https://claude.ai/code/session_01Nfj",
          }),
        ),
      ),
      calls,
    );

    const sent = await sendToCloud(
      cli,
      "session_01Nfj",
      "fix the test",
      "/tmp/w",
    );

    expect(sent).toEqual({ kind: "sent" });
    expect(calls).toEqual([
      {
        file: "/usr/local/bin/claude",
        args: ["-p", "--cloud", "session_01Nfj", "--output-format", "json"],
        input: "fix the test",
        cwd: "/tmp/w",
      },
    ]);
  });

  test.each([
    {
      name: "a failed send the CLI reports",
      run: Result.ok(
        exited(
          JSON.stringify({
            ok: false,
            session_id: "session_01Nfj",
            error:
              "cloud session session_01Nfj is archived and cannot accept new messages",
          }),
          1,
        ),
      ),
      message:
        "cloud session session_01Nfj is archived and cannot accept new messages",
    },
    {
      name: "a configuration error printed to stderr",
      run: Result.ok(
        exited(
          "",
          1,
          "Error: Cloud sessions are disabled by your organization's policy.\n",
        ),
      ),
      message: "Cloud sessions are disabled by your organization's policy.",
    },
    {
      name: "a CLI that never started",
      run: Result.err(
        new ClaudeRunFailed({ started: false, message: "spawn claude ENOENT" }),
      ),
      message: "spawn claude ENOENT",
    },
  ])("reports $name as rejected", async ({ run, message }) => {
    const sent = await sendToCloud(
      cliAnswering(run),
      "session_01Nfj",
      "hi",
      "/",
    );

    expect(sent).toEqual({ kind: "rejected", message });
  });

  test.each([
    {
      name: "a timeout",
      run: Result.ok<ClaudeRun, ClaudeRunFailed>({
        status: 143,
        stdout: "",
        stderr: "",
        ended: "timeout",
      }),
    },
    {
      name: "a process lost after it started",
      run: Result.err<ClaudeRun, ClaudeRunFailed>(
        new ClaudeRunFailed({ started: true, message: "pid 9 did not exit" }),
      ),
    },
    { name: "an exit without a result", run: Result.ok(exited("Sent.\n")) },
  ])("reports $name as unknown", async ({ run }) => {
    const sent = await sendToCloud(
      cliAnswering(run),
      "session_01Nfj",
      "hi",
      "/",
    );

    expect(sent.kind).toBe("unknown");
  });
});

describe("copyCloudSession", () => {
  const roots: string[] = [];
  afterEach(async () => {
    for (const root of roots.splice(0)) {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("teleports with the /cost prompt in its own folder and returns the stable copy", async () => {
    const copier = await copying([{ answer: COPIED }]);

    const copied = await copier.copy();

    expect(copied.unwrap()).toBe(COPY);
    expect(copier.calls).toEqual([
      {
        file: "/usr/local/bin/claude",
        args: [
          "--teleport",
          "session_01Nfj",
          "-p",
          "/cost",
          "--output-format",
          "json",
          "--debug-file",
          expect.stringMatching(
            new RegExp(`^${copier.cwd}/logs/[0-9a-f-]{36}\\.log$`),
          ),
        ],
        input: "",
        cwd: copier.cwd,
      },
    ]);
    expect(await readFile(copier.record, "utf8")).not.toContain(
      "aaaaaaaa-0000-4000-8000-000000000001",
    );
  });

  test("copies a session made in a repository from the checkout its refusal names, and goes there first next time", async () => {
    const copier = await copying([
      { refusal: NOT_IN_REPO, status: 1 },
      { answer: COPIED },
      { answer: COPIED },
    ]);

    const first = await copier.copy();
    const second = await copier.copy();

    expect(first.unwrap()).toBe(COPY);
    expect(second.unwrap()).toBe(COPY);
    const checkout = join(copier.root, "checkouts", "riii111", "harnexus", "0");
    expect(copier.calls.map((call) => call.cwd)).toEqual([
      copier.cwd,
      checkout,
      checkout,
    ]);
    expect(await originOf(checkout)).toBe(
      "https://github.com/riii111/harnexus",
    );
  });

  test("removes teleport's debug log once it is read", async () => {
    const copier = await copying([{ refusal: NOT_IN_REPO, status: 1 }, {}]);

    await copier.copy();

    expect(await readdir(join(copier.cwd, "logs"))).toEqual([]);
  });

  test.each([
    {
      name: "a refusal outside a repository",
      plays: [
        { refusal: '"Teleport in print mode failed: Session not found"' },
      ],
      message: "Session not found",
    },
    {
      name: "a refusal from the checkout as well",
      plays: [
        { refusal: NOT_IN_REPO, status: 1 },
        {
          refusal:
            '"Teleport in print mode failed: Git working directory is not clean.\\nCommit or stash your changes."',
          status: 1,
        },
      ],
      message:
        "Git working directory is not clean. Commit or stash your changes.",
    },
  ])("fails with the reason teleport logged on $name", async ({
    plays,
    message,
  }) => {
    const copier = await copying(plays);

    const copied = await copier.copy();

    expect(copied.isErr() && copied.error.message).toBe(message);
    expect(copier.calls).toHaveLength(plays.length);
  });

  test.each([
    { name: "ran a model turn", turns: 1, stopped: "ran_model" },
    {
      name: "did not report its turns",
      turns: undefined,
      stopped: "unchecked",
    },
  ])("removes a copy that $name and says copies must stop", async ({
    turns,
    stopped,
  }) => {
    const copier = await copying([
      { answer: { is_error: false, num_turns: turns, session_id: COPY } },
    ]);

    const copied = await copier.copy();

    expect(copied.isErr() && copied.error.stopped).toBe(stopped);
    expect(await exists(copier.record)).toBe(false);
  });

  test.each([
    {
      name: "a result marked as an error",
      play: {
        answer: {
          is_error: true,
          result: "Remote Control session expired",
          session_id: COPY,
        },
      },
      message: "Remote Control session expired",
    },
    {
      name: "a result without a usable session id",
      play: { answer: { is_error: false, num_turns: 0, session_id: "x" } },
      message: "claude --teleport answered without a copy",
    },
    {
      name: "a copy that was never written",
      play: { answer: COPIED, writes: false },
      message: "the copy of the Cloud session was not found",
    },
  ])("fails on $name without stopping copies", async ({ play, message }) => {
    const copier = await copying([play]);

    const copied = await copier.copy();

    expect(copied.isErr() && copied.error.message).toBe(message);
    expect(copied.isErr() && copied.error.stopped).toBeNull();
  });

  // Each call plays the next answer: a refusal goes to the debug log as teleport writes it, and a copy is written under the config folder unless told otherwise.
  const copying = async (plays: readonly Play[]) => {
    const root = await mkdtemp(join(tmpdir(), "harnexus-copy-"));
    roots.push(root);
    const configDir = join(root, "config");
    const record = join(configDir, "projects", "-copies", `${COPY}.jsonl`);
    const calls: Call[] = [];
    const cli: CloudCli = {
      file: "/usr/local/bin/claude",
      env: {},
      run: async (file, args, input, options) => {
        calls.push({ file, args, input, cwd: options.cwd });
        const play = plays[calls.length - 1] ?? {};
        const log = args[args.indexOf("--debug-file") + 1] ?? "";
        await writeFile(
          log,
          `2026-10-30T07:00:00.000Z [DEBUG] Session is for repository\n${play.refusal === undefined ? "" : `2026-10-30T07:00:00.001Z [ERROR] ${play.refusal}\n`}`,
        );
        if (play.answer !== undefined && play.writes !== false) {
          await mkdir(join(configDir, "projects", "-copies"), {
            recursive: true,
          });
          await writeFile(
            record,
            `${JSON.stringify({ type: "user", uuid: "aaaaaaaa-0000-4000-8000-000000000001", timestamp: "2026-10-30T07:00:00.000Z", message: { role: "user", content: "hi" } })}\n`,
          );
        }
        const stdout =
          play.answer === undefined
            ? ""
            : typeof play.answer === "string"
              ? play.answer
              : JSON.stringify(play.answer);
        return Result.ok(exited(stdout, play.status ?? 0));
      },
    };
    const cwd = join(root, "copies");
    const checkouts = createCloudCheckouts(
      join(root, "checkouts"),
      process.env,
    );
    const copy = () =>
      copyCloudSession(cli, "session_01Nfj", { cwd, checkouts, configDir });
    return { copy, calls, cwd, record, root };
  };

  const exists = (path: string) =>
    readFile(path).then(
      () => true,
      () => false,
    );
});

describe("stabilizeCopy", () => {
  const folders: string[] = [];
  afterEach(async () => {
    for (const folder of folders.splice(0)) {
      await rm(folder, { recursive: true, force: true });
    }
  });

  const COPIED_AT = Date.parse("2026-10-30T08:00:00.000Z");

  // Two teleports of one session, as Claude Code writes them: the same records under new uuids, then the records teleport adds when it runs.
  const writeCopy = async (
    configDir: string,
    copy: string,
    ids: string[],
    ranAt: string | null = null,
  ) => {
    const [prompt, answer, again, note, command] = ids;
    const own =
      ranAt === null
        ? []
        : [
            {
              type: "user",
              uuid: note,
              parentUuid: again,
              timestamp: ranAt,
              sessionId: copy,
              isMeta: true,
              message: {
                role: "user",
                content:
                  "This session is being continued from another machine.",
              },
            },
            {
              type: "user",
              uuid: command,
              parentUuid: note,
              timestamp: ranAt,
              sessionId: copy,
              message: {
                role: "user",
                content: "<command-name>/usage</command-name>",
              },
            },
          ];
    const lines = [
      {
        type: "user",
        uuid: prompt,
        parentUuid: null,
        timestamp: "2026-10-30T07:00:00.000Z",
        sessionId: copy,
        message: { role: "user", content: "1+2?" },
      },
      {
        type: "assistant",
        uuid: answer,
        parentUuid: prompt,
        timestamp: "2026-10-30T07:00:01.000Z",
        sessionId: copy,
        message: { role: "assistant", content: [{ type: "text", text: "3" }] },
      },
      {
        type: "assistant",
        uuid: again,
        parentUuid: answer,
        timestamp: "2026-10-30T07:00:01.000Z",
        sessionId: copy,
        message: { role: "assistant", content: [{ type: "text", text: "3" }] },
      },
      ...own,
      {
        type: "last-prompt",
        leafUuid: own.at(-1)?.uuid ?? again,
        sessionId: copy,
      },
    ];
    const folder = join(configDir, "projects", "-state-cloud-copies");
    await mkdir(folder, { recursive: true });
    const path = join(folder, `${copy}.jsonl`);
    await writeFile(
      path,
      `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`,
    );
    return path;
  };

  const read = async (path: string) =>
    (await readFile(path, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));

  test("gives the records of every copy the same uuids and keeps their links", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "harnexus-copy-"));
    folders.push(configDir);
    const first = await writeCopy(
      configDir,
      "11111111-1111-4111-8111-111111111111",
      [
        "aaaaaaaa-0000-4000-8000-000000000001",
        "aaaaaaaa-0000-4000-8000-000000000002",
        "aaaaaaaa-0000-4000-8000-000000000003",
      ],
    );
    const second = await writeCopy(
      configDir,
      "22222222-2222-4222-8222-222222222222",
      [
        "bbbbbbbb-0000-4000-8000-000000000001",
        "bbbbbbbb-0000-4000-8000-000000000002",
        "bbbbbbbb-0000-4000-8000-000000000003",
      ],
    );

    const stabilized = await Promise.all([
      stabilizeCopy(
        "11111111-1111-4111-8111-111111111111",
        COPIED_AT,
        configDir,
      ),
      stabilizeCopy(
        "22222222-2222-4222-8222-222222222222",
        COPIED_AT,
        configDir,
      ),
    ]);
    const [a, b] = [await read(first), await read(second)];

    expect(stabilized.every((result) => result.isOk())).toBe(true);
    expect(a.map((line) => line.uuid)).toEqual(b.map((line) => line.uuid));
    expect(a[0].uuid).not.toBe("aaaaaaaa-0000-4000-8000-000000000001");
    expect(a[1].parentUuid).toBe(a[0].uuid);
    expect(a[2].uuid).not.toBe(a[1].uuid);
    expect(a[3].leafUuid).toBe(a[2].uuid);
    expect(a[0].sessionId).toBe("11111111-1111-4111-8111-111111111111");
  });

  test("leaves out the records teleport writes when it runs, so every copy ends with the same record", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "harnexus-copy-"));
    folders.push(configDir);
    const ids = (prefix: string) =>
      [1, 2, 3, 4, 5].map((n) => `${prefix}-0000-4000-8000-00000000000${n}`);
    const first = await writeCopy(
      configDir,
      "11111111-1111-4111-8111-111111111111",
      ids("aaaaaaaa"),
      "2026-10-30T08:00:02.000Z",
    );
    const second = await writeCopy(
      configDir,
      "22222222-2222-4222-8222-222222222222",
      ids("bbbbbbbb"),
      "2026-10-30T08:05:02.000Z",
    );

    await stabilizeCopy(
      "11111111-1111-4111-8111-111111111111",
      COPIED_AT,
      configDir,
    );
    await stabilizeCopy(
      "22222222-2222-4222-8222-222222222222",
      COPIED_AT + 5 * 60_000,
      configDir,
    );
    const [a, b] = [await read(first), await read(second)];

    expect(a.map((line) => line.uuid)).toEqual(b.map((line) => line.uuid));
    expect(a.map((line) => line.type)).toEqual([
      "user",
      "assistant",
      "assistant",
      "last-prompt",
    ]);
  });

  test("fails when the copy cannot be found", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "harnexus-copy-"));
    folders.push(configDir);

    const stabilized = await stabilizeCopy(
      "33333333-3333-4333-8333-333333333333",
      COPIED_AT,
      configDir,
    );

    expect(stabilized.isErr()).toBe(true);
  });
});

type Play = {
  refusal?: string;
  answer?: object | string;
  status?: number;
  writes?: boolean;
};

const COPIED = {
  type: "result",
  is_error: false,
  num_turns: 0,
  session_id: COPY,
};

const NOT_IN_REPO =
  "Teleport in print mode failed: You must run claude --teleport session_01Nfj from a checkout of riii111/harnexus.";

const originOf = async (dir: string) =>
  (
    await runCommand(
      "git",
      ["-C", dir, "config", "--get", "remote.origin.url"],
      process.env,
    )
  )
    .unwrap()
    .stdout.trim();
