import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { taskPrompt } from "./templates.ts";

type TemplateKind = Parameters<typeof taskPrompt>[1];

const SKILLS = join(import.meta.dir, "../../test/fixtures/task-skills");

const WORKER_FIELDS = {
  task_id: "TR1",
  document_refs: "- /docs/agreement.md",
  completion_target: "draft_pr",
};

const REVIEWER_FIELDS = {
  task_id: "TR1",
  document_refs: "- /docs/agreement.md",
  worker_ai: "Codex",
  reply_to: "Codex",
  worker_chat_id: "worker",
  checkout: "/checkout",
  pr_url: "null",
  base: "1".repeat(40),
  head: "2".repeat(40),
};

const cleanups: (() => Promise<unknown>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("taskPrompt", () => {
  test("links the reviewer prompt to the files beside its template", async () => {
    const { configure, prompt } = await fixture();
    await configure({
      templates: {
        reviewer: join(SKILLS, "task-review-cycle/references/reviewer.md"),
      },
    });
    const real = (path: string) => realpath(join(SKILLS, path));

    const filled = await prompt("reviewer", REVIEWER_FIELDS);

    expect(filled.isOk()).toBe(true);
    const text = filled.isOk() ? filled.value : "";
    expect(text).toContain(
      `[$ai-code-review](${await real("ai-code-review/SKILL.md")})`,
    );
    expect(text).toContain(
      `(${await real("task-review-cycle/SKILL.md")}#レビュー時の確認事項)`,
    );
    expect(text).toContain(
      `[返却方法](${await real("task-review-cycle/references/reply-Codex.md")})`,
    );
  });

  test("fills a template of its own without resolving links in the values", async () => {
    const { root, useWorker, prompt } = await fixture();
    const linked = join(root, "linked.md");
    const document = join(root, "a](linked.md)");
    const escaped = join(root, "{task_id}.md");
    await writeFile(linked, "");
    await writeFile(escaped, "");
    await writeFile(document, "");
    const template = join(root, "templates/worker.md");
    await mkdir(dirname(template));
    await writeFile(
      template,
      "{{task_id}} is {task_id}\n{document_refs}\n" +
        "[guide](https://example.com/guide) [local](/nowhere.md) [top](#top) [linked](../linked.md) [escaped](../{{task_id}}.md)\n" +
        "[ref][r]\n\n[r]: ../linked.md\n[注意]: 先に読むこと\n",
    );
    await useWorker(template);

    const filled = await prompt("worker", {
      ...WORKER_FIELDS,
      task_id: "manual/TR1",
      document_refs: `- ${document}`,
    });

    expect(filled.isOk() && filled.value).toBe(
      `{task_id} is manual/TR1\n- ${document}\n` +
        `[guide](https://example.com/guide) [local](/nowhere.md) [top](#top) [linked](${linked}) [escaped](${escaped})\n` +
        "[ref][r]\n\n[r]: ../linked.md\n[注意]: 先に読むこと\n",
    );
  });

  test("leaves links in code as examples and resolves the link after them", async () => {
    const { root, useWorker, prompt } = await fixture();
    const linked = join(root, "linked.md");
    await writeFile(linked, "");
    const template = join(root, "worker.md");
    const examples =
      "Cite as `[file](path/to/file.ts)` or ``[a](b`c.md)``.\n" +
      "```md\n[x](missing.md)\n```\n" +
      "~~~\n[y](gone.md)\n```\nstill code [z](none.md)\n~~~\n" +
      "1. Output format:\n\n    ~~~md\n    [file](path/to/file.ts)\n    ~~~\n\n" +
      "> ```\n> [q](quoted.md)\n> ```\n\n";
    await writeFile(
      template,
      `${examples}<!--\n- [old](gone.md)\n\n# Old\n[x](gone.md)\n-->\nWrite \`[text](\` then <rules>\n[$s](linked.md)\n</rules>\n\n    ![i](linked.md)\n`,
    );
    await useWorker(template);

    const filled = await prompt("worker");

    expect(filled.isOk() && filled.value).toBe(
      `${examples}<!--\n- [old](gone.md)\n\n# Old\n[x](gone.md)\n-->\nWrite \`[text](\` then <rules>\n[$s](${linked})\n</rules>\n\n    ![i](${linked})\n`,
    );
  });

  test.each([
    { name: "a code span", text: "`[a](b.md)` then [c](missing.md)\n" },
    {
      name: "a lone backtick a CRLF blank line before another",
      text: "Type a ` to start.\r\n\r\n[c](missing.md)\r\n\r\nThen `x`.\r\n",
    },
    {
      name: "a lone backtick a heading before another",
      text: "Type a backtick: `\n# Instructions\n[c](missing.md)\nUse `x`.\n",
    },
    {
      name: "an escaped backtick",
      text: "Write \\` then [c](missing.md) and `x`.\n",
    },
  ])("refuses a missing link after $name", async ({ text }) => {
    const { root, useWorker, prompt } = await fixture();
    const template = join(root, "worker.md");
    await writeFile(template, text);
    await useWorker(template);

    const refused = await prompt("worker");

    expect(refused.isErr() && refused.error.message).toContain(
      `the worker template ${template}: links to ${join(root, "missing.md")}, which is not a file`,
    );
  });

  test("fills anchors and field-led targets, and resolves beside a symlinked template's real file", async () => {
    const { root, useWorker, prompt } = await fixture();
    const source = join(root, "source");
    await mkdir(join(source, "notes"), { recursive: true });
    await writeFile(join(source, "notes/task.md"), "");
    await writeFile(
      join(source, "worker.md"),
      "[note](notes/task.md#{task_id}) [id]({task_id})\n",
    );
    await mkdir(join(root, "linked"));
    const template = join(root, "linked/worker.md");
    await symlink(join(source, "worker.md"), template);
    await useWorker(template);

    const filled = await prompt("worker", {
      ...WORKER_FIELDS,
      task_id: "TR-42",
    });

    expect(filled.isOk() && filled.value).toBe(
      `[note](${join(source, "notes/task.md")}#TR-42) [id](TR-42)\n`,
    );
  });

  test.each([
    {
      name: "a real path with a space",
      link: "[$s](spaced/SKILL.md)",
      taskId: "TR1",
      error: "whose path has a space, parenthesis, # or backslash",
    },
    {
      name: "a real path with #",
      link: "[$s](hashed/SKILL.md)",
      taskId: "TR1",
      error: "whose path has a space, parenthesis, # or backslash",
    },
    {
      name: "a target with a title",
      link: '[n](notes/task.md "notes")',
      taskId: "TR1",
      error: "without angle brackets, spaces or a title",
    },
    {
      name: "a target opening with escaped braces",
      link: "[n]({{task_id}}/task.md)",
      taskId: "TR1",
      error: "which is not a file",
    },
    {
      name: "a target opening with a full-width space",
      link: "[n](\u3000notes/task.md)",
      taskId: "TR1",
      error: "without angle brackets, spaces or a title",
    },
    {
      name: "a target in angle brackets",
      link: "[n](<notes/task.md>)",
      taskId: "TR1",
      error: "without angle brackets, spaces or a title",
    },
    {
      name: "a field holding a path",
      link: "[n](notes/{task_id}.md)",
      taskId: "x/../../task",
      error:
        "{task_id} may hold only letters, digits, _ and - inside a link target",
    },
    {
      name: "a field whose value would break the anchor",
      link: "[n](notes/task.md#{task_id})",
      taskId: "#42",
      error:
        "{task_id} may hold only letters, digits, _ and - inside a link target",
    },
    {
      name: "a field that is not a request value",
      link: "[n](notes/{constructor}.md)",
      taskId: "TR1",
      error: "unknown template field {constructor}",
    },
  ])("refuses a link to $name", async ({ link, taskId, error }) => {
    const { root, useWorker, prompt } = await fixture();
    await mkdir(join(root, "notes"));
    await writeFile(join(root, "notes/task.md"), "");
    await mkdir(join(root, "My Skills"));
    await writeFile(join(root, "My Skills/SKILL.md"), "");
    await symlink(join(root, "My Skills"), join(root, "spaced"));
    await mkdir(join(root, "c#"));
    await writeFile(join(root, "c#/SKILL.md"), "");
    await symlink(join(root, "c#"), join(root, "hashed"));
    const template = join(root, "worker.md");
    await writeFile(template, `${link}\n`);
    await useWorker(template);

    const refused = await prompt("worker", {
      ...WORKER_FIELDS,
      task_id: taskId,
    });

    expect(refused.isErr() && refused.error.message).toContain(error);
  });

  test.each([
    {
      name: "a missing config",
      config: undefined,
      error: "harnexus/task.json does not exist; set templates.worker",
    },
    {
      name: "a config without the worker template",
      config: { templates: { reviewer: "/reviewer.md" } },
      error: "templates.worker is not set in",
    },
    {
      name: "a relative template path",
      config: { templates: { worker: "worker.md" } },
      error: "must be absolute",
    },
    {
      name: "an unknown config field",
      config: { templates: {}, prompts: {} },
      error: "is invalid",
    },
    {
      name: "a missing template",
      config: { templates: { worker: "/nonexistent/worker.md" } },
      error:
        "the worker template /nonexistent/worker.md: cannot read /nonexistent/worker.md",
    },
  ])("refuses $name", async ({ config, error }) => {
    const { configure, prompt } = await fixture();
    await configure(config);

    const refused = await prompt("worker");

    expect(refused.isErr() && refused.error.message).toContain(error);
  });
});

const fixture = async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "harnexus-templates-")),
  );
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "config");
  const env = { HOME: root, XDG_CONFIG_HOME: home };
  const configure = async (config: unknown) => {
    if (config === undefined) return;
    await mkdir(join(home, "harnexus"), { recursive: true });
    await writeFile(join(home, "harnexus/task.json"), JSON.stringify(config));
  };
  const useWorker = (template: string) =>
    configure({ templates: { worker: template } });
  const prompt = (
    kind: TemplateKind,
    fields: Record<string, string> = WORKER_FIELDS,
  ) => taskPrompt(env, kind, fields);
  return { root, configure, useWorker, prompt };
};
