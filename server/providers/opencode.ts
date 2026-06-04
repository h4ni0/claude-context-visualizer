import { stat } from "node:fs/promises";
import { basename } from "node:path";
import { Database } from "bun:sqlite";
import { OPENCODE_DB_PATH } from "../paths.ts";
import { buildSnapshot } from "../snapshot.ts";
import type { ProjectInfo, SessionListItem } from "../types.ts";
import type { Provider, SessionMeta, NormalizedRecord } from "./types.ts";

type OpenCodeSessionRow = {
  id: string;
  project_id: string | null;
  agent: string | null;
  model: string | null;
  title: string | null;
  tokens_input: number | null;
  tokens_output: number | null;
  cost: number | null;
  directory: string | null;
  slug: string | null;
};

type OpenCodeProjectRow = {
  id: string;
  worktree: string | null;
  name: string | null;
};

type OpenCodeMessageRow = {
  id: string;
  session_id: string;
  data: string;
};

type OpenCodePartRow = {
  id: string;
  message_id: string;
  session_id: string;
  data: string;
};

let db: Database | null = null;

function getDb(): Database | null {
  if (db) return db;
  try {
    db = new Database(OPENCODE_DB_PATH, { readonly: true });
    db.run("PRAGMA journal_mode=WAL");
    return db;
  } catch {
    return null;
  }
}

function queryAll<T>(sql: string, params?: (string | number | null)[]): T[] {
  const d = getDb();
  if (!d) return [];
  try {
    const stmt = d.query(sql);
    return (params ? stmt.all(...params) : stmt.all()) as T[];
  } catch (e) {
    console.error("[opencode] query error:", e);
    return [];
  }
}

function queryOne<T>(sql: string, params?: (string | number | null)[]): T | null {
  const d = getDb();
  if (!d) return null;
  try {
    const stmt = d.query(sql);
    return (params ? stmt.get(...params) : stmt.get()) as T | null;
  } catch (e) {
    console.error("[opencode] query error:", e);
    return null;
  }
}

function extractModel(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return String(parsed.modelID ?? parsed.id ?? parsed.name ?? "");
  } catch {
    return raw.length > 80 ? raw.slice(0, 80) : raw;
  }
}

function opencodeRecordsForSession(sessionId: string): {
  records: NormalizedRecord[];
  model: string | null;
} {
  const records: NormalizedRecord[] = [];
  const session = queryOne<OpenCodeSessionRow>(
    "SELECT id, project_id, agent, model, title, tokens_input, tokens_output, cost, directory, slug FROM session WHERE id = ?",
    [sessionId],
  );
  const model = extractModel(session?.model);

  const messageRows = queryAll<OpenCodeMessageRow>(
    "SELECT id, session_id, data FROM message WHERE session_id = ? ORDER BY time_created ASC",
    [sessionId],
  );

  for (const msgRow of messageRows) {
    let msgData: Record<string, unknown>;
    try {
      msgData = JSON.parse(msgRow.data);
    } catch {
      continue;
    }

    const role = String(msgData.role ?? "user");
    const msgTokens = msgData.tokens as Record<string, unknown> | undefined;
    const contentBlocks: any[] = [];

    const partRows = queryAll<OpenCodePartRow>(
      "SELECT id, message_id, session_id, data FROM part WHERE message_id = ? ORDER BY time_created ASC",
      [msgRow.id],
    );

    for (const partRow of partRows) {
      let partData: Record<string, unknown>;
      try {
        partData = JSON.parse(partRow.data);
      } catch {
        continue;
      }

      const ptype = String(partData.type ?? "");

      if (ptype === "text") {
        const text = String(partData.text ?? "");
        contentBlocks.push({ type: "text", text });
      } else if (ptype === "thinking") {
        const thinking = String(partData.text ?? partData.thinking ?? "");
        const sig = partData.signature ? String(partData.signature) : undefined;
        contentBlocks.push({ type: "thinking", thinking, signature: sig });
      } else if (ptype === "tool-use" || ptype === "tool_use") {
        contentBlocks.push({
          type: "tool_use",
          id: partRow.id,
          name: String(partData.tool_name ?? "unknown"),
          input: partData.tool_input ?? {},
        });
      } else if (ptype === "tool-result" || ptype === "tool_result") {
        const output = partData.output ?? partData.text ?? "";
        contentBlocks.push({
          type: "tool_result",
          tool_use_id: String(partData.tool_call_id ?? partRow.id),
          content: typeof output === "string" ? output : JSON.stringify(output),
          is_error: !!partData.is_error,
        });
      }
    }

    if (contentBlocks.length === 0) {
      const textContent = msgData.content ? String(msgData.content) : "";
      if (textContent) {
        contentBlocks.push({ type: "text", text: textContent });
      }
    }

    if (contentBlocks.length === 0) continue;

    let usage: Record<string, number> | undefined;
    if (msgTokens) {
      usage = {
        input_tokens: Number(msgTokens.input ?? 0),
        cache_creation_input_tokens: Number(
          (msgTokens.cache as Record<string, unknown>)?.["write"] ?? 0,
        ),
        cache_read_input_tokens: Number(
          (msgTokens.cache as Record<string, unknown>)?.["read"] ?? 0,
        ),
        output_tokens: Number(msgTokens.output ?? 0),
      };
    }

    const rawModel = msgData.model ?? model ?? "";
    const modelStr = typeof rawModel === "object" && rawModel !== null
      ? String((rawModel as any).modelID ?? (rawModel as any).id ?? "")
      : String(rawModel);

    records.push({
      type: role === "assistant" ? "assistant" : "user",
      message: {
        content: contentBlocks,
        usage,
        model: modelStr,
      },
    });
  }

  return { records, model };
}

function extractOpenCodeTitle(sessionTitle: string | null, records: NormalizedRecord[]): string {
  if (sessionTitle && sessionTitle !== "New Chat") return sessionTitle.length > 100 ? sessionTitle.slice(0, 100) + "\u2026" : sessionTitle;
  for (const r of records) {
    if (r.type === "user" && r.message?.content) {
      const c = r.message.content;
      if (typeof c === "string") {
        const t = c.replace(/<[^>]+>/g, "").trim();
        if (t) return t.length > 100 ? t.slice(0, 100) + "\u2026" : t;
      } else if (Array.isArray(c)) {
        for (const block of c) {
          if (block?.type === "text" && typeof block.text === "string") {
            const t = block.text.replace(/<[^>]+>/g, "").trim();
            if (t) return t.length > 100 ? t.slice(0, 100) + "\u2026" : t;
          }
        }
      }
    }
  }
  return "(no user message)";
}

export const opencodeProvider: Provider = {
  id: "opencode",
  label: "OpenCode",

  async listProjects(): Promise<ProjectInfo[]> {
    const d = getDb();
    if (!d) return [];

    const dbProjects = queryAll<OpenCodeProjectRow>(
      "SELECT id, worktree, name FROM project ORDER BY name",
    );

    if (dbProjects.length > 0) {
      const projects: ProjectInfo[] = dbProjects
        .map((p): ProjectInfo | null => {
          const rows = queryAll<{ cnt: number; latest: number }>(
            "SELECT COUNT(*) as cnt, COALESCE(MAX(time_created), 0) as latest FROM session WHERE project_id = ?",
            [p.id],
          );
          const cnt = rows[0]?.cnt ?? 0;
          if (cnt === 0) return null;
          const latest = rows[0]?.latest ?? 0;
          return {
            slug: p.id,
            path: p.worktree ?? p.name ?? p.id,
            sessionCount: cnt,
            latestMtimeMs: latest,
            agent: "opencode",
          } as ProjectInfo;
        })
        .filter((p): p is ProjectInfo => p !== null);
      return projects.sort((a, b) => b.latestMtimeMs - a.latestMtimeMs);
    }

    // Fallback: flat list of all sessions
    const rows = queryAll<{ cnt: number; latest: number }>(
      "SELECT COUNT(*) as cnt, COALESCE(MAX(time_created), 0) as latest FROM session",
    );
    const cnt = rows[0]?.cnt ?? 0;
    const latest = rows[0]?.latest ?? 0;
    if (cnt === 0) return [];

    return [
      {
        slug: "sessions",
        path: "~/.local/share/opencode",
        sessionCount: cnt,
        latestMtimeMs: latest,
        agent: "opencode",
      } as ProjectInfo,
    ];
  },

  async listSessions(projectSlug: string): Promise<SessionListItem[]> {
    const d = getDb();
    if (!d) return [];

    const projectFilter = projectSlug;

    let sessionRows: OpenCodeSessionRow[];
    if (projectFilter !== "sessions") {
      sessionRows = queryAll<OpenCodeSessionRow>(
        "SELECT id, project_id, agent, model, title, tokens_input, tokens_output, cost, directory, slug FROM session WHERE project_id = ? ORDER BY time_created DESC",
        [projectFilter],
      );
    } else {
      sessionRows = queryAll<OpenCodeSessionRow>(
        "SELECT id, project_id, agent, model, title, tokens_input, tokens_output, cost, directory, slug FROM session ORDER BY time_created DESC",
      );
    }

    return sessionRows.map((s) => {
      const { records } = opencodeRecordsForSession(s.id);
      const title = extractOpenCodeTitle(s.title, records);
      const realTotal =
        (s.tokens_input ?? 0) > 0 ? s.tokens_input : null;

      return {
        id: `opencode:${s.id}`,
        project: projectSlug,
        projectPath: s.directory ?? s.slug ?? s.project_id ?? "~/.local/share/opencode",
        filePath: `opencode://${s.id}`,
        mtimeMs: Date.now(),
        title,
        realTotal,
        model: s.model ?? null,
        hasCompaction: false,
        agent: "opencode",
      } as SessionListItem;
    });
  },

  async findSessionById(sessionId: string): Promise<string | null> {
    const d = getDb();
    if (!d) return null;
    const row = queryOne<OpenCodeSessionRow>(
      "SELECT id FROM session WHERE id = ?",
      [sessionId],
    );
    return row ? `opencode://${row.id}` : null;
  },

  async indexSessionFile(filePath: string): Promise<SessionMeta> {
    const sessionId = filePath.replace("opencode://", "");
    const session = queryOne<OpenCodeSessionRow>(
      "SELECT id, project_id, agent, model, title, tokens_input, tokens_output, cost, directory, slug FROM session WHERE id = ?",
      [sessionId],
    );
    const { records, model } = opencodeRecordsForSession(sessionId);
    const title = extractOpenCodeTitle(session?.title ?? null, records);

    const inputTokens = session?.tokens_input ?? 0;
    const outputTokens = session?.tokens_output ?? 0;
    const realTotal = inputTokens > 0 ? inputTokens : null;

    return {
      id: sessionId,
      title,
      realTotal,
      model: model ?? session?.model ?? null,
      hasCompaction: false,
      inputTokens,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      outputTokens,
      cwd: null,
    };
  },

  async computeSnapshot(filePath: string, knownMtimeMs?: number) {
    const sessionId = filePath.replace("opencode://", "");
    const mtimeMs = knownMtimeMs ?? Date.now();
    const { records } = opencodeRecordsForSession(sessionId);
    return buildSnapshot(records, sessionId, filePath, mtimeMs);
  },
};
