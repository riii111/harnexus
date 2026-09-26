import type { PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import { isObject } from "../runtime/object.ts";
import type { ToolItem } from "./protocol.ts";

export type ToolCall = {
  toolName: string;
  input: Record<string, unknown>;
  // The item the app shows for the call; a subagent's call has none.
  item: ToolItem | null;
  title: string | undefined;
  reason: string | undefined;
  // Set by the SDK when the prompt must open on its refusal and never approve on a single keystroke.
  defaultToNo: boolean;
};

export type PromptTarget = {
  threadId: string;
  turnId: string;
  itemId: string;
  now: number;
};

export type AppPrompt = {
  method: string;
  params: Record<string, unknown>;
  decide: (answer: unknown) => PermissionResult;
};

// The app's permission request carries only network and file system grants, so tools without their own approval ask a yes/no question instead; so does a call that must default to no, since the app's approval prompts choose their own default.
export const promptFor = (call: ToolCall, target: PromptTarget): AppPrompt => {
  if (call.toolName === ASK_USER_QUESTION) {
    const questions = askedQuestions(call.input);
    if (questions !== null) return questionsPrompt(call, questions, target);
  }
  if (call.toolName === EXIT_PLAN_MODE) return planPrompt(call, target);
  if (call.defaultToNo) return toolPrompt(call, target);
  if (call.item?.type === "commandExecution") {
    return commandPrompt(call, call.item, target);
  }
  if (call.item?.type === "fileChange") return fileChangePrompt(call, target);
  return toolPrompt(call, target);
};

// Session-wide and policy choices are not offered, since Claude's own settings decide what is allowed and the bridge never writes them.
const commandPrompt = (
  call: ToolCall,
  item: Extract<ToolItem, { type: "commandExecution" }>,
  target: PromptTarget,
): AppPrompt => ({
  method: "item/commandExecution/requestApproval",
  params: {
    ...itemParams(target),
    kind: "command",
    environmentId: "local",
    reason: call.reason ?? null,
    command: item.command,
    cwd: item.cwd,
    commandActions: item.commandActions,
    availableDecisions: ["accept", "decline", "cancel"],
  },
  decide: (answer) => decideApproval(call, answer),
});

const fileChangePrompt = (call: ToolCall, target: PromptTarget): AppPrompt => ({
  method: "item/fileChange/requestApproval",
  params: {
    ...itemParams(target),
    reason: call.reason ?? null,
    grantRoot: null,
  },
  decide: (answer) => decideApproval(call, answer),
});

// Claude's AskUserQuestion reads answers keyed by question text, with several choices joined by commas; the app's choices are single-select, so a multi-select question is asked as free text listing its choices.
const questionsPrompt = (
  call: ToolCall,
  questions: AskedQuestion[],
  target: PromptTarget,
): AppPrompt => ({
  method: REQUEST_USER_INPUT,
  params: userInputParams(
    target,
    questions.map((asked, index) => ({
      id: questionId(index),
      header: asked.header,
      question: asked.multiSelect ? multiSelectQuestion(asked) : asked.question,
      isOther: true,
      isSecret: false,
      options: asked.multiSelect ? null : asked.options,
    })),
  ),
  decide: (answer) => {
    const answers: Record<string, string> = {};
    questions.forEach((asked, index) => {
      const chosen = answersTo(answer, questionId(index));
      if (chosen.length > 0) answers[asked.question] = chosen.join(", ");
    });
    return Object.keys(answers).length === 0
      ? unanswered(call)
      : { behavior: "allow", updatedInput: { ...call.input, answers } };
  },
});

// Approving leaves plan mode for the rest of the turn, as Claude Code does.
const planPrompt = (call: ToolCall, target: PromptTarget): AppPrompt => ({
  method: REQUEST_USER_INPUT,
  params: userInputParams(target, [
    {
      id: PLAN_QUESTION,
      header: "Plan",
      question:
        (typeof call.input.plan === "string"
          ? `${call.input.plan}\n\nStart implementing this plan?`
          : "Claude has finished planning. Start implementing?") +
        typedApproval(call, APPROVE_PLAN),
      isOther: true,
      isSecret: false,
      options: choicesFor(call, [
        { label: APPROVE_PLAN, description: "Leave plan mode and implement" },
        { label: KEEP_PLANNING, description: "Stay in plan mode" },
      ]),
    },
  ]),
  decide: (answer) => {
    const [chosen] = answersTo(answer, PLAN_QUESTION);
    if (chosen === undefined) return unanswered(call);
    if (isChoice(chosen, APPROVE_PLAN)) {
      return {
        behavior: "allow",
        updatedPermissions: [
          { type: "setMode", mode: "default", destination: "session" },
        ],
      };
    }
    return {
      behavior: "deny",
      message: isChoice(chosen, KEEP_PLANNING)
        ? "The user wants to keep planning."
        : `The user wants changes to the plan: ${chosen}`,
    };
  },
});

const toolPrompt = (call: ToolCall, target: PromptTarget): AppPrompt => ({
  method: REQUEST_USER_INPUT,
  params: userInputParams(target, [
    {
      id: APPROVAL_QUESTION,
      header: "Approval",
      question:
        [
          call.title ?? `Allow Claude to use ${call.toolName}?`,
          JSON.stringify(call.input, null, 2),
        ].join("\n\n") + typedApproval(call, ALLOW),
      isOther: call.defaultToNo,
      isSecret: false,
      options: choicesFor(call, [
        { label: ALLOW, description: "Run this tool call once" },
        { label: DENY, description: "Refuse this tool call" },
      ]),
    },
  ]),
  decide: (answer) => {
    const [chosen] = answersTo(answer, APPROVAL_QUESTION);
    if (chosen === undefined) return unanswered(call);
    return isChoice(chosen, ALLOW) ? { behavior: "allow" } : declined(call);
  },
});

// Codex policy amendments are never written to Claude's settings, so they allow only this call.
const decideApproval = (call: ToolCall, answer: unknown): PermissionResult => {
  if (!isObject(answer) || answer.decision === undefined) {
    return unanswered(call);
  }
  const decision = answer.decision;
  const accepted =
    decision === "accept" ||
    decision === "acceptForSession" ||
    (isObject(decision) && "acceptWithExecpolicyAmendment" in decision);
  return accepted ? { behavior: "allow" } : declined(call);
};

// The app picks and submits a choice on a single number key, so a call that must default to no offers no choices and approves only when the approving word is typed.
const choicesFor = <T>(call: ToolCall, choices: T[]) =>
  call.defaultToNo ? null : choices;

const typedApproval = (call: ToolCall, word: string) =>
  call.defaultToNo
    ? `\n\nType "${word}" to approve. Any other answer refuses.`
    : "";

const isChoice = (chosen: string, label: string) =>
  chosen.trim().toLowerCase() === label.toLowerCase();

const multiSelectQuestion = (asked: AskedQuestion) =>
  [
    asked.question,
    asked.options
      .map(({ label, description }) =>
        description === "" ? `- ${label}` : `- ${label}: ${description}`,
      )
      .join("\n"),
    "Answer with one or more of these, separated by commas.",
  ].join("\n\n");

const itemParams = (target: PromptTarget) => ({
  threadId: target.threadId,
  turnId: target.turnId,
  itemId: target.itemId,
  startedAtMs: target.now,
});

const userInputParams = (target: PromptTarget, questions: object[]) => ({
  threadId: target.threadId,
  turnId: target.turnId,
  itemId: target.itemId,
  questions,
  isBlocking: true,
  autoResolutionMs: null,
});

const answersTo = (answer: unknown, id: string): string[] => {
  if (!isObject(answer) || !isObject(answer.answers)) return [];
  const entry = answer.answers[id];
  if (!isObject(entry) || !Array.isArray(entry.answers)) return [];
  return entry.answers.filter(
    (value): value is string => typeof value === "string" && value !== "",
  );
};

const askedQuestions = (input: Record<string, unknown>) => {
  const { questions } = input;
  if (!Array.isArray(questions) || questions.length === 0) return null;
  const asked: AskedQuestion[] = [];
  for (const question of questions) {
    if (
      !isObject(question) ||
      typeof question.question !== "string" ||
      typeof question.header !== "string" ||
      !Array.isArray(question.options)
    ) {
      return null;
    }
    asked.push({
      question: question.question,
      header: question.header,
      multiSelect: question.multiSelect === true,
      options: question.options.filter(isOption).map((option) => ({
        label: option.label,
        description:
          typeof option.description === "string" ? option.description : "",
      })),
    });
  }
  return asked;
};

const isOption = (
  value: unknown,
): value is { label: string; description?: unknown } =>
  isObject(value) && typeof value.label === "string";

const declined = (call: ToolCall): PermissionResult => ({
  behavior: "deny",
  message: `The user declined ${call.toolName} in the app.`,
});

const unanswered = (call: ToolCall): PermissionResult => ({
  behavior: "deny",
  message: `${call.toolName} was not approved, since the app gave no answer.`,
});

const questionId = (index: number) => `question-${index + 1}`;

type AskedQuestion = {
  question: string;
  header: string;
  multiSelect: boolean;
  options: { label: string; description: string }[];
};

const ASK_USER_QUESTION = "AskUserQuestion";
const EXIT_PLAN_MODE = "ExitPlanMode";
const REQUEST_USER_INPUT = "item/tool/requestUserInput";
const PLAN_QUESTION = "plan";
const APPROVAL_QUESTION = "approval";
const APPROVE_PLAN = "Approve";
const KEEP_PLANNING = "Keep planning";
const ALLOW = "Allow";
const DENY = "Deny";
