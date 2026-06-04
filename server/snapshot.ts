import { stat } from "node:fs/promises";
import { basename } from "node:path";
import { readAllJSONL } from "./jsonl.ts";
import { countTokens, countJSONTokens } from "./tokenizer.ts";
import {
  SNAPSHOT_SCHEMA_VERSION,
  type Snapshot,
  type Bucket,
  type LeafItem,
  type CompactionInfo,
  type Headline,
} from "./types.ts";
import { realTotalFromUsage } from "./usage.ts";
import type { NormalizedRecord } from "./providers/types.ts";

const MAX_CONTENT_CHARS = 50_000;

const CL100K_TO_CLAUDE = 1.18;
const SIGNATURE_TOKEN_RATIO = 0.33;

type ChildAccum = {
  name: string;
  tokens: number;
  items: LeafItem[];
};

function buildBucket(
  id: string,
  name: string,
  children: Record<string, ChildAccum>,
  opts: { sort?: boolean; skipEmpty?: boolean } = {},
): Bucket {
  const bucket: Bucket = { id, name, tokens: 0, children: [] };
  for (const [childId, c] of Object.entries(children)) {
    if (opts.skipEmpty && c.tokens === 0 && c.items.length === 0) continue;
    bucket.children.push({ id: childId, name: c.name, tokens: c.tokens, items: c.items });
    bucket.tokens += c.tokens;
  }
  if (opts.sort) bucket.children.sort((a, b) => b.tokens - a.tokens);
  return bucket;
}

function scaleBuckets(buckets: Bucket[], factor: number): void {
  for (const b of buckets) {
    let bSum = 0;
    for (const c of b.children) {
      let cSum = 0;
      for (const it of c.items) {
        it.tokens = Math.round(it.tokens * factor);
        cSum += it.tokens;
      }
      c.tokens = cSum;
      bSum += cSum;
    }
    b.tokens = bSum;
  }
}

function formatToolInput(input: unknown): string {
  if (input == null) return "";
  try {
    const s = typeof input === "string" ? input : JSON.stringify(input, null, 2);
    return s.slice(0, MAX_CONTENT_CHARS);
  } catch {
    return String(input).slice(0, MAX_CONTENT_CHARS);
  }
}

function modelCapFor(model: string | null): number {
  if (!model) return 200_000;
  const m = model.toLowerCase();
  if (m.includes("opus")) return 1_000_000;
  if (m.includes("sonnet")) return m.includes("1m") ? 1_000_000 : 200_000;
  if (m.includes("haiku")) return 200_000;
  return 200_000;
}

const ANSI_RE = /\x1B\[[0-9;]*[A-Za-z]/g;
function stripAnsi(s: string): string {
  if (typeof s !== "string") return String(s);
  return s.replace(ANSI_RE, "");
}

function blockText(block: any): string {
  if (typeof block === "string") return block;
  if (block == null || typeof block !== "object") return "";
  if (block.type === "tool_use") {
    return `${block.name ?? ""}\n${JSON.stringify(block.input ?? {})}`;
  }
  if (block.type === "tool_result") {
    if (typeof block.content === "string") return block.content;
    if (Array.isArray(block.content)) {
      return block.content
        .map((b: any) => {
          if (typeof b === "string") return b;
          if (b?.type === "text") return b.text ?? "";
          if (b?.type === "image") return "[image]";
          if (b?.type === "tool_reference") return `[tool: ${b.tool_name ?? ""}]`;
          return JSON.stringify(b);
        })
        .join("\n");
    }
    if (block.content != null) return JSON.stringify(block.content);
    return "";
  }
  if (block.type === "text") {
    const t = block.text;
    return t != null && typeof t === "string" ? t : t != null ? JSON.stringify(t) : "";
  }
  if (block.type === "thinking") {
    const plain = block.thinking ?? block.text ?? "";
    if (typeof plain === "string" && plain) return plain;
    if (typeof block.signature === "string" && block.signature.length > 0) {
      return block.signature;
    }
    return "";
  }
  if (block.type === "image") return "[image]";
  return JSON.stringify(block);
}

function attachmentText(rec: any): string {
  const a = rec?.attachment;
  if (!a) return "";
  if (typeof a === "string") return a;
  if (typeof a.text === "string") return a.text;
  if (a.type === "file" && a.file && typeof a.file.content === "string") return a.file.content;
  if (a.content && typeof a.content === "object" && a.content.file && typeof a.content.file.content === "string") {
    return a.content.file.content;
  }
  if (typeof a.snippet === "string") return a.snippet;
  if (Array.isArray(a.content)) {
    return a.content
      .map((b: any) => {
        if (typeof b === "string") return b;
        if (b?.type === "text" && typeof b.text === "string") return b.text;
        if (b && typeof b === "object" && (b.subject || b.id)) {
          const status = b.status ? `[${b.status}] ` : "";
          const subj = b.subject ?? b.id ?? "";
          const desc = b.description ? ` \u2014 ${b.description}` : "";
          return `${status}${subj}${desc}`;
        }
        return JSON.stringify(b);
      })
      .join("\n");
  }
  if (a.content && typeof a.content === "object" && Array.isArray(a.content.contents)) {
    return a.content.contents
      .map((c: any) => (typeof c?.text === "string" ? c.text : JSON.stringify(c)))
      .join("\n");
  }
  if (a.content && typeof a.content === "object" && typeof a.content.content === "string") {
    return a.content.content;
  }
  if (typeof a.content === "string") return a.content;
  if (typeof a.body === "string") return a.body;
  if (typeof a.output === "string") return a.output;
  if (typeof a.value === "string") return a.value;
  if (typeof a.prompt === "string") return a.prompt;
  if (typeof a.condition === "string") return a.condition;
  if (Array.isArray(a.addedBlocks)) {
    return a.addedBlocks
      .map((b: any) => (typeof b === "string" ? b : typeof b?.text === "string" ? b.text : JSON.stringify(b)))
      .join("\n");
  }
  if (Array.isArray(a.addedLines)) return a.addedLines.join("\n");
  if (Array.isArray(a.addedNames) || Array.isArray(a.removedNames)) {
    const added = Array.isArray(a.addedNames) ? a.addedNames.join(",") : "";
    const removed = Array.isArray(a.removedNames) ? a.removedNames.join(",") : "";
    return [added && `+${added}`, removed && `-${removed}`].filter(Boolean).join("\n");
  }
  if (Array.isArray(a.skills)) {
    return a.skills.map((s: any) => (typeof s === "string" ? s : JSON.stringify(s))).join("\n");
  }
  return JSON.stringify(a);
}

function attachmentLabel(rec: any): string {
  const a = rec?.attachment ?? {};
  if (a.type === "file") {
    if (typeof a.filename === "string") return `file: ${a.filename}`;
    if (a.file && typeof a.file.filePath === "string") return `file: ${a.file.filePath}`;
    return "file";
  }
  if (typeof a.type === "string") return a.type;
  if (typeof a.filename === "string") return a.filename;
  if (typeof a.path === "string") return a.path;
  if (typeof a.name === "string") return a.name;
  return "attachment";
}

function summarize(s: unknown, max = 120): string {
  if (s == null) return "";
  let str: string;
  if (typeof s === "string") {
    str = s;
  } else {
    try { str = JSON.stringify(s); } catch { str = String(s); }
  }
  if (!str) return "";
  const oneLine = stripAnsi(str).replace(/\s+/g, " ").trim();
  if (oneLine.length <= max) return oneLine;
  return oneLine.slice(0, max) + "\u2026";
}

function toolUseSummary(name: string, input: any): string {
  if (!input || typeof input !== "object") return name;
  const i = input as Record<string, any>;
  if (typeof i.file_path === "string") {
    let s = `${name} ${i.file_path}`;
    if (typeof i.limit === "number" || typeof i.offset === "number") {
      s += ` (offset=${i.offset ?? 0} limit=${i.limit ?? "-"})`;
    }
    if (typeof i.pages === "string") s += ` pages=${i.pages}`;
    return s;
  }
  if (typeof i.path === "string") return `${name} ${i.path}`;
  if (typeof i.command === "string") return `${name} ${summarize(i.command, 80)}`;
  if (typeof i.query === "string") return `${name} ${summarize(i.query, 80)}`;
  if (typeof i.pattern === "string") return `${name} ${summarize(i.pattern, 80)}`;
  if (typeof i.url === "string") return `${name} ${i.url}`;
  if (typeof i.prompt === "string") return `${name} ${summarize(i.prompt, 80)}`;
  if (Array.isArray(i.questions) && i.questions[0]?.question) {
    return `${name} ${summarize(i.questions[0].question, 80)}`;
  }
  if (typeof i.subject === "string") return `${name} ${summarize(i.subject, 80)}`;
  if (typeof i.taskId === "string") {
    const status = typeof i.status === "string" ? ` \u2192 ${i.status}` : "";
    return `${name} #${i.taskId}${status}`;
  }
  if (typeof i.element === "string") return `${name} ${summarize(i.element, 80)}`;
  if (typeof i.text === "string") return `${name} ${summarize(i.text, 80)}`;
  if (typeof i.key === "string") return `${name} ${i.key}`;
  if (typeof i.filename === "string") return `${name} \u2192 ${i.filename}`;
  if (typeof i.level === "string") return `${name} level=${i.level}`;
  if (typeof i.description === "string") return `${name} ${summarize(i.description, 80)}`;
  return name;
}

export function buildSnapshot(
  records: NormalizedRecord[],
  sessionId: string,
  filePath: string,
  mtimeMs: number,
): Snapshot {
  const warnings: string[] = [];

  // 1. Find latest assistant with usage (the anchor)
  let latestAssistantIdx = -1;
  let usage: any = null;
  let model: string | null = null;
  for (let i = records.length - 1; i >= 0; i--) {
    const r = records[i];
    if (r?.type === "assistant" && r?.message?.usage) {
      const u = r.message.usage;
      const total = realTotalFromUsage(u);
      if (total > 0) {
        latestAssistantIdx = i;
        usage = u;
        model = r.message.model ?? null;
        break;
      }
    }
  }

  // 2. Find compaction boundaries
  let latestBoundaryIdx = -1;
  let compaction: CompactionInfo | null = null;
  let boundaryCount = 0;
  const anchorIdx = latestAssistantIdx === -1 ? records.length : latestAssistantIdx;
  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    if (r?.type === "system" && r?.subtype === "compact_boundary") {
      boundaryCount++;
      if (i < anchorIdx && i > latestBoundaryIdx) {
        latestBoundaryIdx = i;
        compaction = {
          boundaryCount: 0,
          latestBoundaryAt: i,
          preTokens: r?.compactMetadata?.preTokens ?? 0,
          postTokens: r?.compactMetadata?.postTokens ?? 0,
          trigger: r?.compactMetadata?.trigger ?? "unknown",
        };
      }
    }
  }
  if (compaction) compaction.boundaryCount = boundaryCount;

  if (latestAssistantIdx === -1) {
    warnings.push("No assistant message with usage found.");
    return {
      schemaVersion: SNAPSHOT_SCHEMA_VERSION,
      sessionId,
      filePath,
      mtimeMs,
      headline: {
        realTotal: 0,
        modelCap: modelCapFor(model),
        model: model ?? "unknown",
        inputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        outputTokens: 0,
      },
      buckets: [],
      compaction,
      warnings,
    };
  }

  const realTotal = realTotalFromUsage(usage);
  const headline: Headline = {
    realTotal,
    modelCap: modelCapFor(model),
    model: model ?? "unknown",
    inputTokens: usage.input_tokens ?? 0,
    cacheCreationTokens: usage.cache_creation_input_tokens ?? 0,
    cacheReadTokens: usage.cache_read_input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
  };

  // 3. Walk records from latestBoundary+1 up to latestAssistantIdx (exclusive)
  const startIdx = latestBoundaryIdx + 1;
  const endIdx = latestAssistantIdx;

  const messagesChildren: Record<string, ChildAccum> = {
    user: { name: "User messages", tokens: 0, items: [] },
    thinking: { name: "Thinking", tokens: 0, items: [] },
    assistant: { name: "Assistant text", tokens: 0, items: [] },
  };
  const toolCallsChildren: Record<string, ChildAccum> = {};
  const toolResultsChildren: Record<string, ChildAccum> = {};
  const attachmentsChildren: Record<string, ChildAccum> = {};

  const toolUseIdToName = new Map<string, string>();
  const toolUseIdToInput = new Map<string, unknown>();
  for (let i = startIdx; i < endIdx; i++) {
    const r = records[i];
    if (r?.type === "assistant" && Array.isArray(r?.message?.content)) {
      for (const block of r.message.content) {
        if (block?.type === "tool_use" && block?.id) {
          toolUseIdToName.set(block.id, block.name ?? "unknown");
          toolUseIdToInput.set(block.id, block.input ?? {});
        }
      }
    }
  }

  let userTurnCounter = 0;
  let assistantTurnCounter = 0;

  for (let i = startIdx; i < endIdx; i++) {
    const r = records[i];
    if (!r) continue;
    if (r.type === "user" && r.message?.content) {
      const c = r.message.content;
      const blocks: any[] = typeof c === "string" ? [{ type: "text", text: c }] : Array.isArray(c) ? c : [];
      userTurnCounter++;
      for (const block of blocks) {
        if (block?.type === "tool_result") {
          const tname = toolUseIdToName.get(block.tool_use_id) ?? "unknown";
          const text = blockText(block);
          const tokens = countTokens(text);
          const child =
            toolResultsChildren[tname] ?? (toolResultsChildren[tname] = { name: tname, tokens: 0, items: [] });
          child.tokens += tokens;
          child.items.push({
            tokens,
            turn: userTurnCounter,
            summary: `${tname} result${block.is_error ? " (error)" : ""}`,
            fullContent: text.slice(0, MAX_CONTENT_CHARS),
            toolInput: toolUseIdToInput.has(block.tool_use_id)
              ? formatToolInput(toolUseIdToInput.get(block.tool_use_id))
              : undefined,
          });
        } else if (block?.type === "text") {
          const text = block.text ?? "";
          const tokens = countTokens(text);
          const child = messagesChildren.user!;
          child.tokens += tokens;
          child.items.push({
            tokens,
            turn: userTurnCounter,
            summary: summarize(text),
            fullContent: text.slice(0, MAX_CONTENT_CHARS),
          });
        } else if (block?.type === "image") {
          const child = messagesChildren.user!;
          child.items.push({
            tokens: 0,
            turn: userTurnCounter,
            summary: "[image]",
            fullContent: "[image]",
          });
        }
      }
    } else if (r.type === "assistant" && r.message?.content) {
      const blocks: any[] = Array.isArray(r.message.content) ? r.message.content : [];
      assistantTurnCounter++;
      let nonThinkOutputTokens = 0;
      let totalSigLen = 0;
      const sigPerBlock: number[] = [];
      for (const block of blocks) {
        if (block?.type === "text") {
          nonThinkOutputTokens += countTokens(block.text ?? "");
        } else if (block?.type === "tool_use") {
          nonThinkOutputTokens +=
            countJSONTokens(block.input ?? {}) + countTokens(block.name ?? "");
        } else if (block?.type === "thinking") {
          const sig = typeof block.signature === "string" ? block.signature.length : 0;
          sigPerBlock.push(sig);
          totalSigLen += sig;
        }
      }
      const turnOutputTokens =
        typeof r.message?.usage?.output_tokens === "number"
          ? r.message.usage.output_tokens
          : null;
      const thinkingBudget = turnOutputTokens != null
        ? Math.max(0, turnOutputTokens - nonThinkOutputTokens)
        : null;

      let thinkingBlockIdx = 0;
      for (const block of blocks) {
        if (block?.type === "text") {
          const text = block.text ?? "";
          const tokens = countTokens(text);
          const child = messagesChildren.assistant!;
          child.tokens += tokens;
          child.items.push({
            tokens,
            turn: assistantTurnCounter,
            summary: summarize(text),
            fullContent: text.slice(0, MAX_CONTENT_CHARS),
          });
        } else if (block?.type === "thinking") {
          const plain: string = block.thinking ?? block.text ?? "";
          const sig: string = typeof block.signature === "string" ? block.signature : "";
          let tokens = 0;
          let summary = "[thinking]";
          let fullContent = "";
          if (plain) {
            tokens = countTokens(plain);
            summary = summarize(plain) || "[thinking]";
            fullContent = plain.slice(0, MAX_CONTENT_CHARS);
          } else if (sig) {
            if (thinkingBudget != null && totalSigLen > 0) {
              const share = sigPerBlock[thinkingBlockIdx] / totalSigLen;
              tokens = Math.round(thinkingBudget * share);
            } else {
              tokens = Math.round(sig.length * SIGNATURE_TOKEN_RATIO);
            }
            summary = `[encrypted reasoning \u00b7 ~${tokens.toLocaleString()} tok]`;
            fullContent =
              `(Reasoning is encrypted by Claude; only an opaque signature is visible.)\n\n` +
              `signature length: ${sig.length.toLocaleString()} chars\n` +
              (thinkingBudget != null
                ? `derived from this turn's output_tokens (${turnOutputTokens}) minus visible content (${nonThinkOutputTokens}).`
                : `estimated as signature_length \u00d7 ${SIGNATURE_TOKEN_RATIO}.`);
            thinkingBlockIdx++;
          } else {
            thinkingBlockIdx++;
          }
          const child = messagesChildren.thinking!;
          child.tokens += tokens;
          child.items.push({
            tokens,
            turn: assistantTurnCounter,
            summary,
            fullContent,
          });
        } else if (block?.type === "tool_use") {
          const tname = block.name ?? "unknown";
          const tokens = countJSONTokens(block.input ?? {}) + countTokens(tname);
          const child =
            toolCallsChildren[tname] ?? (toolCallsChildren[tname] = { name: tname, tokens: 0, items: [] });
          child.tokens += tokens;
          child.items.push({
            tokens,
            turn: assistantTurnCounter,
            summary: toolUseSummary(tname, block.input),
            fullContent: "",
            toolInput: formatToolInput(block.input ?? {}),
          });
        }
      }
    } else if (r.type === "attachment") {
      const text = attachmentText(r);
      const tokens = countTokens(text);
      const label = attachmentLabel(r);
      const child =
        attachmentsChildren[label] ?? (attachmentsChildren[label] = { name: label, tokens: 0, items: [] });
      child.tokens += tokens;
      child.items.push({
        tokens,
        turn: 0,
        summary: label,
        fullContent: text.slice(0, MAX_CONTENT_CHARS),
      });
    }
  }
  // 4. Build buckets
  const messagesBucket = buildBucket("messages", "Messages", messagesChildren, { skipEmpty: true });
  const toolCallsBucket = buildBucket("tool_calls", "Tool calls", toolCallsChildren, { sort: true });
  const toolResultsBucket = buildBucket("tool_results", "Tool results", toolResultsChildren, { sort: true });
  const attachmentsBucket = buildBucket("attachments", "Attachments", attachmentsChildren, { sort: true });

  const idBuckets = [messagesBucket, toolCallsBucket, toolResultsBucket, attachmentsBucket];
  scaleBuckets(idBuckets, CL100K_TO_CLAUDE);

  const identifiedSumRaw = idBuckets.reduce((sum, b) => sum + b.tokens, 0);

  let scale = 1;
  if (identifiedSumRaw > realTotal && identifiedSumRaw > 0) {
    scale = realTotal / identifiedSumRaw;
    warnings.push(
      `Identified buckets (${identifiedSumRaw.toLocaleString()}) exceed realTotal (${realTotal.toLocaleString()}). ` +
        `Scaled by ${(scale * 100).toFixed(1)}% to fit; residual = 0.`,
    );
    scaleBuckets(idBuckets, scale);
  }

  const identifiedSum = idBuckets.reduce((sum, b) => sum + b.tokens, 0);
  const residual = Math.max(0, realTotal - identifiedSum);

  const systemBucket: Bucket = {
    id: "system",
    name: "System prompt + tool schemas",
    tokens: residual,
    children: [
      {
        id: "system_residual",
        name: "System prompt + tool schemas (estimated)",
        tokens: residual,
        items: [
          {
            tokens: residual,
            turn: 0,
            summary: "System prompt + tool-schema definitions + harness overhead",
            fullContent:
              `This bucket is computed as a residual: realTotal \u2212 \u03a3(identified buckets).\n\n` +
              `It primarily reflects:\n` +
              `  \u2022 The system prompt (~3-6k tokens, version-dependent).\n` +
              `  \u2022 Tool schema JSON sent to the model (~5-25k typical; ~15k+ when MCP bundles like\n` +
              `    Playwright / Chrome DevTools are loaded).\n` +
              `  \u2022 Per-message wrapper overhead (role markers, tool-call envelopes).\n\n` +
              `Token counts use cl100k_base \u00d7 ${CL100K_TO_CLAUDE} calibration to approximate Claude's BPE. ` +
              `For exact counts, use Anthropic's /v1/messages/count_tokens API (free, requires key).\n\n` +
              `realTotal: ${realTotal}\n` +
              `identifiedSum: ${identifiedSum}\n` +
              `residual: ${residual}\n` +
              (scale !== 1 ? `bucket scale: ${(scale * 100).toFixed(2)}%\n` : ""),
          },
        ],
      },
    ],
  };

  const buckets: Bucket[] = [
    systemBucket,
    messagesBucket,
    toolCallsBucket,
    toolResultsBucket,
    attachmentsBucket,
  ].filter((b) => b.tokens > 0 || b.children.length > 0);

  return {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    sessionId,
    filePath,
    mtimeMs,
    headline,
    buckets,
    compaction,
    warnings,
  };
}

// Legacy entry point for direct JSONL reading (Claude Code).
export async function computeSnapshot(filePath: string, knownMtimeMs?: number): Promise<Snapshot> {
  const mtimeMs = knownMtimeMs ?? (await stat(filePath)).mtimeMs;
  const sessionId = basename(filePath, ".jsonl");
  const records = await readAllJSONL(filePath);
  return buildSnapshot(records, sessionId, filePath, mtimeMs);
}
