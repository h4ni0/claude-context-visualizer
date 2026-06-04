import type { ProjectInfo, SessionListItem, Snapshot } from "../types.ts";

export const AGENTS = ["claude", "openclaw", "hermes", "opencode"] as const;
export type Agent = typeof AGENTS[number];

export const AGENT_LABELS: Record<Agent, string> = {
  claude: "Claude Code",
  openclaw: "OpenClaw",
  hermes: "Hermes",
  opencode: "OpenCode",
};

export const AGENT_COLORS: Record<Agent, string> = {
  claude: "#d97706",
  openclaw: "#7c3aed",
  hermes: "#059669",
  opencode: "#0284c7",
};

export type SessionMeta = {
  id: string;
  title: string;
  realTotal: number | null;
  model: string | null;
  hasCompaction: boolean;
  inputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  cwd: string | null;
};

export type NormalizedContentBlock = {
  type: string;
  text?: string;
  thinking?: string;
  signature?: string;
  name?: string;
  input?: unknown;
  id?: string;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
};

export type NormalizedRecord = {
  type: string;
  subtype?: string;
  message?: {
    content?: string | NormalizedContentBlock[];
    usage?: Record<string, number>;
    model?: string;
  };
  attachment?: unknown;
  compactMetadata?: {
    preTokens: number;
    postTokens: number;
    trigger: string;
  };
  cwd?: string;
};

export interface Provider {
  readonly id: Agent;
  readonly label: string;
  listProjects(): Promise<ProjectInfo[]>;
  listSessions(projectSlug: string): Promise<SessionListItem[]>;
  findSessionById(sessionId: string): Promise<string | null>;
  indexSessionFile(filePath: string): Promise<SessionMeta>;
  computeSnapshot(filePath: string, knownMtimeMs?: number): Promise<Snapshot>;
}
