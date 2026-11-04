import type { SessionMessage } from "@anthropic-ai/claude-agent-sdk";

import {
  type Rendered,
  renderSdkMessage,
  renderUserInput,
  type TurnState,
} from "../turn/turn.view.ts";
import {
  assistantOf,
  inputOf,
  isAssistantBody,
  opensTurn,
  promptOf,
  timeOf,
  toolResultsOf,
} from "./message.view.ts";

// Renders records as they are copied, such as a Cloud thread's, as the live turn renders Claude's messages.
export const renderRecords = (
  state: TurnState,
  messages: readonly SessionMessage[],
  now: number,
): Rendered => {
  let current = state;
  const notifications: Rendered["notifications"] = [];
  const add = (next: Rendered) => {
    current = next.state;
    notifications.push(...next.notifications);
  };

  for (const message of messages) {
    const at = timeOf(message) ?? now;
    const body = message.message;
    if (message.type === "user") {
      const prompt = promptOf(body);
      if (prompt === null) {
        add(renderSdkMessage(current, toolResultsOf(message, body), at));
      } else if (opensTurn(prompt)) {
        // A prompt typed elsewhere is shown as the user's message.
        add(renderUserInput(current, inputOf(prompt), null, at));
      }
    } else if (isAssistantBody(body)) {
      add(renderSdkMessage(current, assistantOf(message, body), at));
    }
  }

  return { state: current, notifications };
};
