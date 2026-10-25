import { join } from "node:path";
import { codexPathOf, doctorChecks, shellSetup } from "./doctor-checks.ts";
import { failed, formatReport } from "./doctor-report.ts";
import { readLaunchd } from "./launchd.boundary.ts";
import { collectSetupFacts } from "./setup-facts.ts";

const setup = shellSetup();
const facts = await collectSetupFacts(
  join(import.meta.dir, "..", ".."),
  codexPathOf(setup),
  await readLaunchd(),
);
const checks = await doctorChecks(setup, facts);
process.stdout.write(formatReport(checks));
process.exit(failed(checks) ? 1 : 0);
