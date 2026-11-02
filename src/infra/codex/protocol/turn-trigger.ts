export const isManualTurnTrigger = (trigger: unknown): boolean =>
  trigger === "composer" ||
  trigger === "composer_queue" ||
  trigger === "composer_queue_run_now";
