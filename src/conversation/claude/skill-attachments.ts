import { skillBlock, skillLinks } from "../../presentation/skill-prompt.ts";
import { readRegularTextFile } from "../../runtime/fs.boundary.ts";

// A file that cannot be read leaves only its link in the prompt, which Claude may still follow.
export const readSkills = async (text: string) => {
  const links = skillLinks(text);
  const bodies = await Promise.all(
    links.map(({ path }) => readRegularTextFile(path)),
  );
  const skills: { path: string; body: string; block: string }[] = [];
  const unreadable: string[] = [];
  for (const [index, { name, path }] of links.entries()) {
    const body = bodies[index];
    if (body === undefined || body.isErr()) unreadable.push(path);
    else {
      skills.push({
        path,
        body: body.value,
        block: skillBlock(name, path, body.value),
      });
    }
  }
  return { skills, unreadable };
};
