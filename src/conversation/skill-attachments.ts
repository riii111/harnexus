import { skillBlock, skillLinks } from "../presentation/skill-prompt.ts";
import { readRegularTextFile } from "../runtime/fs.boundary.ts";

// A file that cannot be read leaves only its link in the prompt, which Claude may still follow.
export const skillAttachments = async (
  text: string,
  read: typeof readRegularTextFile = readRegularTextFile,
) => {
  const links = skillLinks(text);
  const bodies = await Promise.all(links.map(({ path }) => read(path)));
  const attachments: string[] = [];
  const unreadable: string[] = [];
  for (const [index, { name, path }] of links.entries()) {
    const body = bodies[index];
    if (body === undefined || body.isErr()) unreadable.push(path);
    else attachments.push(skillBlock(name, path, body.value));
  }
  return { attachments, unreadable };
};
