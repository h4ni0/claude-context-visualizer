import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { api, type Snapshot, type SessionListItem, type LeafItem, type Bucket } from "../api";
import { Chart, type ViewMode } from "./Chart";
import { BUCKET_COLORS } from "../colors";

type Props = { session: SessionListItem };

// Cap on how many item rows are rendered at once (the list can be huge).
const MAX_ROWS = 500;

// "R G B" triplet for use in `rgb(var(--card-rgb) / <alpha>)`, so the bucket
// card's tint, hover, and active states can be driven from one CSS variable.
function rgbTriplet(hex: string): string {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const n = parseInt(full, 16);
  return `${(n >> 16) & 255} ${(n >> 8) & 255} ${n & 255}`;
}

function fmt(n: number): string {
  return n.toLocaleString();
}

type OffenderRow = LeafItem & { bucketId: string; bucketName: string; subBucketName: string };

function gatherOffenders(snap: Snapshot): OffenderRow[] {
  const rows: OffenderRow[] = [];
  for (const b of snap.buckets) {
    // The system bucket holds a single synthetic "residual" leaf representing
    // the system prompt + tool schemas. It's not an item the user can act on,
    // so don't include it in the "top items" list (the bucket card still shows it).
    if (b.id === "system") continue;
    for (const c of b.children) {
      for (const it of c.items) {
        rows.push({ ...it, bucketId: b.id, bucketName: b.name, subBucketName: c.name });
      }
    }
  }
  rows.sort((a, b) => b.tokens - a.tokens);
  return rows;
}

export function Detail({ session }: Props) {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [mode, setMode] = useState<ViewMode>("treemap");
  const [bucketId, setBucketId] = useState<string | null>(null);
  const [subId, setSubId] = useState<string | null>(null);
  const [sortBy, setSortBy] = useState<"tokens" | "turn">("tokens");
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  const load = (force = false) => {
    setLoading(true);
    setSnap(null);
    setBucketId(null);
    setSubId(null);
    setExpanded(new Set());
    const fetcher = force
      ? api.invalidate(session.id).then(() => api.snapshot(session.id))
      : api.snapshot(session.id);
    fetcher.then(setSnap).catch((e) => alert(String(e))).finally(() => setLoading(false));
  };
  useEffect(() => { load(); }, [session.id]);

  const allOffenders = useMemo(() => (snap ? gatherOffenders(snap) : []), [snap]);

  const bucket = useMemo(
    () => snap?.buckets.find((b) => b.id === bucketId) ?? null,
    [snap, bucketId],
  );
  const sub = useMemo(
    () => bucket?.children.find((c) => c.id === subId) ?? null,
    [bucket, subId],
  );

  const filteredItems: LeafItem[] = useMemo(() => {
    if (!snap) return [];
    if (sub) return sub.items;
    if (bucket) return bucket.children.flatMap((c) => c.items);
    return allOffenders;
  }, [snap, bucket, sub, allOffenders]);

  const sortedItems = useMemo(() => {
    return [...filteredItems].sort((a, b) =>
      sortBy === "tokens" ? b.tokens - a.tokens : a.turn - b.turn,
    );
  }, [filteredItems, sortBy]);

  if (loading || !snap) return <div className="loading">Computing snapshot…</div>;

  const pct = snap.headline.modelCap > 0 ? snap.headline.realTotal / snap.headline.modelCap : 0;
  const total = snap.buckets.reduce((s, b) => s + b.tokens, 0);

  return (
    <>
      {/* ─── Hero ─── */}
      <div className="hero">
        <div className="hero-top">
          <div>
            <div className="hero-tokens">
              <span className="num">{fmt(snap.headline.realTotal)}</span>
              <span className="unit">tokens</span>
            </div>
            <div className="hero-pct" style={{ marginTop: 6 }}>
              {(pct * 100).toFixed(1)}% <span className="of">of {fmt(snap.headline.modelCap)} context window</span>
            </div>
          </div>
          <div className="hero-model">{snap.headline.model}</div>
        </div>
        <div className="hero-progress">
          <div className="hero-progress-bar" style={{ width: `${Math.min(100, pct * 100).toFixed(2)}%` }} />
        </div>
        <div className="hero-stats">
          <div className="stat">
            <div className="label">Input</div>
            <div className="value">{fmt(snap.headline.inputTokens)}</div>
          </div>
          <div className="stat">
            <div className="label">Cache create</div>
            <div className="value">{fmt(snap.headline.cacheCreationTokens)}</div>
          </div>
          <div className="stat">
            <div className="label">Cache read</div>
            <div className="value">{fmt(snap.headline.cacheReadTokens)}</div>
          </div>
          <div className="stat">
            <div className="label">Output</div>
            <div className="value">{fmt(snap.headline.outputTokens)}</div>
          </div>
        </div>
        {snap.compaction && (
          <div className="notice compaction">
            <span className="icon">⊘</span>
            <span>
              Compaction at record #{snap.compaction.latestBoundaryAt} ({snap.compaction.trigger}):
              &nbsp;{fmt(snap.compaction.preTokens)} → {fmt(snap.compaction.postTokens)} tokens.
              Only content after this boundary is counted.
            </span>
          </div>
        )}
        {snap.warnings.length > 0 && (
          <div className="notice warning">
            <span className="icon">⚠</span>
            <span>{snap.warnings.map((w, i) => <div key={i}>{w}</div>)}</span>
          </div>
        )}
      </div>

      {/* ─── Breakdown ─── */}
      <div className="card">
        <h3 className="card-title">Breakdown</h3>
        <StackedBar
          buckets={snap.buckets}
          total={total}
          selected={bucketId}
          onSelect={(id) => { setBucketId(id === bucketId ? null : id); setSubId(null); }}
        />
        <div className="bucket-grid">
          {snap.buckets.map((b) => {
            const color = BUCKET_COLORS[b.id] ?? "#a1a1aa";
            const p = total > 0 ? (b.tokens / total) * 100 : 0;
            return (
              <div
                key={b.id}
                className={`bucket-card${bucketId === b.id ? " active" : ""}`}
                style={{ "--card-rgb": rgbTriplet(color) } as CSSProperties}
                onClick={() => { setBucketId(bucketId === b.id ? null : b.id); setSubId(null); }}
              >
                <div className="bc-top">
                  <span className="bc-name">{b.name}</span>
                  <span className="bc-pct">{p.toFixed(1)}%</span>
                </div>
                <div className="bc-tokens">{fmt(b.tokens)}</div>
              </div>
            );
          })}
        </div>
      </div>

      {/* ─── Chart (right after breakdown) ─── */}
      <div className="bar-row">
        <div className="view-mode-bar">
          <button className={mode === "treemap" ? "active" : ""} onClick={() => setMode("treemap")}>Treemap</button>
          <button className={mode === "donut" ? "active" : ""} onClick={() => setMode("donut")}>Sunburst</button>
          <button className={mode === "bar" ? "active" : ""} onClick={() => setMode("bar")}>Bar</button>
        </div>
        <button className="invalidate" onClick={() => load(true)} title="Re-compute from disk">↻ Refresh</button>
      </div>
      <Chart
        buckets={snap.buckets}
        mode={mode}
        onSelectBucket={(id) => { setBucketId(id); setSubId(null); }}
        onSelectSubBucket={(id, sub) => { setBucketId(id); setSubId(sub); }}
      />

      {/* ─── Dynamic items: drill into a category / sub-category above ─── */}
      <div className="items-bar">
        <div className="breadcrumb">
          <a className={!bucket ? "current" : ""} onClick={() => { setBucketId(null); setSubId(null); }}>All items</a>
          {bucket && <>
            <span className="arrow">›</span>
            <a className={!sub ? "current" : ""} onClick={() => setSubId(null)}>{bucket.name}</a>
          </>}
          {sub && <>
            <span className="arrow">›</span>
            <a className="current">{sub.name}</a>
          </>}
          <span className="item-count">{fmt(sortedItems.length)} item{sortedItems.length === 1 ? "" : "s"}</span>
        </div>
        <div className="sort-toggle">
          <button className={sortBy === "tokens" ? "active" : ""} onClick={() => setSortBy("tokens")}>By tokens</button>
          <button className={sortBy === "turn" ? "active" : ""} onClick={() => setSortBy("turn")}>Chronological</button>
        </div>
      </div>

      {!bucket && !sub && (
        <div className="items-hint">
          Showing every item. Click a category or sub-category in the breakdown, treemap,
          or chart above to focus on just those items.
        </div>
      )}

      <div className="items-table">
        <div className="table-header">
          <div>Tokens</div>
          <div>Turn</div>
          <div>Summary</div>
        </div>
        {sortedItems.slice(0, MAX_ROWS).map((item, i) => {
          const open = expanded.has(i);
          return (
            <div
              key={i}
              className={`row${open ? " expanded" : ""}`}
              onClick={() => {
                setExpanded((prev) => {
                  const n = new Set(prev);
                  if (n.has(i)) n.delete(i); else n.add(i);
                  return n;
                });
              }}
            >
              <div className="tok">{fmt(item.tokens)}</div>
              <div className="turn">{item.turn || "—"}</div>
              <div className="summary">{item.summary || "(empty)"}</div>
              {open && (
                <div className="full">
                  {item.toolInput && (
                    <div className="full-section">
                      <div className="full-label">Tool input</div>
                      <pre className="full-pre">{item.toolInput}</pre>
                    </div>
                  )}
                  {(item.fullContent || !item.toolInput) && (
                    <div className="full-section">
                      {item.toolInput && <div className="full-label">Result</div>}
                      <pre className="full-pre">{item.fullContent || "(empty)"}</pre>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
        {sortedItems.length > MAX_ROWS && (
          <div className="row">
            <div /><div />
            <div className="more">… {fmt(sortedItems.length - MAX_ROWS)} more not shown</div>
          </div>
        )}
      </div>
    </>
  );
}

function StackedBar({
  buckets, total, selected, onSelect,
}: {
  buckets: Bucket[];
  total: number;
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  if (total <= 0) return null;
  return (
    <div className="stacked-bar">
      {buckets.map((b) => {
        const p = (b.tokens / total) * 100;
        if (p < 0.4) return null;
        const color = BUCKET_COLORS[b.id] ?? "#a1a1aa";
        const showLabel = p >= 6;
        return (
          <div
            key={b.id}
            className="seg"
            style={{
              flex: `${b.tokens} 0 0`,
              background: color,
              opacity: selected && selected !== b.id ? 0.5 : 1,
            }}
            onClick={() => onSelect(b.id)}
            title={`${b.name}: ${b.tokens.toLocaleString()} (${p.toFixed(1)}%)`}
          >
            {showLabel ? `${b.name} · ${p.toFixed(0)}%` : ""}
          </div>
        );
      })}
    </div>
  );
}
