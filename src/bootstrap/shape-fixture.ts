import { fixtureFromReport } from "./feedback-protocol.ts";

// Turns the shapes a feedback report lists, read from stdin, into fixture lines for test/fixtures/app-server.
const report = await Bun.stdin.text();
process.stdout.write(fixtureFromReport(report));
