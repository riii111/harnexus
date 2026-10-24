import { doctorChecks, shellSetup } from "./doctor-checks.ts";
import { failed, formatReport } from "./doctor-report.ts";

const checks = await doctorChecks(shellSetup());
process.stdout.write(formatReport(checks));
process.exit(failed(checks) ? 1 : 0);
