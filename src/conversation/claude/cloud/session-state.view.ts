import { askedQuestions } from "../../turn/permission.view.ts";

// What the chat shows of a question or plan a Cloud session waits on, with how to answer it.
export const askNotice = (
  ask: "question" | "plan",
  input: Record<string, unknown>,
) => (ask === "plan" ? planNotice(input) : questionNotice(input));

const questionNotice = (input: Record<string, unknown>) => {
  const questions = askedQuestions(input) ?? [];
  const asked = questions.map(({ header, question, options, multiSelect }) =>
    [
      `**${header}**: ${question}`,
      ...options.map(({ label, description }) =>
        description === "" ? `- ${label}` : `- ${label}: ${description}`,
      ),
      ...(multiSelect ? ["(You can choose more than one.)"] : []),
    ].join("\n"),
  );
  return [QUESTION_LEAD, ...asked, ANSWER_HINT].join("\n\n");
};

const planNotice = (input: Record<string, unknown>) =>
  [
    PLAN_LEAD,
    ...(typeof input.plan === "string" && input.plan.trim() !== ""
      ? [input.plan.trim()]
      : []),
    ANSWER_HINT,
  ].join("\n\n");

const QUESTION_LEAD = "The Cloud session is waiting for your answer:";

const PLAN_LEAD = "The Cloud session is waiting for you to approve its plan:";

const ANSWER_HINT =
  "Reply here to answer, or answer on claude.ai. The session waits until then.";

export const INTERRUPTED_NOTICE =
  "The Cloud session was stopped on claude.ai. Send a message here to continue it.";

// The error Claude Code wrote is shown above as the session's own reply, so only what to do next is said.
export const ERRORED_NOTICE =
  "The Cloud session stopped on the error above. Check it on claude.ai, then send a message here to continue.";
