// The app sends a picked skill as a link to its SKILL.md, and Codex adds the file after the prompt; Claude turns never reach Codex, so the bridge adds it in the same shape.
export const skillLinks = (text: string) => {
  const seen = new Set<string>();
  const links: { name: string; path: string }[] = [];
  for (const [, name, path] of text.matchAll(SKILL_LINK)) {
    if (name === undefined || path === undefined || seen.has(path)) continue;
    seen.add(path);
    links.push({ name, path });
  }
  return links;
};

export const skillBlock = (name: string, path: string, body: string) =>
  `<skill>\n<name>${name}</name>\n<path>${path}</path>\n${body.replace(/\n$/, "")}\n</skill>`;

const SKILL_LINK = /\[\$([^\]\s]+)\]\((\/[^)\s]*\/SKILL\.md)\)/g;
