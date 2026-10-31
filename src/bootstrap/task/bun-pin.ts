// Why the running Bun may not build harnexus-task, or null when it is the pinned one.
export const unpinnedBun = (pinned: string | null, running: string) =>
  pinned === running
    ? null
    : pinned === null
      ? `Bun ${running} runs this build, while package.json pins no Bun version`
      : `Bun ${running} runs this build, while harnexus pins ${pinned}; install Bun ${pinned} and run bun run install:task again`;
