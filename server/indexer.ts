import { readdir, stat, open } from "node:fs/promises";
import { join, basename } from "node:path";
import { CLAUDE_PROJECTS_DIR, decodeProjectSlug } from "./paths.ts";
import { streamJSONL } from "./jsonl.ts";
import type { SessionListItem, ProjectInfo } from "./types.ts";
import { realTotalFromUsage } from "./usage.ts";
import {
  listAllProjects,
  listSessionsForProject,
  findSessionById as findSessionByIdAgent,
} from "./agents.ts";

const IO_CONCURRENCY = 16;

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const idx = next++;
      results[idx] = await fn(items[idx]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function extractTitle(raw: string): string {
  if (!raw) return "";
  const args = raw.match(/<command-args>([\s\S]*?)<\/command-args>/);
  if (args && args[1] && args[1].trim()) {
    return truncate(args[1].trim());
  }
  const cleaned = raw
    .replace(/<\/?(command|local-command)-[a-z-]+[^>]*>[\s\S]*?<\/(command|local-command)-[a-z-]+>/gi, " ")
    .replace(/<\/?[a-z-]+[^>]*>/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned) return truncate(cleaned);
  const line = raw.split("\n").find((l) => l.trim()) ?? "";
  return truncate(line);
}

function truncate(s: string): string {
  return s.length > 100 ? s.slice(0, 100) + "\u2026" : s;
}

async function firstCwdQuick(filePath: string): Promise<string | null> {
  try {
    const fh = await open(filePath, "r");
    try {
      const buf = Buffer.alloc(32 * 1024);
      const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
      const text = buf.toString("utf8", 0, bytesRead);
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        try {
          const rec = JSON.parse(line);
          if (typeof rec?.cwd === "string") return rec.cwd;
        } catch {}
      }
    } finally {
      await fh.close();
    }
  } catch {}
  return null;
}

// Delegates to the multi-agent registry.
export async function listProjects(): Promise<ProjectInfo[]> {
  return listAllProjects();
}

export async function indexSessionFile(filePath: string): Promise<{
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
}> {
  const id = basename(filePath, ".jsonl");
  let title = "";
  let realTotal: number | null = null;
  let model: string | null = null;
  let inputTokens = 0;
  let cacheCreationTokens = 0;
  let cacheReadTokens = 0;
  let outputTokens = 0;
  let hasCompaction = false;
  let latestUsageOrder = -1;
  let cwd: string | null = null;

  await streamJSONL(filePath, (rec, idx) => {
    if (!cwd && typeof rec?.cwd === "string") cwd = rec.cwd;
    if (rec?.type === "system" && rec?.subtype === "compact_boundary") {
      hasCompaction = true;
    }
    if (!title && rec?.type === "user" && rec?.message?.content) {
      const c = rec.message.content;
      let raw = "";
      if (typeof c === "string") {
        raw = c;
      } else if (Array.isArray(c)) {
        for (const block of c) {
          if (block?.type === "text" && typeof block.text === "string") {
            raw = block.text;
            break;
          }
        }
      }
      title = extractTitle(raw);
    }
    if (rec?.type === "assistant" && rec?.message?.usage && idx > latestUsageOrder) {
      const u = rec.message.usage;
      const it = u.input_tokens ?? 0;
      const cc = u.cache_creation_input_tokens ?? 0;
      const cr = u.cache_read_input_tokens ?? 0;
      const ot = u.output_tokens ?? 0;
      const total = realTotalFromUsage(u);
      if (total > 0) {
        latestUsageOrder = idx;
        realTotal = total;
        inputTokens = it;
        cacheCreationTokens = cc;
        cacheReadTokens = cr;
        outputTokens = ot;
        model = rec.message.model ?? null;
      }
    }
  });

  if (!title) title = "(no user message)";
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

export async function listSessions(projectSlug: string): Promise<SessionListItem[]> {
  return listSessionsForProject(projectSlug);
}

export async function findSessionById(sessionId: string): Promise<string | null> {
  const result = await findSessionByIdAgent(sessionId);
  return result?.filePath ?? null;
}
