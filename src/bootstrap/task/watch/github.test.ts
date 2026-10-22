import { describe, expect, test } from "bun:test";
import { Result } from "better-result";
import { createGitHub } from "./github.ts";

const PR = "https://github.com/org/pay/pull/7";

const fake = (data: unknown, status = 200) => {
  const posts: { token: string; variables: Record<string, unknown> }[] = [];
  const commands: string[][] = [];
  const github = createGitHub(
    async (argv) => {
      commands.push([...argv]);
      return Result.ok({ status: 0, stdout: "secret-token\n", stderr: "" });
    },
    {},
    async (token, _query, variables) => {
      posts.push({ token, variables });
      return Result.ok({ status, text: JSON.stringify(data) });
    },
  );
  return { github, posts, commands };
};

const commit = {
  oid: "a".repeat(40),
  status: {
    context: {
      state: "SUCCESS",
      description: "Review completed",
      createdAt: "2026-10-23T00:00:00Z",
    },
  },
  statusCheckRollup: { state: "FAILURE" },
};

const pull = {
  url: PR,
  title: "Pay",
  state: "OPEN",
  isDraft: false,
  headRefOid: "a".repeat(40),
  updatedAt: "2026-10-23T00:00:00Z",
  mergeable: "MERGEABLE",
  commits: { nodes: [{ commit }] },
  checks: {
    nodes: [
      {
        commit: {
          statusCheckRollup: {
            contexts: {
              nodes: [
                {
                  __typename: "CheckRun",
                  name: "build",
                  conclusion: "FAILURE",
                  detailsUrl: "https://ci.example/1",
                  isRequired: true,
                },
                {
                  __typename: "CheckRun",
                  name: "label",
                  conclusion: "FAILURE",
                  isRequired: false,
                },
                {
                  __typename: "CheckRun",
                  name: "superseded",
                  conclusion: "CANCELLED",
                  isRequired: true,
                },
                {
                  __typename: "StatusContext",
                  context: "deploy",
                  state: "ERROR",
                  targetUrl: null,
                  isRequired: true,
                },
              ],
            },
          },
        },
      },
    ],
  },
  reviewThreads: {
    nodes: [
      {
        isResolved: true,
        comments: {
          nodes: [
            {
              databaseId: 11,
              url: `${PR}#discussion_r11`,
              createdAt: "2026-10-23T00:00:00Z",
              body: "**🟠 Major**",
              path: "a.kt",
              line: null,
              originalLine: 4,
              author: { __typename: "Bot", login: "coderabbitai" },
              replyTo: null,
            },
            {
              databaseId: 12,
              url: `${PR}#discussion_r12`,
              createdAt: "2026-10-23T00:01:00Z",
              body: "thanks",
              path: "a.kt",
              line: 4,
              author: { __typename: "User", login: "owner" },
              replyTo: { databaseId: 11 },
            },
          ],
        },
      },
    ],
  },
  reviews: {
    nodes: [
      {
        databaseId: 21,
        url: `${PR}#pullrequestreview-21`,
        createdAt: "2026-10-23T00:00:00Z",
        body: "",
        author: null,
      },
    ],
  },
  comments: {
    nodes: [
      {
        databaseId: 31,
        url: `${PR}#issuecomment-31`,
        createdAt: "2026-10-23T00:00:00Z",
        body: "No actionable comments were generated in the recent review. 🎉",
        author: { __typename: "Bot", login: "coderabbitai" },
      },
    ],
  },
};

describe("createGitHub", () => {
  test("reads a PR's detail with the account's token and names apps as GitHub shows them", async () => {
    const { github, posts, commands } = fake({
      data: { repository: { pullRequest: pull } },
    });

    const detail = (
      await github.detail("owner", { repo: "org/pay", number: 7 })
    ).unwrap();

    expect(commands).toEqual([
      ["gh", "auth", "token", "--hostname", "github.com", "--user", "owner"],
    ]);
    expect(posts.map((post) => [post.token, post.variables])).toEqual([
      ["secret-token", { owner: "org", name: "pay", number: 7 }],
    ]);
    expect(
      detail.comments.map((comment) => [
        comment.id,
        comment.author,
        comment.line,
        comment.reply,
        comment.resolved,
      ]),
    ).toEqual([
      ["inline:11", "coderabbitai[bot]", 4, false, true],
      ["inline:12", "owner", 4, true, true],
      ["review:21", "ghost", null, false, false],
      ["issue:31", "coderabbitai[bot]", null, false, false],
    ]);
    expect(detail.failedRequired).toEqual([
      { name: "build", url: "https://ci.example/1" },
      { name: "deploy", url: null },
    ]);
    expect([
      detail.coderabbit?.description,
      detail.noActionableSummary,
    ]).toEqual(["Review completed", true]);
  });

  test("reads every PR of an account in one aliased query", async () => {
    const { github, posts } = fake({
      data: {
        p0: { pullRequest: pull },
        p1: { pullRequest: null },
      },
    });

    const summaries = (
      await github.summaries("owner", [
        { repo: "org/pay", number: 7 },
        { repo: "org/gone", number: 8 },
      ])
    ).unwrap();

    expect(posts).toHaveLength(1);
    expect(posts[0]?.variables).toEqual({
      o0: "org",
      r0: "pay",
      n0: 7,
      o1: "org",
      r1: "gone",
      n1: 8,
    });
    expect(summaries[0]?.rollup).toBe("FAILURE");
    expect(summaries[1]).toBeNull();
  });

  test("reports GitHub's errors without the token", async () => {
    const { github } = fake(
      { errors: [{ message: "Could not resolve to a Repository" }] },
      200,
    );

    const failed = await github.detail("owner", { repo: "org/pay", number: 7 });

    expect(failed.isErr() && failed.error.message).toBe(
      "GitHub answered 200: Could not resolve to a Repository",
    );
    expect(JSON.stringify(failed)).not.toContain("secret-token");
  });
});
