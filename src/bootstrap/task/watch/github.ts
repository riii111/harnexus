import { Result } from "better-result";
import {
  type GraphqlAnswer,
  postGraphql,
} from "../../../infra/github/graphql.boundary.ts";
import { parseJson } from "../../../runtime/json.boundary.ts";
import { isObject } from "../../../runtime/object.ts";
import { fail, type TaskFailed } from "../format.ts";
import type { Env, GitRunner } from "../request.ts";
import type { ItemKind } from "./config.ts";

export type GitHub = {
  summaries: (
    account: string,
    refs: readonly PrRef[],
  ) => Promise<Result<(PrSummary | null)[], TaskFailed>>;
  detail: (
    account: string,
    ref: PrRef,
  ) => Promise<Result<PrDetail, TaskFailed>>;
  openPulls: (
    account: string,
    repo: string,
  ) => Promise<Result<PrRef[], TaskFailed>>;
};

export type PrRef = { repo: string; number: number };

// What the light poll reads; a change in any of it is what makes the full read worth its cost.
export type PrSummary = {
  state: string;
  isDraft: boolean;
  head: string;
  updatedAt: string;
  mergeable: string;
  coderabbit: CodeRabbitStatus | null;
  rollup: string | null;
};

export type CodeRabbitStatus = {
  state: string;
  description: string;
  createdAt: string;
};

export type PrDetail = PrSummary & {
  url: string;
  title: string;
  failedRequired: FailedCheck[];
  comments: PrComment[];
  noActionableSummary: boolean;
};

export type FailedCheck = { name: string; url: string | null };

export type PrComment = {
  id: string;
  kind: ItemKind;
  author: string;
  url: string;
  createdAt: string;
  body: string;
  path: string | null;
  line: number | null;
  reply: boolean;
  resolved: boolean;
};

export const CODERABBIT = "coderabbitai[bot]";

type Post = (
  token: string,
  query: string,
  variables: Record<string, unknown>,
) => Promise<Result<GraphqlAnswer, { message: string }>>;

// The token is read per account on each call and kept nowhere, so a token the owner rotates is picked up and never reaches the state or the log.
export const createGitHub = (
  runCommand: GitRunner,
  env: Env,
  post: Post = postGraphql,
): GitHub => {
  const token = async (account: string) => {
    const ran = await runCommand(
      ["gh", "auth", "token", "--hostname", "github.com", "--user", account],
      env,
    );
    if (ran.isErr()) return fail(`gh auth token: ${ran.error.message}`);

    const value = ran.value.stdout.trim();
    if (ran.value.status !== 0 || value === "")
      return fail(`gh has no token for account ${account}`);
    return Result.ok(value);
  };

  const query = (
    account: string,
    text: string,
    variables: Record<string, unknown>,
  ) =>
    Result.gen(async function* () {
      const secret = yield* Result.await(token(account));
      const answer = await post(secret, text, variables);
      if (answer.isErr()) return fail(answer.error.message);

      const { status } = answer.value;
      const parsed = parseJson(answer.value.text);
      const body = parsed.isOk() ? parsed.value : null;
      if (!isObject(body))
        return fail(`GitHub answered ${status} without JSON`);
      if (Array.isArray(body.errors) && body.errors.length > 0)
        return fail(`GitHub answered ${status}: ${errorsOf(body.errors)}`);
      if (status !== 200 || !isObject(body.data))
        return fail(`GitHub answered ${status}`);
      return Result.ok(body.data);
    });

  return {
    summaries: (account, refs) =>
      Result.gen(async function* () {
        if (refs.length === 0) return Result.ok([]);

        const { text, variables } = summaryQuery(refs);
        const data = yield* Result.await(query(account, text, variables));
        return Result.ok(
          refs.map((_, index) => {
            const pull = pullOf(data[`p${index}`]);
            return pull === null ? null : summaryOf(pull);
          }),
        );
      }),

    detail: (account, ref) =>
      Result.gen(async function* () {
        const [owner, name] = ref.repo.split("/");
        const data = yield* Result.await(
          query(account, DETAIL_QUERY, { owner, name, number: ref.number }),
        );

        const pull = pullOf(data.repository);
        if (pull === null)
          return fail(`${ref.repo}#${ref.number} is not visible to ${account}`);
        return Result.ok(detailOf(pull));
      }),

    openPulls: (account, repo) =>
      Result.gen(async function* () {
        const data = yield* Result.await(
          query(account, OPEN_QUERY, {
            search: `repo:${repo} is:pr is:open draft:false author:${account}`,
          }),
        );

        const search = isObject(data.search) ? data.search : {};
        return Result.ok(
          nodesOf(search).flatMap((node) =>
            typeof node.number === "number"
              ? [{ repo, number: node.number }]
              : [],
          ),
        );
      }),
  };
};

const errorsOf = (errors: unknown[]) =>
  errors
    .map((error) =>
      isObject(error) && typeof error.message === "string"
        ? error.message
        : JSON.stringify(error),
    )
    .join("; ");

const CODERABBIT_CONTEXT = "CodeRabbit";

const SUMMARY_FIELDS = `state isDraft headRefOid updatedAt mergeable
  commits(last: 1) { nodes { commit {
    status { context(name: "${CODERABBIT_CONTEXT}") { state description createdAt } }
    statusCheckRollup { state }
  } } }`;

// One aliased query for every PR of an account, which GitHub counts as a single point.
const summaryQuery = (refs: readonly PrRef[]) => {
  const variables: Record<string, unknown> = {};
  const declared: string[] = [];
  const fields = refs.map((ref, index) => {
    const [owner, name] = ref.repo.split("/");
    Object.assign(variables, {
      [`o${index}`]: owner,
      [`r${index}`]: name,
      [`n${index}`]: ref.number,
    });
    declared.push(`$o${index}: String!, $r${index}: String!, $n${index}: Int!`);
    return `p${index}: repository(owner: $o${index}, name: $r${index}) { pullRequest(number: $n${index}) { ${SUMMARY_FIELDS} } }`;
  });

  return {
    text: `query(${declared.join(", ")}) { ${fields.join("\n")} }`,
    variables,
  };
};

const DETAIL_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) { pullRequest(number: $number) {
    url title ${SUMMARY_FIELDS}
    checks: commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100) { nodes {
      __typename
      ... on StatusContext { context state targetUrl isRequired(pullRequestNumber: $number) }
      ... on CheckRun { name conclusion detailsUrl isRequired(pullRequestNumber: $number) }
    } } } } } }
    reviewThreads(first: 100) { nodes { isResolved comments(first: 100) { nodes {
      databaseId url createdAt body path line originalLine
      author { __typename login } replyTo { databaseId }
    } } } }
    reviews(last: 100) { nodes { databaseId url createdAt body author { __typename login } } }
    comments(last: 100) { nodes { databaseId url createdAt body author { __typename login } } }
  } }
}`;

const OPEN_QUERY = `query($search: String!) {
  search(query: $search, type: ISSUE, first: 50) { nodes { ... on PullRequest { number } } }
}`;

const pullOf = (repository: unknown) =>
  isObject(repository) && isObject(repository.pullRequest)
    ? repository.pullRequest
    : null;

const summaryOf = (pull: Record<string, unknown>): PrSummary => {
  const commit = lastCommit(pull.commits);
  const status = isObject(commit.status) ? commit.status.context : null;
  const rollup = isObject(commit.statusCheckRollup)
    ? commit.statusCheckRollup.state
    : null;

  return {
    state: text(pull.state),
    isDraft: pull.isDraft === true,
    head: text(pull.headRefOid),
    updatedAt: text(pull.updatedAt),
    mergeable: text(pull.mergeable),
    coderabbit: isObject(status)
      ? {
          state: text(status.state),
          description: text(status.description),
          createdAt: text(status.createdAt),
        }
      : null,
    rollup: typeof rollup === "string" ? rollup : null,
  };
};

const NO_ACTIONABLE = "No actionable comments were generated";

const detailOf = (pull: Record<string, unknown>): PrDetail => {
  const inline = nodesOf(pull.reviewThreads).flatMap((thread) =>
    nodesOf(thread.comments).map((node) =>
      inlineOf(node, thread.isResolved === true),
    ),
  );
  const reviews = nodesOf(pull.reviews).map(plainOf("review", "review"));
  const issueComments = nodesOf(pull.comments).map(
    plainOf("issue_comment", "issue"),
  );

  return {
    ...summaryOf(pull),
    url: text(pull.url),
    title: text(pull.title),
    failedRequired: failedRequired(pull),
    comments: [...inline, ...reviews, ...issueComments],
    noActionableSummary: issueComments.some(
      (comment) =>
        comment.author === CODERABBIT && comment.body.includes(NO_ACTIONABLE),
    ),
  };
};

const inlineOf = (
  node: Record<string, unknown>,
  resolved: boolean,
): PrComment => {
  const line = node.line ?? node.originalLine;
  return {
    id: `inline:${String(node.databaseId)}`,
    kind: "inline",
    author: loginOf(node.author),
    url: text(node.url),
    createdAt: text(node.createdAt),
    body: text(node.body),
    path: typeof node.path === "string" ? node.path : null,
    line: typeof line === "number" ? line : null,
    reply: isObject(node.replyTo),
    resolved,
  };
};

const plainOf =
  (kind: "review" | "issue_comment", prefix: string) =>
  (node: Record<string, unknown>): PrComment => ({
    id: `${prefix}:${String(node.databaseId)}`,
    kind,
    author: loginOf(node.author),
    url: text(node.url),
    createdAt: text(node.createdAt),
    body: text(node.body),
    path: null,
    line: null,
    reply: false,
    resolved: false,
  });

// GraphQL drops the [bot] suffix that REST, the web and the ignore list use for apps.
const loginOf = (author: unknown) => {
  if (!isObject(author) || typeof author.login !== "string") return "ghost";
  return author.__typename === "Bot" ? `${author.login}[bot]` : author.login;
};

const failedRequired = (pull: Record<string, unknown>): FailedCheck[] => {
  const rollup = lastCommit(pull.checks).statusCheckRollup;
  const contexts = nodesOf(isObject(rollup) ? rollup.contexts : null);

  return contexts.flatMap((context) => {
    if (context.isRequired !== true) return [];
    if (context.__typename === "CheckRun")
      return FAILED_RUNS.has(text(context.conclusion))
        ? [{ name: text(context.name), url: linkOf(context.detailsUrl) }]
        : [];
    return FAILED_STATUSES.has(text(context.state)) &&
      context.context !== CODERABBIT_CONTEXT
      ? [{ name: text(context.context), url: linkOf(context.targetUrl) }]
      : [];
  });
};

// A cancelled run is left out, since a newer push cancels the runs it replaces.
const FAILED_RUNS = new Set([
  "FAILURE",
  "TIMED_OUT",
  "STARTUP_FAILURE",
  "ACTION_REQUIRED",
]);
const FAILED_STATUSES = new Set(["FAILURE", "ERROR"]);

const lastCommit = (commits: unknown) => {
  const commit = nodesOf(commits)[0]?.commit;
  return isObject(commit) ? commit : {};
};

const nodesOf = (connection: unknown): Record<string, unknown>[] =>
  isObject(connection) && Array.isArray(connection.nodes)
    ? connection.nodes.filter(isObject)
    : [];

const text = (value: unknown) => (typeof value === "string" ? value : "");

const linkOf = (value: unknown) => (typeof value === "string" ? value : null);
