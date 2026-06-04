import { readdir, stat, readFile } from "node:fs/promises";
import { join, basename } from "node:path";
import { HERMES_SESSIONS_DIR } from "../paths.ts";
import { buildSnapshot } from "../snapshot.ts";
import { countTokens } from "../tokenizer.ts";
import type { ProjectInfo, SessionListItem } from "../types.ts";
import type { Provider, SessionMeta, NormalizedRecord } from "./types.ts";

function extractHermesTitle(records: NormalizedRecord[]): string {
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

type HermesLine = {
  role?: string;
  content?: string;
  tool_calls?: Array<{
    id?: string;
    type?: string;
    function?: { name?: string; arguments?: string };
  }>;
  tool_call_id?: string;
  name?: string;
  reasoning?: string;
  model?: string;
  timestamp?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
    prompt_tokens?: number;
    completion_tokens?: number;
  };
};

function normalizeHermesRecords(lines: HermesLine[]): {
  records: NormalizedRecord[];
  model: string | null;
} {
  const records: NormalizedRecord[] = [];
  let model: string | null = null;

  for (const line of lines) {
    if (line.model) model = line.model;

    if (line.role === "user") {
      const contentBlocks: any[] = [];
      if (line.content) {
        contentBlocks.push({ type: "text", text: line.content });
      }
      records.push({
        type: "user",
        message: { content: contentBlocks },
      });
    } else if (line.role === "assistant") {
      const contentBlocks: any[] = [];

      if (line.reasoning) {
        contentBlocks.push({ type: "thinking", thinking: line.reasoning });
      }
      if (line.content) {
        contentBlocks.push({ type: "text", text: line.content });
      }
      if (line.tool_calls) {
        for (const tc of line.tool_calls) {
          if (tc?.function) {
            contentBlocks.push({
              type: "tool_use",
              id: tc.id ?? `hermes_tc_${Math.random().toString(36).slice(2, 8)}`,
              name: tc.function.name ?? "unknown",
              input: parseArgs(tc.function.arguments),
            });
          }
        }
      }

      const usage: Record<string, number> | undefined = line.usage
        ? {
            input_tokens: line.usage.input_tokens ?? line.usage.prompt_tokens ?? 0,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
            output_tokens: line.usage.output_tokens ?? line.usage.completion_tokens ?? 0,
          }
        : undefined;

      records.push({
        type: "assistant",
        message: {
          content: contentBlocks,
          usage,
          model: line.model ?? model ?? undefined,
        },
      });
    } else if (line.role === "tool") {
      const contentBlocks: any[] = [];
      let toolContent: any = line.content ?? "";
      contentBlocks.push({
        type: "tool_result",
        tool_use_id: line.tool_call_id ?? `hermes_tr_${Math.random().toString(36).slice(2, 8)}`,
        content: toolContent,
      });
      records.push({
        type: "user",
        message: { content: contentBlocks },
      });
    }
  }

  return { records, model };
}

function parseArgs(args: unknown): unknown {
  if (typeof args === "string") {
    try {
      return JSON.parse(args);
    } catch {
      return args;
    }
  }
  return args;
}

function computeLocalUsage(records: NormalizedRecord[]): Record<string, number> | null {
  let totalInput = 0;
  let totalOutput = 0;
  for (const r of records) {
    if (r.message?.usage) {
      return null;
    }
    const content = r.message?.content;
    const blocks = typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? content : [];
    let recordTokens = 0;
    for (const b of blocks) {
      if (b?.type === "text" && b.text) recordTokens += countTokens(b.text);
      else if (b?.type === "thinking" && b.thinking) recordTokens += countTokens(b.thinking);
      else if (b?.type === "tool_use" && b.name) {
        recordTokens += countTokens(b.name);
        if (b.input) recordTokens += countTokens(JSON.stringify(b.input));
      }
      else if (b?.type === "tool_result") {
        const c = b.content;
        if (typeof c === "string") recordTokens += countTokens(c);
        else if (Array.isArray(c)) {
          for (const cb of c) {
            if (typeof cb === "string") recordTokens += countTokens(cb);
            else if (cb?.text) recordTokens += countTokens(cb.text);
          }
        }
      }
    }
    if (r.type === "assistant") {
      totalOutput += recordTokens;
    } else {
      totalInput += recordTokens;
    }
  }
  return { input_tokens: totalInput, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: totalOutput };
}

async function readHermesFile(filePath: string): Promise<{
  records: NormalizedRecord[];
  model: string | null;
}> {
  const content = await readFile(filePath, "utf8");
  const lines: HermesLine[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      lines.push(JSON.parse(trimmed));
    } catch {}
  }
  const { records, model } = normalizeHermesRecords(lines);

  if (!records.some((r) => r.message?.usage)) {
    const localUsage = computeLocalUsage(records);
    if (localUsage) {
      for (let i = records.length - 1; i >= 0; i--) {
        const rec = records[i];
        if (rec?.type === "assistant") {
          rec.message ??= {};
          rec.message.usage = localUsage;
          break;
        }
      }
    }
  }

  return { records, model };
}

async function indexHermesFile(filePath: string): Promise<SessionMeta> {
  const id = basename(filePath, ".jsonl");
  const { records, model } = await readHermesFile(filePath);
  const title = extractHermesTitle(records);

  let realTotal: number | null = null;
  let inputTokens = 0;
  let cacheCreationTokens = 0;
  let cacheReadTokens = 0;
  let outputTokens = 0;

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
    hasCompaction: false,
    inputTokens,
    cacheCreationTokens,
    cacheReadTokens,
    outputTokens,
    cwd: null,
  };
}

export const hermesProvider: Provider = {
  id: "hermes",
  label: "Hermes",

  async listProjects(): Promise<ProjectInfo[]> {
    let files: string[];
    try {
      files = (await readdir(HERMES_SESSIONS_DIR)).filter((f) => f.endsWith(".jsonl"));
    } catch {
      return [];
    }
    if (files.length === 0) return [];
    const mtimes = await Promise.all(
      files.map(async (f) => {
        try {
          return (await stat(join(HERMES_SESSIONS_DIR, f))).mtimeMs;
        } catch {
          return 0;
        }
      }),
    );
    const latest = Math.max(...mtimes, 0);
    return [
      {
        slug: "hermes",
        path: "~/.hermes",
        sessionCount: files.length,
        latestMtimeMs: latest,
        agent: "hermes",
      } as ProjectInfo,
    ];
  },

  async listSessions(projectSlug: string): Promise<SessionListItem[]> {
    if (projectSlug !== "hermes") return [];
    let files: string[];
    try {
      files = (await readdir(HERMES_SESSIONS_DIR)).filter((f) => f.endsWith(".jsonl"));
    } catch {
      return [];
    }
    const items = await Promise.all(
      files.map(async (f): Promise<SessionListItem | null> => {
        const filePath = join(HERMES_SESSIONS_DIR, f);
        let st;
        try {
          st = await stat(filePath);
        } catch {
          return null;
        }
        try {
          const meta = await indexHermesFile(filePath);
          return {
            id: `hermes:${meta.id}`,
            project: projectSlug,
            projectPath: "~/.hermes",
            filePath,
            mtimeMs: st.mtimeMs,
            title: meta.title,
            realTotal: meta.realTotal,
            model: meta.model,
            hasCompaction: false,
            agent: "hermes",
          } as SessionListItem;
        } catch {
          return {
            id: `hermes:${basename(f, ".jsonl")}`,
            project: projectSlug,
            projectPath: "~/.hermes",
            filePath,
            mtimeMs: st.mtimeMs,
            title: "(failed to read)",
            realTotal: null,
            model: null,
            hasCompaction: false,
            agent: "hermes",
          };
        }
      }),
    );
    return items
      .filter((x): x is SessionListItem => x !== null)
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
  },

  async findSessionById(sessionId: string): Promise<string | null> {
    const candidate = join(HERMES_SESSIONS_DIR, `${sessionId}.jsonl`);
    try {
      await stat(candidate);
      return candidate;
    } catch {
      return null;
    }
  },

  async indexSessionFile(filePath: string): Promise<SessionMeta> {
    return indexHermesFile(filePath);
  },

  async computeSnapshot(filePath: string, knownMtimeMs?: number) {
    const mtimeMs = knownMtimeMs ?? (await stat(filePath)).mtimeMs;
    const sessionId = basename(filePath, ".jsonl");
    const { records } = await readHermesFile(filePath);
    return buildSnapshot(records, sessionId, filePath, mtimeMs);
  },
};
