import type { Result } from "better-result";

type ReadFile = (path: string) => Result<string, unknown>;

// The app sends a picked skill as a link to its SKILL.md, and Codex adds the file after the prompt; Claude turns never reach Codex, so the file is added here in the same shape.
// A file that cannot be read leaves only its link, which Claude may still follow.
export const withSkillBodies = (text: string, read: ReadFile) => {
  const blocks: string[] = [];
  const unreadable: string[] = [];
  for (const { name, path } of skillLinks(text)) {
    const body = read(path);
    if (body.isErr()) unreadable.push(path);
    else blocks.push(skillBlock(name, path, body.value));
  }
  return { text: [text, ...blocks].join("\n\n"), unreadable };
};

// Claude's record keeps the prompt with the added files, which the reopened thread shows without them as the user typed it.
export const withoutSkillBodies = (text: string) => {
  const starts = skillLinks(text)
    .map(({ name, path }) => text.indexOf(`\n\n${blockHead(name, path)}`))
    .filter((index) => index !== -1);
  return starts.length === 0 ? text : text.slice(0, Math.min(...starts));
};

// A skill picked twice is added once.
const skillLinks = (text: string) => {
  const seen = new Set<string>();
  const links: { name: string; path: string }[] = [];
  for (const [, name, path] of text.matchAll(SKILL_LINK)) {
    if (name === undefined || path === undefined || seen.has(path)) continue;
    seen.add(path);
    links.push({ name, path });
  }
  return links;
};

const skillBlock = (name: string, path: string, body: string) =>
  `${blockHead(name, path)}${body.replace(/\n$/, "")}\n</skill>`;

const blockHead = (name: string, path: string) =>
  `<skill>\n<name>${name}</name>\n<path>${path}</path>\n`;

const SKILL_LINK = /\[\$([^\]\s]+)\]\((\/[^)\s]*\/SKILL\.md)\)/g;
