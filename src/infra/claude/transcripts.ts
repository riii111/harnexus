import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Result } from "better-result";
import {
  listDirectoryIfExists,
  readFileSlice,
  statFileIfExists,
} from "../../runtime/fs.boundary.ts";
import { parseJson } from "../../runtime/json.boundary.ts";
import { isObject } from "../../runtime/object.ts";

// title is the name Claude or the user gave the conversation, else its first prompt; entrypoint is the program that started it, such as cli or claude-desktop.
export type ClaudeConversation = {
  sessionId: string;
  title: string;
  updatedAtMs: number;
  entrypoint: string | null;
};

// Claude keeps a conversation as <session id>.jsonl in a folder named after the directory it ran in, whatever started it; a worktree has a folder of its own, so only conversations that ran in cwd itself are listed.
export const listClaudeConversations = (
  cwd: string,
  {
    since,
    configDir = claudeConfigDir(process.env),
  }: { since: number; configDir?: string },
) =>
  Result.gen(async function* () {
    const projectsDir = join(configDir, "projects");
    const projects = yield* Result.await(listDirectoryIfExists(projectsDir));
    const found: ClaudeConversation[] = [];
    for (const project of (projects ?? []).filter(isFolderOf(cwd))) {
      const folder = join(projectsDir, project);
      const files = yield* Result.await(listDirectoryIfExists(folder));
      for (const file of files ?? []) {
        const sessionId = sessionIdOf(file);
        if (sessionId === null) continue;
        const read = await readConversation(join(folder, file), sessionId, {
          cwd,
          since,
        });
        if (read !== null) found.push(read);
      }
    }
    return Result.ok(found.sort((a, b) => b.updatedAtMs - a.updatedAtMs));
  });

// Records are appended, so the last main-conversation record is read from the end, widening the read until a whole record fits.
export const readLastRecordUuid = (
  sessionId: string,
  configDir: string = claudeConfigDir(process.env),
) =>
  Result.gen(async function* () {
    const path = yield* Result.await(findSessionFile(sessionId, configDir));
    if (path === null) return Result.ok<string | null>(null);
    const file = yield* Result.await(statFileIfExists(path));
    if (file === null) return Result.ok<string | null>(null);
    for (let length = END_BYTES; ; length *= 2) {
      const start = Math.max(0, file.size - length);
      const tail = yield* Result.await(
        readFileSlice(path, start, file.size - start),
      );
      const records = wholeRecords(tail, {
        cutStart: start > 0,
        cutEnd: false,
      });
      const last = records.reverse().find(isMainRecord);
      if (last !== undefined) return Result.ok<string | null>(last.uuid);
      if (start === 0) return Result.ok<string | null>(null);
    }
  });

export const findSessionFile = (sessionId: string, configDir: string) =>
  Result.gen(async function* () {
    const projectsDir = join(configDir, "projects");
    const projects = yield* Result.await(listDirectoryIfExists(projectsDir));
    const fileName = `${sessionId}.jsonl`;
    for (const project of projects ?? []) {
      const files = yield* Result.await(
        listDirectoryIfExists(join(projectsDir, project)),
      );
      if (files?.includes(fileName)) {
        return Result.ok<string | null>(join(projectsDir, project, fileName));
      }
    }
    return Result.ok<string | null>(null);
  });

export const claudeConfigDir = (env: NodeJS.ProcessEnv) =>
  env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");

// Like Claude's own session list, only the head and the tail are read, so a long conversation costs no more than a short one; a record that cannot be read is left out rather than failing the list.
const readConversation = async (
  path: string,
  sessionId: string,
  { cwd, since }: { cwd: string; since: number },
): Promise<ClaudeConversation | null> => {
  const file = await statFileIfExists(path);
  if (file.isErr() || file.value === null) return null;
  const { size, modifiedMs } = file.value;
  if (modifiedMs < since) return null;
  const head = await readHead(path, size);
  const tailStart = Math.max(0, size - END_BYTES);
  const tail = await readFileSlice(path, tailStart, size - tailStart);
  if (head.isErr() || tail.isErr()) return null;
  const first = wholeRecords(head.value.text, {
    cutStart: false,
    cutEnd: head.value.length < size,
  });
  const last = wholeRecords(tail.value, {
    cutStart: tailStart > 0,
    cutEnd: false,
  });
  // A subagent's record is marked from its first line, which is how Claude's own session list leaves it out.
  if (first[0]?.isSidechain === true) return null;
  const ranIn = first.find((record) => typeof record.cwd === "string")?.cwd;
  if (typeof ranIn !== "string" || resolve(ranIn) !== resolve(cwd)) {
    return null;
  }
  const title =
    lastString([...first, ...last], "customTitle") ??
    lastString([...first, ...last], "aiTitle") ??
    firstPrompt(first);
  if (title === null) return null;
  const entrypoint = first.find(
    (record) => typeof record.entrypoint === "string",
  )?.entrypoint;
  return {
    sessionId,
    title,
    updatedAtMs: modifiedMs,
    entrypoint: typeof entrypoint === "string" ? entrypoint : null,
  };
};

// The first record holds the directory and often the first prompt, so the read widens until it is whole, however long a pasted prompt makes it.
const readHead = async (path: string, size: number) => {
  for (let length = Math.min(size, END_BYTES); ; length *= 2) {
    const read = Math.min(size, length);
    const text = await readFileSlice(path, 0, read);
    if (text.isErr() || read === size || text.value.includes("\n")) {
      return text.map((value) => ({ text: value, length: read }));
    }
  }
};

// Claude replaces every character other than a letter or digit with a hyphen and cuts a long name, adding a hash this does not reproduce, so a long name matches by its kept prefix and the record's own directory decides.
const isFolderOf = (cwd: string) => {
  const name = resolve(cwd).replace(/[^a-zA-Z0-9]/g, "-");
  return (folder: string) =>
    name.length <= FOLDER_NAME_LIMIT
      ? folder === name
      : folder.startsWith(`${name.slice(0, FOLDER_NAME_LIMIT)}-`);
};

// Older Claude Code versions wrote a subagent's record beside the conversation as agent-<id>.jsonl.
const sessionIdOf = (file: string) =>
  file.endsWith(".jsonl") && !file.startsWith("agent-") && file !== ".jsonl"
    ? file.slice(0, -".jsonl".length)
    : null;

const wholeRecords = (
  text: string,
  { cutStart, cutEnd }: { cutStart: boolean; cutEnd: boolean },
) => {
  const lines = text.split("\n");
  if (cutStart) lines.shift();
  if (cutEnd) lines.pop();
  return lines.flatMap((line) => {
    if (line.trim() === "") return [];
    const parsed = parseJson(line);
    return parsed.isOk() && isObject(parsed.value) ? [parsed.value] : [];
  });
};

const isMainRecord = (
  record: Record<string, unknown>,
): record is Record<string, unknown> & { uuid: string } =>
  (record.type === "user" || record.type === "assistant") &&
  record.isSidechain !== true &&
  typeof record.uuid === "string";

const lastString = (records: Record<string, unknown>[], key: string) => {
  const value = [...records]
    .reverse()
    .find((record) => typeof record[key] === "string" && record[key] !== "")?.[
    key
  ];
  return typeof value === "string" ? value : null;
};

// The first thing the user typed, skipping tool results, hidden records, compact summaries and the records a slash command leaves.
const firstPrompt = (records: Record<string, unknown>[]) => {
  for (const record of records) {
    if (record.type !== "user") continue;
    if (record.isMeta === true || record.isCompactSummary === true) continue;
    const body = record.message;
    if (!isObject(body)) continue;
    for (const text of promptTexts(body.content)) {
      const line = text.replace(/\s+/g, " ").trim();
      if (line !== "" && !NOT_TYPED.test(line)) return line;
    }
  }
  return null;
};

const promptTexts = (content: unknown): string[] => {
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];
  if (content.some((block) => isObject(block) && block.type === "tool_result"))
    return [];
  return content.flatMap((block) =>
    isObject(block) && block.type === "text" && typeof block.text === "string"
      ? [block.text]
      : [],
  );
};

// Large enough for the opening records and a title, as Claude's own session list reads.
const END_BYTES = 64 * 1024;

const FOLDER_NAME_LIMIT = 200;

const NOT_TYPED =
  /^(<command-name>|<command-message>|<local-command-|\[Request interrupted by user)/;
