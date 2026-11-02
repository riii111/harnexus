import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { readCheckoutHead, readInstalledPackage } from "./checkout.ts";

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "harnexus-checkout-"));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("readCheckoutHead", () => {
  test("reads the branch, its loose ref and when HEAD last moved without the reflog's name or email", async () => {
    const repo = await project("loose", {
      ".git/HEAD": "ref: refs/heads/main\n",
      ".git/refs/heads/main": `${COMMIT}\n`,
      ".git/logs/HEAD": `${ZERO} ${OLD} A <a@example.com> 1700000000 +0900\tclone\n${OLD} ${COMMIT} Someone <someone@example.com> 1792806195 +0900\tpull: Fast-forward\n`,
    });

    const head = await readCheckoutHead(repo);

    expect(head).toEqual({
      commit: COMMIT,
      branch: "main",
      movedAtMs: 1792806195000,
    });
  });

  test("finds a packed ref", async () => {
    const repo = await project("packed", {
      ".git/HEAD": "ref: refs/heads/feature/x\n",
      ".git/packed-refs": `# pack-refs with: peeled fully-peeled sorted\n${OLD} refs/heads/main\n${COMMIT} refs/heads/feature/x\n`,
    });

    const head = await readCheckoutHead(repo);

    expect(head).toEqual({
      commit: COMMIT,
      branch: "feature/x",
      movedAtMs: null,
    });
  });

  test("reads a detached HEAD", async () => {
    const repo = await project("detached", { ".git/HEAD": `${COMMIT}\n` });

    const head = await readCheckoutHead(repo);

    expect(head).toEqual({ commit: COMMIT, branch: null, movedAtMs: null });
  });

  test("follows a worktree's .git file to its directory and the shared refs", async () => {
    const repo = await project("worktree", {
      "main/.git/refs/heads/topic": `${COMMIT}\n`,
      "main/.git/worktrees/topic/HEAD": "ref: refs/heads/topic\n",
      "main/.git/worktrees/topic/commondir": "../..\n",
      "topic/.git": "gitdir: ../main/.git/worktrees/topic\n",
    });

    const head = await readCheckoutHead(join(repo, "topic"));

    expect(head?.commit).toBe(COMMIT);
    expect(head?.branch).toBe("topic");
  });

  test("is null without a .git", async () => {
    const repo = await project("none", { "package.json": "{}" });

    expect(await readCheckoutHead(repo)).toBeNull();
  });

  test("leaves the commit unknown when the ref is missing", async () => {
    const repo = await project("unborn", {
      ".git/HEAD": "ref: refs/heads/main\n",
    });

    expect((await readCheckoutHead(repo))?.commit).toBeNull();
  });
});

describe("readInstalledPackage", () => {
  test("reads the version and the Claude Code version the SDK ships", async () => {
    const repo = await project("sdk", {
      "node_modules/@anthropic-ai/claude-agent-sdk/package.json":
        JSON.stringify({ version: "0.3.304", claudeCodeVersion: "2.1.304" }),
    });

    const installed = await readInstalledPackage(
      repo,
      "@anthropic-ai/claude-agent-sdk",
    );

    expect(installed).toEqual({
      version: "0.3.304",
      claudeCodeVersion: "2.1.304",
    });
  });

  test("is unknown for a missing package or a value that is not a version", async () => {
    const repo = await project("odd", {
      "node_modules/odd/package.json": JSON.stringify({
        version: "see /Users/someone/notes",
      }),
    });

    expect(await readInstalledPackage(repo, "odd")).toEqual({
      version: null,
      claudeCodeVersion: null,
    });
    expect(await readInstalledPackage(repo, "missing")).toEqual({
      version: null,
      claudeCodeVersion: null,
    });
  });
});

const project = async (name: string, files: Record<string, string>) => {
  const root = join(dir, name);
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  return root;
};

const COMMIT = "9c5270ce375a80cfaa571119c3ee827b280dc778";
const OLD = "9c2460e1c25de4e3cef5e9d03e73997e87e4fc28";
const ZERO = "0".repeat(40);
