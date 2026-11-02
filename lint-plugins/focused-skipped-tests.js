// Oxlint's jest rules skip calls imported from bun:test, so these rules match the names alone.
const REGISTERS = new Set(["describe", "it", "test"]);

const rootName = (node) => {
  let root = node;
  while (root.type === "MemberExpression") root = root.object;
  return root.type === "Identifier" ? root.name : undefined;
};

const propertyName = ({ computed, property }) => {
  if (!computed && property.type === "Identifier") return property.name;
  return computed &&
    property.type === "Literal" &&
    typeof property.value === "string"
    ? property.value
    : undefined;
};

const modifierRule = (modifier, aliases, message) => ({
  meta: { type: "problem", messages: { found: message }, schema: [] },
  create: (context) => ({
    MemberExpression: (node) => {
      if (
        propertyName(node) === modifier &&
        REGISTERS.has(rootName(node.object))
      ) {
        context.report({ node: node.property, messageId: "found" });
      }
    },
    CallExpression: (node) => {
      if (node.callee.type === "Identifier" && aliases.has(node.callee.name)) {
        context.report({ node: node.callee, messageId: "found" });
      }
    },
  }),
});

export const noFocusedTests = modifierRule(
  "only",
  new Set(["fdescribe", "fit", "ftest"]),
  "Remove the focus so every test runs.",
);

export const noSkippedTests = modifierRule(
  "skip",
  new Set(["xdescribe", "xit", "xtest"]),
  "Remove the skip, or delete the test if it no longer applies.",
);
