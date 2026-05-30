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

export type LeafItem = {
  tokens: number;
  turn: number;
  summary: string;
  fullContent: string;
  toolInput?: string;
};
export type SubBucket = { id: string; name: string; tokens: number; items: LeafItem[] };
export type Bucket = { id: string; name: string; tokens: number; children: SubBucket[] };
export type Headline = {
  realTotal: number;
  modelCap: number;
  model: string;
  inputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
};
export type CompactionInfo = {
  boundaryCount: number;
  latestBoundaryAt: number;
  preTokens: number;
  postTokens: number;
  trigger: string;
};
export type Snapshot = {
  schemaVersion?: number;
  sessionId: string;
  filePath: string;
  mtimeMs: number;
  headline: Headline;
  buckets: Bucket[];
  compaction: CompactionInfo | null;
  warnings: string[];
  fromCache?: boolean;
};

async function get<T>(url: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
}

async function post<T>(url: string): Promise<T> {
  const r = await fetch(url, { method: "POST" });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
}

export const api = {
  projects: () => get<ProjectInfo[]>("/api/projects"),
  sessions: (project: string) =>
    get<SessionListItem[]>(`/api/sessions?project=${encodeURIComponent(project)}`),
  snapshot: (sessionId: string) => get<Snapshot>(`/api/sessions/${sessionId}/snapshot`),
  invalidate: (sessionId: string) => post<{ ok: boolean }>(`/api/sessions/${sessionId}/invalidate-cache`),
};
