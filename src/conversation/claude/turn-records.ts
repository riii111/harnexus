// Kept while the bridge runs, since a revert or a history page may name any turn the app was shown and the app never says a thread is finished.
export const createTurnRecords = () => {
  const records = new Map<string, Map<string, string>>();

  const note = (threadId: string, turnId: string, record: string) => {
    const known = records.get(threadId) ?? new Map<string, string>();
    known.set(turnId, record);
    records.set(threadId, known);
  };

  const recordOf = (threadId: string, turnId: string) =>
    records.get(threadId)?.get(turnId) ?? null;

  return { note, recordOf };
};
