import { describe, expect, test } from "bun:test";
import { turnDiff } from "./turn-diff.ts";

const UPDATE = { type: "update" as const, move_path: null };

describe("turnDiff", () => {
  test("names each file from the folder, with every change to it under one header", () => {
    expect(
      turnDiff(
        [
          {
            path: "/Users/me/src/app/src/a.ts",
            kind: UPDATE,
            diff: "@@ -1,1 +1,1 @@\n-old\n+new\n",
          },
          {
            path: "/Users/me/src/app/src/a.ts",
            kind: UPDATE,
            diff: "@@ -5,1 +5,1 @@\n-x\n+y\n",
          },
          {
            path: "/Users/me/src/app/b.md",
            kind: { type: "add" },
            diff: "one\ntwo\n",
          },
        ],
        "/Users/me/src/app",
      ),
    ).toBe(
      [
        "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n",
        "@@ -1,1 +1,1 @@\n-old\n+new\n@@ -5,1 +5,1 @@\n-x\n+y\n",
        "diff --git a/b.md b/b.md\nnew file mode 100644\n--- /dev/null\n+++ b/b.md\n",
        "@@ -0,0 +1,2 @@\n+one\n+two\n",
      ].join(""),
    );
  });

  test("names a Cloud session's file from the folder of the chat's name in its checkout", () => {
    expect(
      turnDiff(
        [
          {
            path: "/home/user/app/src/a.ts",
            kind: UPDATE,
            diff: "@@ -1,1 +1,1 @@\n-a\n+b\n",
          },
        ],
        "/Users/me/src/app",
      ),
    ).toStartWith("diff --git a/src/a.ts b/src/a.ts\n");
  });
});
