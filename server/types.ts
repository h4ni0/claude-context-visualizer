export type SessionListItem = {
  id: string;
  project: string;
  projectPath: string;
  filePath: string;
  mtimeMs: number;
  title: string;
  realTotal: number | null;
  model: string | null;
  hasCompaction: boolean;
};

export type ProjectInfo = {
  slug: string;
  path: string;
  sessionCount: number;
  latestMtimeMs: number;
};

export type Headline = {
  realTotal: number;
  modelCap: number;
  model: string;
  inputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
};

export type LeafItem = {
  tokens: number;
  turn: number;
  summary: string;
  fullContent: string;
  // For tool calls / tool results: the (pretty-printed) tool input that was
  // sent to the model. Omitted for non-tool items (messages, thinking, …).
  toolInput?: string;
};

// Bump when the snapshot shape changes so stale on-disk caches are ignored.
export const SNAPSHOT_SCHEMA_VERSION = 2;

export type SubBucket = {
  id: string;
  name: string;
  tokens: number;
  items: LeafItem[];
};

export type Bucket = {
  id: string;
  name: string;
  tokens: number;
  children: SubBucket[];
};

export type CompactionInfo = {
  boundaryCount: number;
  latestBoundaryAt: number;
  preTokens: number;
  postTokens: number;
  trigger: string;
};

export type Snapshot = {
  schemaVersion: number;
  sessionId: string;
  filePath: string;
  mtimeMs: number;
  headline: Headline;
  buckets: Bucket[];
  compaction: CompactionInfo | null;
  warnings: string[];
};
