// Bucket → color mappings shared between the chart (Chart.tsx) and the
// breakdown UI (Detail.tsx) so a palette change only happens in one place.

export const PALETTE = ["#64748b", "#14b8a6", "#6366f1", "#f59e0b", "#0ea5e9"];

export const BUCKET_COLORS: Record<string, string> = {
  system: "#64748b", // slate-500
  messages: "#14b8a6", // teal-500
  tool_calls: "#6366f1", // indigo-500
  tool_results: "#f59e0b", // amber-500
  attachments: "#0ea5e9", // sky-500
};

// Per-bucket palettes: distinct shades, intentionally varied in hue and
// lightness so adjacent sub-buckets are easy to tell apart inside one row.
export const BUCKET_SHADES: Record<string, string[]> = {
  system: ["#475569", "#64748b", "#94a3b8", "#cbd5e1"],
  messages: ["#0d9488", "#14b8a6", "#2dd4bf", "#5eead4", "#99f6e4"],
  tool_calls: [
    "#3730a3", "#4f46e5", "#6366f1", "#818cf8", "#a5b4fc",
    "#7c3aed", "#a78bfa", "#c4b5fd",
  ],
  tool_results: [
    "#b45309", "#d97706", "#f59e0b", "#fbbf24", "#fcd34d",
    "#ea580c", "#fb923c", "#fdba74",
  ],
  attachments: [
    "#0369a1", "#0284c7", "#0ea5e9", "#38bdf8", "#7dd3fc",
    "#155e75", "#06b6d4", "#22d3ee",
  ],
};

export function bucketColor(id: string, idx: number): string {
  return BUCKET_COLORS[id] ?? PALETTE[idx % PALETTE.length]!;
}

export function subShade(bucketId: string, bucketIdx: number, subIdx: number): string {
  const shades = BUCKET_SHADES[bucketId];
  if (!shades || shades.length === 0) return bucketColor(bucketId, bucketIdx);
  return shades[subIdx % shades.length]!;
}
