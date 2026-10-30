import { describe, expect, test } from "bun:test";
import { Result } from "better-result";
import {
  type CloudCli,
  copyCloudSession,
  parseCloudSessionId,
  sendToCloud,
} from "./cloud.ts";
import { type ClaudeRun, ClaudeRunFailed } from "./run.boundary.ts";

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
  test("teleports with the /cost prompt in the given folder and returns the copy", async () => {
    const calls: Call[] = [];
    const cli = cliAnswering(
      Result.ok(
        exited(
          JSON.stringify({
            type: "result",
            subtype: "success",
            is_error: false,
            num_turns: 0,
            total_cost_usd: 0,
            session_id: COPY,
          }),
        ),
      ),
      calls,
    );

    const copied = await copyCloudSession(cli, "session_01Nfj", "/state/cloud");

    expect(copied.unwrap()).toEqual({ sessionId: COPY, turns: 0 });
    expect(calls).toEqual([
      {
        file: "/usr/local/bin/claude",
        args: [
          "--teleport",
          "session_01Nfj",
          "-p",
          "/cost",
          "--output-format",
          "json",
        ],
        input: "",
        cwd: "/state/cloud",
      },
    ]);
  });

  test("reports the turns a copy ran, so a model call can be noticed", async () => {
    const cli = cliAnswering(
      Result.ok(
        exited(
          JSON.stringify({ is_error: false, num_turns: 1, session_id: COPY }),
        ),
      ),
    );

    const copied = await copyCloudSession(cli, "session_01Nfj", "/");

    expect(copied.unwrap().turns).toBe(1);
  });

  test.each([
    {
      name: "an error printed by the CLI",
      run: Result.ok(
        exited("", 1, "Error: Session not found: session_01Nfj\n"),
      ),
      message: "Session not found: session_01Nfj",
    },
    {
      name: "a result marked as an error",
      run: Result.ok(
        exited(
          JSON.stringify({
            is_error: true,
            result: "Remote Control session expired",
            session_id: COPY,
          }),
        ),
      ),
      message: "Remote Control session expired",
    },
    {
      name: "a result without a usable session id",
      run: Result.ok(
        exited(JSON.stringify({ is_error: false, session_id: "x" })),
      ),
      message: "claude --teleport answered without a copy",
    },
  ])("fails on $name", async ({ run, message }) => {
    const copied = await copyCloudSession(
      cliAnswering(run),
      "session_01Nfj",
      "/",
    );

    expect(copied.isErr()).toBe(true);
    expect(copied.isErr() && copied.error.message).toBe(message);
  });
});
