import { noFocusedTests, noSkippedTests } from "./focused-skipped-tests.js";
import noThrowTryCatch from "./no-throw-try-catch.js";
import testing from "./testing.js";

// Rules use only the ESLint rule API, so they can move to ESLint if Oxlint's JS plugins break.
export default {
  meta: { name: "harnexus" },
  rules: {
    "no-focused-tests": noFocusedTests,
    "no-skipped-tests": noSkippedTests,
    "no-throw-try-catch": noThrowTryCatch,
    testing,
  },
};
