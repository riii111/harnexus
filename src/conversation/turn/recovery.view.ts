export const RECOVERY_NOTICE =
  "The previous Claude turn stopped before its outcome was known. Changes or messages may already have been applied. Continuing with your new instruction while checking the current state.";

export const RECOVERY_CONTEXT =
  "<harnexus_recovery>\nThe previous Claude turn stopped before its outcome was known. Some file changes or messages to other threads may already have been applied. Before continuing, inspect the available conversation history and current state relevant to the user's new instruction. Do not blindly repeat previous actions; complete only the remaining work. If an external action cannot be verified, explain that uncertainty before deciding whether to repeat it. Follow the user's new instruction.\n</harnexus_recovery>";
