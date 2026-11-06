import {
  answerValuesOf,
  REQUEST_USER_INPUT,
  userInputParams,
  type UserInputTarget,
} from "./user-input.view.ts";

export type ConsentTab = { title: string; url: string };

// Asks the user to let Claude use a browser tab their message linked; the typed word is the only approval, so a stray key press cannot grant it.
export const tabConsentPrompt = (target: UserInputTarget, tab: ConsentTab) => ({
  method: REQUEST_USER_INPUT,
  params: userInputParams(target, [
    {
      id: QUESTION,
      header: "Browser tab",
      question: [
        "Allow Claude to read and operate this in-app browser tab for this turn?",
        `Title when attached: ${JSON.stringify(tab.title)}`,
        `Address when attached: ${tab.url}`,
        `Type "${APPROVE}" to allow it. Any other answer refuses.`,
      ].join("\n\n"),
      isOther: true,
      isSecret: false,
      options: null,
    },
  ]),
  // Only one answer that is the approving word counts, so a missing, extra or free-text answer never allows the tab.
  allowed: (answer: unknown) => {
    const values = answerValuesOf(answer, QUESTION);
    const [only] = values;
    return (
      values.length === 1 &&
      typeof only === "string" &&
      only.trim().toLowerCase() === APPROVE.toLowerCase()
    );
  },
});

const QUESTION = "browser_tab_consent";
const APPROVE = "Allow";
