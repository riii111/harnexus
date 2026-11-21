// Earlier versions registered the app's environment for the whole login session under this label, so it is only ever cleared now.
export const AGENT_LABEL = "com.harnexus.environment";

export const ownsAgent = (agent: string | null) =>
  agent?.includes(`<key>Label</key><string>${AGENT_LABEL}</string>`) ?? false;
