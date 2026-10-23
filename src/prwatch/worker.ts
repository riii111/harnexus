import type { Fields } from "./failure.ts";

// What the watch needs from whoever works on a PR; harnexus-task supplies Codex worker chats.
export type Workers = {
  // Null while nothing can send to the worker.
  senderOf: (worker: string) => Promise<string | null>;
  // Null when the worker cannot be asked now, as while the app is closed; the next cycle asks again.
  look: (
    sender: string,
    worker: string,
    awaited: Sent | null,
    now: Date,
  ) => Promise<WorkerView | null>;
  send: (sender: string, worker: string, prompt: string) => Promise<Sending>;
};

export type Sent = { at: string; sender: string; prompt: string };

export type WorkerView =
  | { gone: true }
  | {
      gone: false;
      // Why a message would interrupt the worker now, or null.
      busy: string | null;
      // The turn the awaited message started, or null while none is seen.
      answer: Answer | null;
    };

// A turn that ended any other way than completed was stopped by the owner.
export type Answer = {
  status: "inProgress" | "completed" | "other";
  text: string;
};

// "unknown" means the message may have reached the worker.
export type Sending = {
  outcome: "done" | "not_sent" | "unknown";
  detail: Fields;
};
