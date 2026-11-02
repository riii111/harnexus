export default {
  meta: {
    type: "problem",
    messages: {
      throw:
        "Return Result.err instead of throw. Convert thrown exceptions in a *.boundary.ts file.",
      catch:
        "Use Result.try or Result.tryPromise in a *.boundary.ts file instead of try-catch.",
    },
    schema: [],
  },
  create: (context) => ({
    ThrowStatement: (node) => context.report({ node, messageId: "throw" }),
    CatchClause: (node) => context.report({ node, messageId: "catch" }),
  }),
};
