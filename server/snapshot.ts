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

// Leaf content and tool inputs are truncated to keep snapshot payloads bounded.
const MAX_CONTENT_CHARS = 50_000;

// cl100k_base systematically UNDER-counts Claude 4.x tokens by ~15-25%
// (verified across multiple sources; ANSI shell output up to 30% under). This
// blanket factor brings identified bucket totals closer to Claude's actual BPE
// counts, shrinking the residual toward the true (system prompt + tool schemas)
// overhead — typically 10-40k.
const CL100K_TO_CLAUDE = 1.18;

// When a thinking block's plaintext is encrypted (only an opaque signature is
// visible), estimate its token cost as signature_length × this ratio.
const SIGNATURE_TOKEN_RATIO = 0.33;

type ChildAccum = {
  name: string;
  tokens: number;
  items: LeafItem[];
};

// Assemble a top-level bucket from its accumulated children. `skipEmpty` drops
// zero-token empty children (used by Messages); `sort` orders children by
// tokens descending (used by the tool/attachment buckets).
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

// Multiply every leaf's tokens by `factor`, re-rolling the sums up to child and
// bucket totals. Used for both the cl100k calibration and the fit-to-realTotal pass.
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

// Pretty-print a tool's input object for display. Falls back to a string cast
// for non-object inputs; truncated to keep the payload bounded.
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

// Strip ANSI escapes for cleaner display in the UI (does NOT affect tokenization,
// which we do on the raw bytes that were actually in the API call).
const ANSI_RE = /\x1B\[[0-9;]*[A-Za-z]/g;
function stripAnsi(s: string): string {
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
    return JSON.stringify(block.content ?? "");
  }
  if (block.type === "text") return block.text ?? "";
  if (block.type === "thinking") {
    // Opus 4.7 stores reasoning encrypted in `signature`; the plaintext
    // `thinking` field is often empty. The signature length is a proxy for
    // the actual reasoning tokens consumed by the model.
    const plain = block.thinking ?? block.text ?? "";
    if (plain) return plain;
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
  // file attachments: content is { type, file: { filePath, content } }
  if (a.type === "file" && a.file && typeof a.file.content === "string") return a.file.content;
  if (a.content && typeof a.content === "object" && a.content.file && typeof a.content.file.content === "string") {
    return a.content.file.content;
  }
  // edited_text_file: contains a snippet of the edit
  if (typeof a.snippet === "string") return a.snippet;
  // task_reminder: content is an array of TODO objects {id, subject, status, ...}
  if (Array.isArray(a.content)) {
    return a.content
      .map((b: any) => {
        if (typeof b === "string") return b;
        if (b?.type === "text" && typeof b.text === "string") return b.text;
        if (b && typeof b === "object" && (b.subject || b.id)) {
          const status = b.status ? `[${b.status}] ` : "";
          const subj = b.subject ?? b.id ?? "";
          const desc = b.description ? ` — ${b.description}` : "";
          return `${status}${subj}${desc}`;
        }
        return JSON.stringify(b);
      })
      .join("\n");
  }
  // MCP resource: content.contents[].text
  if (a.content && typeof a.content === "object" && Array.isArray(a.content.contents)) {
    return a.content.contents
      .map((c: any) => (typeof c?.text === "string" ? c.text : JSON.stringify(c)))
      .join("\n");
  }
  // nested_memory: content.content
  if (a.content && typeof a.content === "object" && typeof a.content.content === "string") {
    return a.content.content;
  }
  if (typeof a.content === "string") return a.content;
  if (typeof a.body === "string") return a.body;
  if (typeof a.output === "string") return a.output;
  if (typeof a.value === "string") return a.value;
  if (typeof a.prompt === "string") return a.prompt;
  if (typeof a.condition === "string") return a.condition;
  // Prefer rich "addedLines" / "addedBlocks" (text) over short names.
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
  // Prefer the canonical `type` so attachments are grouped by category, not
  // by specific filename — except for actual file content where filename is
  // the most informative label.
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

function summarize(s: string, max = 120): string {
  if (!s) return "";
  const oneLine = stripAnsi(s).replace(/\s+/g, " ").trim();
  if (oneLine.length <= max) return oneLine;
  return oneLine.slice(0, max) + "…";
}

function toolUseSummary(name: string, input: any): string {
  if (!input || typeof input !== "object") return name;
  const i = input as Record<string, any>;
  // Path-based tools first
  if (typeof i.file_path === "string") {
    let s = `${name} ${i.file_path}`;
    if (typeof i.limit === "number" || typeof i.offset === "number") {
      s += ` (offset=${i.offset ?? 0} limit=${i.limit ?? "-"})`;
    }
    if (typeof i.pages === "string") s += ` pages=${i.pages}`;
    return s;
  }
  if (typeof i.path === "string") return `${name} ${i.path}`;
  // Bash / general command
  if (typeof i.command === "string") return `${name} ${summarize(i.command, 80)}`;
  // Search
  if (typeof i.query === "string") return `${name} ${summarize(i.query, 80)}`;
  if (typeof i.pattern === "string") return `${name} ${summarize(i.pattern, 80)}`;
  // URL / navigation
  if (typeof i.url === "string") return `${name} ${i.url}`;
  // Agent / prompt-bearing
  if (typeof i.prompt === "string") return `${name} ${summarize(i.prompt, 80)}`;
  // AskUserQuestion
  if (Array.isArray(i.questions) && i.questions[0]?.question) {
    return `${name} ${summarize(i.questions[0].question, 80)}`;
  }
  // Task tools
  if (typeof i.subject === "string") return `${name} ${summarize(i.subject, 80)}`;
  if (typeof i.taskId === "string") {
    const status = typeof i.status === "string" ? ` → ${i.status}` : "";
    return `${name} #${i.taskId}${status}`;
  }
  // Playwright / browser tools
  if (typeof i.element === "string") return `${name} ${summarize(i.element, 80)}`;
  if (typeof i.text === "string") return `${name} ${summarize(i.text, 80)}`;
  if (typeof i.key === "string") return `${name} ${i.key}`;
  if (typeof i.filename === "string") return `${name} → ${i.filename}`;
  if (typeof i.level === "string") return `${name} level=${i.level}`;
  // Fallback: description (lowest priority — many tools have one but it's redundant)
  if (typeof i.description === "string") return `${name} ${summarize(i.description, 80)}`;
  return name;
}

export async function computeSnapshot(filePath: string, knownMtimeMs?: number): Promise<Snapshot> {
  const mtimeMs = knownMtimeMs ?? (await stat(filePath)).mtimeMs;
  const sessionId = basename(filePath, ".jsonl");
  const records = await readAllJSONL(filePath);
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

  // 2. Find compaction boundaries. Honor only the latest boundary that comes
  // BEFORE the anchor assistant message — boundaries after the anchor don't
  // affect what was in context for that call.
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
    // No usage found — return an empty snapshot
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

  // 3. Walk records from latestBoundary+1 up to (but not including) latestAssistantIdx.
  // The latest assistant's content is its OUTPUT (not in its input context).
  const startIdx = latestBoundaryIdx + 1;
  const endIdx = latestAssistantIdx; // exclusive

  // Bucket accumulators
  const messagesChildren: Record<string, ChildAccum> = {
    user: { name: "User messages", tokens: 0, items: [] },
    thinking: { name: "Thinking", tokens: 0, items: [] },
    assistant: { name: "Assistant text", tokens: 0, items: [] },
  };
  const toolCallsChildren: Record<string, ChildAccum> = {};
  const toolResultsChildren: Record<string, ChildAccum> = {};
  const attachmentsChildren: Record<string, ChildAccum> = {};

  // Map tool_use_id → tool name (to group tool_result by tool name) and →
  // input (so a tool_result can show the call that produced it).
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
          // images we can't tokenize; record as 0
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
      // First pass: compute cl100k of non-thinking content and aggregate
      // signature length, so we can derive thinking tokens from the turn's
      // ground-truth output_tokens (text + thinking + tool_use sum on output).
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
      // thinking_total = output_tokens − cl100k(text+tool_use). If unknown,
      // fall back to signature_length × SIGNATURE_TOKEN_RATIO (empirically fit).
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
            // Distribute the turn's thinking budget across thinking blocks
            // proportionally to their signature length. If no budget known,
            // fall back to sig × 0.33.
            if (thinkingBudget != null && totalSigLen > 0) {
              const share = sigPerBlock[thinkingBlockIdx] / totalSigLen;
              tokens = Math.round(thinkingBudget * share);
            } else {
              tokens = Math.round(sig.length * SIGNATURE_TOKEN_RATIO);
            }
            summary = `[encrypted reasoning · ~${tokens.toLocaleString()} tok]`;
            fullContent =
              `(Reasoning is encrypted by Claude; only an opaque signature is visible.)\n\n` +
              `signature length: ${sig.length.toLocaleString()} chars\n` +
              (thinkingBudget != null
                ? `derived from this turn's output_tokens (${turnOutputTokens}) minus visible content (${nonThinkOutputTokens}).`
                : `estimated as signature_length × ${SIGNATURE_TOKEN_RATIO}.`);
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
            // The call's input is its entire content, shown as the labeled
            // "Tool input" block in the UI (no separate output).
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

  // Build buckets. Messages preserves its user/thinking/assistant order and
  // drops empty children; the tool/attachment buckets sort children by tokens.
  const messagesBucket = buildBucket("messages", "Messages", messagesChildren, { skipEmpty: true });
  const toolCallsBucket = buildBucket("tool_calls", "Tool calls", toolCallsChildren, { sort: true });
  const toolResultsBucket = buildBucket("tool_results", "Tool results", toolResultsChildren, { sort: true });
  const attachmentsBucket = buildBucket("attachments", "Attachments", attachmentsChildren, { sort: true });

  // Calibrate cl100k counts up toward Claude's BPE, then — if the identified
  // buckets still over-shoot realTotal — scale them back down to fit. The
  // residual floors at 0: when the sums match it holds the system prompt; if
  // they over-shoot we present a truthful "no residual" rather than reserving
  // a fake slice.
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
            summary: "Claude Code system prompt + tool-schema definitions + harness overhead",
            fullContent:
              `This bucket is computed as a residual: realTotal − Σ(identified buckets).\n\n` +
              `It primarily reflects:\n` +
              `  • The Claude Code system prompt (~3-6k tokens, version-dependent).\n` +
              `  • Tool schema JSON sent to the model (~5-25k typical; ~15k+ when MCP bundles like\n` +
              `    Playwright / Chrome DevTools are loaded).\n` +
              `  • Per-message wrapper overhead (role markers, tool-call envelopes).\n\n` +
              `Token counts use cl100k_base × ${CL100K_TO_CLAUDE} calibration to approximate Claude's BPE. ` +
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

  // Order: System, Messages, Tool calls, Tool results, Attachments
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
