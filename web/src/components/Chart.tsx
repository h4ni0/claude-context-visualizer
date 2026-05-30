import { useEffect, useRef } from "react";
import * as echarts from "echarts";
import type { Bucket } from "../api";
import { bucketColor, subShade } from "../colors";

export type ViewMode = "treemap" | "donut" | "bar";

type Props = {
  buckets: Bucket[];
  mode: ViewMode;
  onSelectBucket: (bucketId: string) => void;
  onSelectSubBucket: (bucketId: string, subId: string) => void;
};

const CHART_TEXT = "#18181b";
const CHART_MUTED = "#71717a";
const CHART_BG = "#ffffff";
const CHART_BORDER = "#ebebeb";

const TOOLTIP_STYLE = {
  backgroundColor: "#ffffff",
  borderColor: "#d4d4d4",
  textStyle: { color: CHART_TEXT, fontSize: 12 },
  extraCssText: "box-shadow: 0 4px 16px rgba(0,0,0,0.08); border-radius: 8px; padding: 8px 12px;",
};

export function Chart({ buckets, mode, onSelectBucket, onSelectSubBucket }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const inst = useRef<echarts.ECharts | null>(null);

  useEffect(() => {
    if (!ref.current) return;
    inst.current = echarts.init(ref.current, undefined, { renderer: "canvas" });
    const onResize = () => inst.current?.resize();
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      inst.current?.dispose();
      inst.current = null;
    };
  }, []);

  useEffect(() => {
    if (!inst.current) return;
    const opt = buildOption(buckets, mode);
    inst.current.setOption(opt, true);
    const bucketByName: Record<string, string> = {};
    const subByName: Record<string, { bucketId: string; subId: string }> = {};
    for (const b of buckets) {
      bucketByName[b.name] = b.id;
      bucketByName[b.id] = b.id;
      for (const c of b.children) {
        subByName[c.name] = { bucketId: b.id, subId: c.id };
        subByName[c.id] = { bucketId: b.id, subId: c.id };
      }
    }
    const handler = (params: any) => {
      const path = params?.treePathInfo;
      if (Array.isArray(path) && path.length >= 3) {
        const bId = path[1].data?.bucketId ?? bucketByName[path[1].name];
        const sId = path[2].data?.subId ?? subByName[path[2].name]?.subId;
        if (bId && sId) {
          onSelectSubBucket(bId, sId);
          return;
        }
      }
      if (Array.isArray(path) && path.length === 2) {
        const bId = path[1].data?.bucketId ?? bucketByName[path[1].name];
        if (bId) {
          onSelectBucket(bId);
          return;
        }
      }
      const id = params?.data?.bucketId;
      const subId = params?.data?.subId;
      if (id && subId) onSelectSubBucket(id, subId);
      else if (id) onSelectBucket(id);
    };
    inst.current.off("click");
    inst.current.on("click", handler);
  }, [buckets, mode, onSelectBucket, onSelectSubBucket]);

  return <div ref={ref} className="chart" />;
}

function nicePct(part: number, whole: number): string {
  if (whole <= 0) return "0%";
  const p = (part / whole) * 100;
  return p < 0.1 ? "<0.1%" : `${p.toFixed(1)}%`;
}

function buildOption(buckets: Bucket[], mode: ViewMode): echarts.EChartsOption {
  const total = buckets.reduce((s, b) => s + b.tokens, 0);

  if (mode === "treemap") {
    return {
      backgroundColor: "transparent",
      tooltip: {
        ...TOOLTIP_STYLE,
        formatter: (info: any) => {
          const tokens = info.value as number;
          return `<div style="font-weight:600">${escape(info.name)}</div>
                  <div style="color:${CHART_MUTED};margin-top:2px">
                    <b style="color:${CHART_TEXT}">${tokens.toLocaleString()}</b> tokens · ${nicePct(tokens, total)}
                  </div>`;
        },
      },
      series: [
        {
          type: "treemap",
          roam: false,
          nodeClick: false,
          // Keep tiles in the same order as `buckets` (and therefore the
          // Breakdown bar) instead of letting the squarify layout reorder by
          // size.
          sort: false,
          breadcrumb: { show: false },
          width: "100%",
          height: "100%",
          top: 0,
          bottom: 0,
          left: 0,
          right: 0,
          label: {
            show: true,
            color: "#fff",
            fontWeight: 500,
            fontSize: 12,
            formatter: (p: any) => {
              const tok = (p.value as number).toLocaleString();
              return `{name|${p.name}}\n{tok|${tok}}`;
            },
            rich: {
              name: { color: "#fff", fontWeight: 600, fontSize: 12, lineHeight: 16 },
              tok: { color: "rgba(255,255,255,0.85)", fontSize: 11, lineHeight: 14 },
            },
          },
          upperLabel: { show: true, height: 22, color: "#fff", fontWeight: 600, fontSize: 12 },
          levels: [
            { itemStyle: { borderWidth: 0, gapWidth: 3, borderRadius: 4 } },
            {
              itemStyle: { borderColor: CHART_BG, borderWidth: 2, gapWidth: 2, borderRadius: 4 },
              upperLabel: { show: true, color: "#fff", fontSize: 12, fontWeight: 600 },
            },
            {
              itemStyle: { borderColor: CHART_BG, borderWidth: 1, gapWidth: 1, borderRadius: 2 },
              colorSaturation: [0.5, 0.75],
            },
          ],
          data: buckets.map((b, idx) => ({
            name: b.name,
            value: b.tokens,
            bucketId: b.id,
            itemStyle: { color: bucketColor(b.id, idx) },
            children:
              b.children.length > 0
                ? b.children.map((c, ci) => ({
                    name: c.name,
                    value: c.tokens,
                    bucketId: b.id,
                    subId: c.id,
                    itemStyle: { color: subShade(b.id, idx, ci) },
                  }))
                : undefined,
          })),
        },
      ],
    };
  }
  if (mode === "donut") {
    return {
      backgroundColor: "transparent",
      tooltip: {
        ...TOOLTIP_STYLE,
        formatter: (i: any) =>
          `<div style="font-weight:600">${escape(i.name)}</div>
           <div style="color:${CHART_MUTED};margin-top:2px">
             <b style="color:${CHART_TEXT}">${(i.value as number).toLocaleString()}</b> tokens
           </div>`,
      },
      series: [
        {
          type: "sunburst",
          radius: ["18%", "92%"],
          center: ["50%", "50%"],
          nodeClick: false,
          // Preserve `buckets` order (matches the Breakdown bar) rather than
          // sorting segments by value.
          sort: null as any,
          itemStyle: { borderColor: CHART_BG, borderWidth: 2, borderRadius: 2 },
          emphasis: { focus: "ancestor" },
          label: {
            show: true,
            color: "#fff",
            fontSize: 11,
            minAngle: 14,
            rotate: "tangential",
          },
          levels: [
            {},
            {
              r0: "18%",
              r: "55%",
              label: { rotate: "tangential", color: "#fff", fontWeight: 600 },
              itemStyle: { borderWidth: 2 },
            },
            {
              r0: "55%",
              r: "92%",
              label: { rotate: "tangential", color: "#fff", fontSize: 10 },
              itemStyle: { borderWidth: 1 },
            },
          ],
          data: buckets.map((b, idx) => ({
            name: b.name,
            value: b.tokens,
            itemStyle: { color: bucketColor(b.id, idx) },
            bucketId: b.id,
            children:
              b.children.length > 0
                ? b.children.map((c, ci) => ({
                    name: c.name,
                    value: c.tokens,
                    bucketId: b.id,
                    subId: c.id,
                    itemStyle: { color: subShade(b.id, idx, ci) },
                  }))
                : undefined,
          })),
        },
      ],
    };
  }

  // ── Bar: ONE ROW PER CATEGORY, sub-buckets stacked inside the row ──
  // yAxis in ECharts shows data[0] at the TOP for horizontal bars, so we
  // pass the bucket names in their natural order. Each bucket gets its own
  // stack key so sub-buckets pack into a single bar per row.
  const categories = buckets.map((b) => b.name);
  type BarSeg = { cat: number; bucketId: string; subId: string; name: string; subName: string; value: number; color: string };
  const segs: BarSeg[] = [];
  for (const [idx, b] of buckets.entries()) {
    if (b.children.length === 0) {
      segs.push({
        cat: idx,
        bucketId: b.id,
        subId: "",
        name: b.name,
        subName: "",
        value: b.tokens,
        color: bucketColor(b.id, idx),
      });
      continue;
    }
    for (const [ci, c] of b.children.entries()) {
      segs.push({
        cat: idx,
        bucketId: b.id,
        subId: c.id,
        name: b.name,
        subName: c.name,
        value: c.tokens,
        color: subShade(b.id, idx, ci),
      });
    }
  }
  // Each series contributes to exactly one category (others = 0). All series
  // share the same stack key so within any single row, the visible bar is
  // composed only of that row's own sub-buckets (other categories' series
  // contribute 0 to that row, no parallel-bar artifacts).
  const series: any[] = segs.map((s) => {
    const data: (number | { value: number; bucketId: string; subId: string })[] = new Array(
      categories.length,
    ).fill(0);
    data[s.cat] = { value: s.value, bucketId: s.bucketId, subId: s.subId };
    return {
      name: s.subName ? `${s.name} · ${s.subName}` : s.name,
      type: "bar",
      stack: "total",
      data,
      itemStyle: {
        color: s.color,
        borderColor: CHART_BG,
        borderWidth: 1,
        borderRadius: 0,
      },
      barWidth: 28,
      emphasis: { focus: "self" },
    };
  });
  return {
    backgroundColor: "transparent",
    tooltip: {
      ...TOOLTIP_STYLE,
      trigger: "item",
      formatter: (p: any) => {
        const tok = (p.value as number).toLocaleString();
        return `<div style="font-weight:600">${escape(p.seriesName)}</div>
                <div style="color:${CHART_MUTED};margin-top:2px">
                  <b style="color:${CHART_TEXT}">${tok}</b> tokens
                </div>`;
      },
    },
    legend: { show: false },
    grid: { left: 16, right: 24, top: 16, bottom: 28, containLabel: true },
    xAxis: {
      type: "value",
      axisLabel: {
        color: CHART_MUTED,
        formatter: (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(0)}k` : `${v}`),
      },
      splitLine: { lineStyle: { color: CHART_BORDER, type: "dashed" } },
      axisLine: { show: false },
      axisTick: { show: false },
    },
    yAxis: {
      type: "category",
      data: categories,
      axisLabel: {
        color: CHART_TEXT,
        fontSize: 12,
        fontWeight: 500,
        margin: 12,
      },
      axisLine: { show: false },
      axisTick: { show: false },
    },
    series,
  };
}

function escape(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
