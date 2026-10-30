import { join } from "node:path";
import { Result, TaggedError } from "better-result";
import { prepareDirectory } from "../../runtime/fs.boundary.ts";
import { runCommand } from "../../runtime/process.boundary.ts";

// teleport copies a session made in a repository only from a checkout of it, which it tells by the remote URL alone; a checkout here is an empty repository with that remote, so nothing is fetched unless the session names a branch.
// teleport fetches and checks out a branch the session names, so each copy running at once gets a checkout of its own, apart from the user's repositories.
export type CloudCheckouts = {
  repositoryOf: (cloudSessionId: string) => string | null;
  remember: (cloudSessionId: string, repository: string) => void;
  take: (repository: string) => Promise<Result<Checkout, CheckoutFailed>>;
};

type Checkout = { dir: string; release: () => void };

class CheckoutFailed extends TaggedError("CheckoutFailed")<{
  message: string;
}> {}

// repository is owner/name on GitHub.
export const createCloudCheckouts = (
  root: string,
  env: Record<string, string | undefined>,
): CloudCheckouts => {
  // Kept for the bridge's life only; after a restart the first copy learns the repository again from teleport's refusal.
  const repositories = new Map<string, string>();
  const busy = new Map<string, Set<number>>();
  const prepared = new Set<string>();

  const take = async (repository: string) => {
    const used = busy.get(repository) ?? new Set<number>();
    busy.set(repository, used);
    let slot = 0;
    while (used.has(slot)) slot += 1;
    used.add(slot);
    const release = () => {
      used.delete(slot);
    };
    const dir = join(root, ...repository.split("/"), String(slot));
    if (!prepared.has(dir)) {
      const made = await prepareCheckout(dir, repository, env);
      if (made.isErr()) {
        release();
        return Result.err(made.error);
      }
      prepared.add(dir);
    }
    return Result.ok({ dir, release });
  };

  return {
    repositoryOf: (cloudSessionId) => repositories.get(cloudSessionId) ?? null,
    remember: (cloudSessionId, repository) => {
      repositories.set(cloudSessionId, repository);
    },
    take,
  };
};

// Every step leaves an existing checkout as it is, so a folder left by an earlier bridge is used again.
const prepareCheckout = async (
  dir: string,
  repository: string,
  env: Record<string, string | undefined>,
): Promise<Result<void, CheckoutFailed>> => {
  const failed = (message: string) =>
    Result.err(new CheckoutFailed({ message }));
  const ready = await prepareDirectory(dir);
  if (ready.isErr()) return failed(ready.error.message);
  for (const args of [
    ["init", "-q"],
    ["config", "remote.origin.url", `https://github.com/${repository}`],
    ["config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"],
  ]) {
    const ran = await runCommand("git", ["-C", dir, ...args], env);
    if (ran.isErr()) return failed(ran.error.message);
    if (ran.value.status !== 0) {
      return failed(
        ran.value.stderr.trim().split("\n")[0] ||
          `git ${args[0]} exited with ${ran.value.status}`,
      );
    }
  }
  return Result.ok();
};
