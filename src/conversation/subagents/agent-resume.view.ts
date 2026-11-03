import type { SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import { parseJson } from "../../lib/json.boundary.ts";
import { isObject } from "../../lib/object.ts";
import { isMetaMessage, timeOf } from "../history/message.view.ts";

export const RESUME_TOOL = "SendMessage";

export type AgentResume = {
  toolUseId: string;
  recipient: string;
  resumedAgentId: string | null;
  at: number | null;
};

// The calls in a record that resumed an agent.
export const findAgentResumes = (
  messages: readonly SessionMessage[],
): AgentResume[] => {
  const calls: Omit<AgentResume, "resumedAgentId">[] = [];
  const answers = new Map<string, unknown>();
  for (const message of messages) {
    if (isMetaMessage(message)) continue;
    const body = message.message;
    if (!isObject(body) || !Array.isArray(body.content)) continue;
    for (const block of body.content) {
      if (!isObject(block)) continue;
      if (
        message.type === "assistant" &&
        block.type === "tool_use" &&
        block.name === RESUME_TOOL &&
        typeof block.id === "string"
      ) {
        const recipient = recipientOf(block.input);
        if (recipient !== null) {
          calls.push({ toolUseId: block.id, recipient, at: timeOf(message) });
        }
      } else if (
        message.type === "user" &&
        block.type === "tool_result" &&
        typeof block.tool_use_id === "string" &&
        block.is_error !== true
      ) {
        answers.set(block.tool_use_id, resumeAnswer(block.content));
      }
    }
  }

  // Only Claude's answer tells a resume from a message queued for an agent still running.
  return calls.flatMap((call) => {
    const answer = answers.get(call.toolUseId);
    if (!isObject(answer)) return [];
    return [
      {
        ...call,
        resumedAgentId:
          typeof answer.resumedAgentId === "string"
            ? answer.resumedAgentId
            : null,
      },
    ];
  });
};

const recipientOf = (input: unknown) => {
  if (!isObject(input)) return null;
  // recipient is the older shape Claude still takes.
  const to = typeof input.to === "string" ? input.to : input.recipient;
  return typeof to === "string" && to !== "" ? to : null;
};

const resumeAnswer = (content: unknown) => {
  const first: unknown = Array.isArray(content)
    ? content.find((block) => isObject(block) && block.type === "text")
    : { text: content };
  const text =
    isObject(first) && typeof first.text === "string" ? first.text : "";
  // Claude's answer opens with one line of JSON, which a report handed back with it follows.
  const answer = parseLine(text.split("\n", 1)[0] ?? "");
  if (!isObject(answer) || answer.success !== true) return null;
  // The answer names the agent as resumedAgentId, or, when the agent's report comes back in it or the agent answers to another agent, says it is resuming or resumed the agent.
  return typeof answer.resumedAgentId === "string" ||
    (typeof answer.message === "string" && RESUMED.test(answer.message))
    ? answer
    : null;
};

const parseLine = (line: string): unknown => {
  const parsed = parseJson(line);
  return parsed.isOk() ? parsed.value : null;
};

const RESUMED = /^Resum(?:ed|ing) agent\b/;
