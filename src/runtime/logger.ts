export type LogSink = (line: string) => void;

// Each layer owns its event type and a serializer that copies only known fields, so request bodies, conversations, code and credentials cannot reach the log even through a widened object.
export const createLogger = <E>(
  sink: LogSink,
  serialize: (entry: E) => object,
) => ({
  log: (entry: E) => {
    const record = { time: new Date().toISOString(), ...serialize(entry) };
    sink(`${JSON.stringify(record)}\n`);
  },
});
