export type ConnectionView =
  | { provider: "subscription" }
  | { provider: "vertex"; projectId: string; region: string };

export type SessionConnection =
  | { kind: "same"; saved: ConnectionView | null; configured: ConnectionView }
  | { kind: "changed"; saved: ConnectionView; configured: ConnectionView }
  | { kind: "unreadable"; saved: ConnectionView | null; problem: string };

type VertexView = Extract<ConnectionView, { provider: "vertex" }>;

// Claude Code reports only the provider; the project and region are what harnexus passed it, and neither says who is billed.
export const connectionNoticeText = (connection: VertexView) =>
  [
    "Harnexus connection",
    "",
    ...vertexLines(connection, "confirmed by Claude Code"),
  ].join("\n");

export const connectionChangedText = (
  saved: ConnectionView,
  configured: ConnectionView,
) =>
  `This chat runs on ${describe(saved)}, but harnexus settings now choose ${describe(configured)} for this repository, so nothing was sent to Claude. To keep this chat where it is, restore the setting; to move it, send /switch-connection.`;

export const switchedText = (to: ConnectionView) =>
  `This chat now follows harnexus settings for this repository: ${describe(to)}. Your next message starts Claude there, and Claude Code confirms the provider before anything is sent.`;

// A chat that stays on the subscription gets no line, so /session reads as it did before connections existed.
export const sessionConnectionLines = (connection: SessionConnection) => {
  const saved =
    connection.saved?.provider === "vertex"
      ? vertexLines(
          connection.saved,
          "confirmed by Claude Code when this chat's Claude session started",
        )
      : [];
  switch (connection.kind) {
    case "unreadable":
      return [
        ...saved,
        `${connection.problem}. Messages in this chat are not sent until it is fixed.`,
      ];
    case "changed":
      return [
        ...saved,
        `harnexus settings now choose ${describe(connection.configured)} for this repository. Send /switch-connection to move this chat, or restore the setting to keep it.`,
      ];
    case "same":
      return connection.saved === null &&
        connection.configured.provider === "vertex"
        ? [
            `harnexus settings choose ${describe(connection.configured)} for this repository; Claude Code confirms the provider when your next message starts Claude.`,
          ]
        : saved;
  }
};

// Without these variables claude --resume would continue the conversation on the terminal's own login.
export const resumeEnvOf = (
  saved: ConnectionView | null,
): [string, string][] =>
  saved?.provider === "vertex"
    ? [
        ["CLAUDE_CODE_USE_VERTEX", "1"],
        ["ANTHROPIC_VERTEX_PROJECT_ID", saved.projectId],
        ["CLOUD_ML_REGION", saved.region],
      ]
    : [];

const vertexLines = (connection: VertexView, confirmed: string) => [
  `- Provider: Google Vertex AI (${confirmed})`,
  `- Google Cloud project: \`${connection.projectId}\` (from harnexus settings)`,
  `- Region: \`${connection.region}\` (from harnexus settings)`,
];

const describe = (connection: ConnectionView) =>
  connection.provider === "subscription"
    ? "your Claude subscription"
    : `Google Vertex AI (project \`${connection.projectId}\`, region \`${connection.region}\`)`;
