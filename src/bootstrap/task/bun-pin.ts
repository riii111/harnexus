// A compiled harnexus-task carries the Bun that built it, so a Bun other than the pinned one is stopped at the build rather than when a chat calls it.
export const unpinnedBun = (pinned: string | null, running: string) =>
  pinned === running
    ? null
    : pinned === null
      ? `Bun ${running} runs this build, while package.json pins no Bun version`
      : `Bun ${running} runs this build, while harnexus pins ${pinned}; install Bun ${pinned} and run bun run install:task again`;
