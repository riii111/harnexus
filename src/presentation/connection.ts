export type ConnectionView =
  | { provider: "subscription" }
  | { provider: "vertex"; projectId: string; region: string };

// credentialsFile says whether the settings name a credentials file, which the resume command leaves out.
export type SessionConnection = (
  | { kind: "same"; saved: ConnectionView | null; configured: ConnectionView }
  | { kind: "changed"; saved: ConnectionView; configured: ConnectionView }
  | { kind: "unreadable"; saved: ConnectionView | null; problem: string }
) & { resumeEnv: readonly [string, string][]; credentialsFile: boolean };

type VertexView = Extract<ConnectionView, { provider: "vertex" }>;

// Claude Code reports only the provider; the project and region come from the repository's settings, and neither says who is billed.
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
  `This chat runs on ${describe(saved)}, but this repository's Claude Code settings now choose ${describe(configured)}, so nothing was sent to Claude. To keep this chat where it is, restore the setting; to move it, send /switch-connection.`;

export const switchedText = (to: ConnectionView) =>
  `This chat now follows this repository's Claude Code settings: ${describe(to)}. Your next message starts Claude there, and Claude Code confirms the provider before anything is sent.`;

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
        `This repository's Claude Code settings now choose ${describe(connection.configured)}. Send /switch-connection to move this chat, or restore the setting to keep it.`,
      ];
    case "same":
      return connection.saved === null &&
        connection.configured.provider === "vertex"
        ? [
            `This repository's Claude Code settings choose ${describe(connection.configured)}; Claude Code confirms the provider when your next message starts Claude.`,
          ]
        : saved;
  }
};

const vertexLines = (connection: VertexView, confirmed: string) => [
  `- Provider: Google Vertex AI (${confirmed})`,
  `- Google Cloud project: \`${connection.projectId}\` (from this repository's Claude Code settings)`,
  `- Region: \`${connection.region}\` (from this repository's Claude Code settings)`,
];

const describe = (connection: ConnectionView) =>
  connection.provider === "subscription"
    ? "your Claude subscription"
    : `Google Vertex AI (project \`${connection.projectId}\`, region \`${connection.region}\`)`;
