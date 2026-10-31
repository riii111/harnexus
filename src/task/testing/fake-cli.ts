import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A stand-in for claude-cloud or codex: records its arguments, directory and stdin, then prints the next planned output.
const SCRIPT = `#!/usr/bin/env bash
dir="$FAKE_DIR"
n=$(( $(cat "$dir/count" 2>/dev/null || echo 0) + 1 ))
echo "$n" > "$dir/count"
printf '%s\\n' "$@" > "$dir/args.$n"
pwd > "$dir/cwd.$n"
cat > "$dir/stdin.$n"
if [ -f "$dir/sleep.$n" ]; then sleep "$(cat "$dir/sleep.$n")"; fi
if [ -f "$dir/stderr.$n" ]; then cat "$dir/stderr.$n" >&2; fi
cat "$dir/out.$n" 2>/dev/null
exit "$(cat "$dir/exit.$n" 2>/dev/null || echo 0)"
`;

export type PlannedRun = { out?: string; exit?: number; stderr?: string };

export const createFakeCli = async (
  binName: string,
  cleanups: (() => Promise<unknown>)[],
) => {
  // macOS reaches tmpdir through the /var link, while pwd in the fake prints /private/var.
  const root = await realpath(
    await mkdtemp(join(tmpdir(), `harnexus-${binName}-`)),
  );
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const fake = join(root, "fake");
  await mkdir(fake);
  const bin = join(root, binName);
  await writeFile(bin, SCRIPT);
  await chmod(bin, 0o755);
  const plan = (n: number, { out = "", exit = 0, stderr }: PlannedRun) =>
    Promise.all([
      writeFile(join(fake, `out.${n}`), out),
      writeFile(join(fake, `exit.${n}`), String(exit)),
      stderr === undefined
        ? Promise.resolve()
        : writeFile(join(fake, `stderr.${n}`), stderr),
    ]);
  const rawArgs = async (n: number) =>
    (await readFile(join(fake, `args.${n}`), "utf8")).trim().split("\n");
  return { root, fake, bin, plan, rawArgs };
};
