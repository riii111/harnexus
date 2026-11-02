// When changing what this rule detects, add the violating and allowed cases it lacks to test/testing-lint.test.ts.
// Calls are matched by callee and arguments, so type arguments and extra options such as a timeout do not hide them.
const KEEP_INLINE =
  " Keep the table and title inline instead of moving them to a variable.";

const REGISTERS = new Set(["test", "it", "describe"]);
const EACH_OWNERS = REGISTERS;
const DESCRIBE = new Set(["describe"]);
const LOOPS = new Set([
  "ForOfStatement",
  "ForInStatement",
  "ForStatement",
  "WhileStatement",
  "DoWhileStatement",
]);
// %% prints a literal percent sign, so only an odd run of % before a specifier counts.
const SPECIFIER = /^(?:[\s\S]*[^%])?(?:%%)*%[spdifjo#][\s\S]*$/;
const PROPERTY = /^[\s\S]*\$[A-Za-z_][A-Za-z0-9_]*[\s\S]*$/;

const isIdentifier = (node, names) =>
  node?.type === "Identifier" && names.has(node.name);

const isMember = (node, objects, property) =>
  node?.type === "MemberExpression" &&
  !node.computed &&
  isIdentifier(node.object, objects) &&
  node.property.type === "Identifier" &&
  node.property.name === property;

// test.each, it.each or describe.each.
const isEach = (node, owners = EACH_OWNERS) => isMember(node, owners, "each");

const isDescribe = (call) =>
  isIdentifier(call.callee, DESCRIBE) ||
  (call.callee.type === "CallExpression" &&
    isEach(call.callee.callee, DESCRIBE));

const isRegister = (call) =>
  isIdentifier(call.callee, REGISTERS) || isEach(call.callee);

const isLoop = (node) =>
  LOOPS.has(node.type) ||
  (node.type === "CallExpression" &&
    node.arguments.length === 1 &&
    node.callee.type === "MemberExpression" &&
    !node.callee.computed &&
    node.callee.property.type === "Identifier" &&
    (node.callee.property.name === "forEach" ||
      node.callee.property.name === "map"));

// Only a string or a template without substitutions is read; any other title is left to review.
const staticTitle = (node, sourceCode) =>
  (node?.type === "Literal" && typeof node.value === "string") ||
  (node?.type === "TemplateLiteral" && node.expressions.length === 0)
    ? sourceCode.getText(node)
    : undefined;

const nestedDescribe = (node) => {
  if (!isDescribe(node)) return undefined;
  for (let up = node.parent; up; up = up.parent) {
    if (up.type === "CallExpression" && isDescribe(up)) {
      return { node, messageId: "nested" };
    }
  }
  return undefined;
};

const tupleRow = (node) => {
  if (!isEach(node.callee)) return undefined;
  const [table] = node.arguments;
  const row =
    table?.type === "ArrayExpression"
      ? table.elements.find((element) => element?.type === "ArrayExpression")
      : undefined;
  return row === undefined ? undefined : { node: row, messageId: "tuple" };
};

const badTitle = (node, sourceCode) => {
  if (node.callee.type !== "CallExpression" || !isEach(node.callee.callee)) {
    return undefined;
  }
  const [title] = node.arguments;
  const text = staticTitle(title, sourceCode);
  if (text === undefined) return undefined;
  if (SPECIFIER.test(text)) return { node: title, messageId: "specifier" };
  const [table] = node.callee.arguments;
  const hasObjectRow =
    table?.type === "ArrayExpression" &&
    table.elements.some((element) => element?.type === "ObjectExpression");
  return hasObjectRow && !PROPERTY.test(text)
    ? { node: title, messageId: "missingName" }
    : undefined;
};

export default {
  meta: {
    type: "suggestion",
    messages: {
      nested:
        "Do not nest describe blocks. Split them side by side, named after the target.",
      tuple: `Use object rows with a name instead of tuple rows.${KEEP_INLINE}`,
      specifier: `Embed a row property such as $name instead of a positional specifier.${KEEP_INLINE}`,
      missingName: `Embed a row property such as $name in the title so each case is named.${KEEP_INLINE}`,
      loop: "Register parametrized tests with test.each instead of a loop.",
    },
    schema: [],
  },
  create: (context) => {
    const sourceCode = context.sourceCode;
    const reportedLoops = new Set();
    return {
      CallExpression: (node) => {
        // Each call gets at most one of these reports, in this order, as the GritQL rule's or did.
        const found =
          nestedDescribe(node) ?? tupleRow(node) ?? badTitle(node, sourceCode);
        if (found !== undefined) context.report(found);
        if (isRegister(node)) {
          // Every enclosing loop is reported once, however many registrations it holds.
          for (let up = node.parent; up; up = up.parent) {
            if (isLoop(up) && !reportedLoops.has(up)) {
              reportedLoops.add(up);
              context.report({ node: up, messageId: "loop" });
            }
          }
        }
      },
    };
  },
};
