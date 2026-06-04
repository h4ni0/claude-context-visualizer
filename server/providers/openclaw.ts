import { readdir, readFile, stat } from "node:fs/promises";
import { join, basename } from "node:path";
import { OPENCLAW_SESSIONS_DIR, OPENCLAW_SESSIONS_INDEX } from "../paths.ts";
import { streamJSONL, readAllJSONL } from "../jsonl.ts";
import { buildSnapshot } from "../snapshot.ts";
import type { ProjectInfo, SessionListItem } from "../types.ts";
import type { Provider, SessionMeta, NormalizedRecord } from "./types.ts";

function extractOpenClawTitle(records: NormalizedRecord[]): string {
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

async function readOpenClawRecords(filePath: string): Promise<{
  records: NormalizedRecord[];
  model: string | null;
  cwd: string | null;
}> {
  const records: NormalizedRecord[] = [];
  let currentModel: string | null = null;
  let cwd: string | null = null;
  let messageIdx = 0;

  await streamJSONL(filePath, (obj) => {
    if (obj?.type === "message") {
      const msg = obj.message;
      if (!msg?.role) return;
      const role = msg.role === "assistant" ? "assistant" : "user";
      const usage = msg.usage;
      let normalizedUsage: Record<string, number> | undefined;
      if (usage) {
        normalizedUsage = {
          input_tokens: usage.inputTokens ?? 0,
          cache_creation_input_tokens: usage.cacheCreationInputTokens ?? 0,
          cache_read_input_tokens: usage.cacheReadInputTokens ?? 0,
          output_tokens: usage.outputTokens ?? 0,
        };
      }
      const content = msg.content ?? (typeof msg.text === "string" ? msg.text : "");
      records.push({
        type: role,
        message: {
          content,
          usage: normalizedUsage,
          model: currentModel ?? undefined,
        },
      });
      if (role === "user") messageIdx++;
    } else if (obj?.type === "model_change") {
      currentModel = obj.model ?? null;
    } else if (obj?.type === "session") {
      if (obj?.channel && !cwd) {
        cwd = obj.channel;
      }
    }
  });

  return { records, model: currentModel, cwd };
}

async function indexOpenClawFile(filePath: string): Promise<SessionMeta> {
  const id = basename(filePath, ".jsonl");
  const { records, model } = await readOpenClawRecords(filePath);

  const title = extractOpenClawTitle(records);
  let realTotal: number | null = null;
  let inputTokens = 0;
  let cacheCreationTokens = 0;
  let cacheReadTokens = 0;
  let outputTokens = 0;
  let hasCompaction = false;
  let cwd: string | null = null;

  for (const r of records) {
    if (r.message?.usage) {
      const u = r.message.usage;
      const total = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
      if (total > 0) {
        realTotal = total;
        inputTokens = u.input_tokens ?? 0;
        cacheCreationTokens = u.cache_creation_input_tokens ?? 0;
        cacheReadTokens = u.cache_read_input_tokens ?? 0;
        outputTokens = u.output_tokens ?? 0;
      }
    }
  }

  return {
    id,
    title,
    realTotal,
    model,
    hasCompaction,
    inputTokens,
    cacheCreationTokens,
    cacheReadTokens,
    outputTokens,
    cwd,
  };
}

export const openclawProvider: Provider = {
  id: "openclaw",
  label: "OpenClaw",

  async listProjects(): Promise<ProjectInfo[]> {
    let files: string[];
    try {
      files = (await readdir(OPENCLAW_SESSIONS_DIR)).filter((f) => f.endsWith(".jsonl") && f !== "sessions.json");
    } catch {
      return [];
    }
    if (files.length === 0) return [];

    const mtimes = await Promise.all(
      files.map(async (f) => {
        try {
          return (await stat(join(OPENCLAW_SESSIONS_DIR, f))).mtimeMs;
        } catch {
          return 0;
        }
      }),
    );
    const latest = Math.max(...mtimes, 0);

    return [
      {
        slug: "openclaw",
        path: "~/.openclaw",
        sessionCount: files.length,
        latestMtimeMs: latest,
        agent: "openclaw",
      } as ProjectInfo,
    ];
  },

  async listSessions(projectSlug: string): Promise<SessionListItem[]> {
    if (projectSlug !== "openclaw") return [];
    let files: string[];
    try {
      files = (await readdir(OPENCLAW_SESSIONS_DIR)).filter((f) => f.endsWith(".jsonl") && f !== "sessions.json");
    } catch {
      return [];
    }

    let indexData: Record<string, any> | null = null;
    try {
      const idxContent = await readFile(OPENCLAW_SESSIONS_INDEX, "utf8");
      indexData = JSON.parse(idxContent);
    } catch {}

    const items = await Promise.all(
      files.map(async (f): Promise<SessionListItem | null> => {
        const filePath = join(OPENCLAW_SESSIONS_DIR, f);
        let st;
        try {
          st = await stat(filePath);
        } catch {
          return null;
        }
        try {
          const meta = await indexOpenClawFile(filePath);
          return {
            id: `openclaw:${meta.id}`,
            project: projectSlug,
            projectPath: "~/.openclaw",
            filePath,
            mtimeMs: st.mtimeMs,
            title: meta.title,
            realTotal: meta.realTotal,
            model: meta.model,
            hasCompaction: meta.hasCompaction,
            agent: "openclaw",
          } as SessionListItem;
        } catch {
          return {
            id: `openclaw:${basename(f, ".jsonl")}`,
            project: projectSlug,
            projectPath: "~/.openclaw",
            filePath,
            mtimeMs: st.mtimeMs,
            title: "(failed to read)",
            realTotal: null,
            model: null,
            hasCompaction: false,
            agent: "openclaw",
          };
        }
      }),
    );

    return items
      .filter((x): x is SessionListItem => x !== null)
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
  },

  async findSessionById(sessionId: string): Promise<string | null> {
    const candidate = join(OPENCLAW_SESSIONS_DIR, `${sessionId}.jsonl`);
    try {
      await stat(candidate);
      return candidate;
    } catch {
      return null;
    }
  },

  async indexSessionFile(filePath: string): Promise<SessionMeta> {
    return indexOpenClawFile(filePath);
  },

  async computeSnapshot(filePath: string, knownMtimeMs?: number) {
    const mtimeMs = knownMtimeMs ?? (await stat(filePath)).mtimeMs;
    const sessionId = basename(filePath, ".jsonl");
    const { records } = await readOpenClawRecords(filePath);
    return buildSnapshot(records, sessionId, filePath, mtimeMs);
  },
};
