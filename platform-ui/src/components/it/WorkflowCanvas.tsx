"use client";
import { useMemo, useState } from "react";
import type { GraphLayout } from "@/lib/it";
import "./it.css";

// Read-only n8n workflow canvas. Receives a prebuilt GraphLayout (positions +
// resolved edges) computed server-side by layoutGraph() — this component only
// normalizes coordinates to a padded content box, draws nodes + bezier edges,
// and handles fit/zoom. No data fetching, no server imports (types only).
const NODE_W = 150;
const NODE_H = 46;
const PAD = 40;
const GAP_Y = 34; // n8n y-positions are dense; expand a touch for the taller cards

export function WorkflowCanvas({ layout }: { layout: GraphLayout }) {
  const [zoom, setZoom] = useState(1);

  const { placed, edges, width, height } = useMemo(() => {
    const { bounds } = layout;
    const dx = -bounds.minX + PAD;
    const dy = -bounds.minY + PAD;
    const placed = layout.nodes.map((n) => ({ ...n, px: n.x + dx, py: n.y + dy }));
    const byName = new Map(placed.map((n) => [n.name, n]));
    const edges = layout.edges
      .map((e) => ({ from: byName.get(e.from), to: byName.get(e.to) }))
      .filter((e) => e.from && e.to) as { from: (typeof placed)[number]; to: (typeof placed)[number] }[];
    const width = bounds.maxX - bounds.minX + NODE_W + PAD * 2;
    const height = bounds.maxY - bounds.minY + NODE_H + PAD * 2 + GAP_Y;
    return { placed, edges, width, height };
  }, [layout]);

  if (placed.length === 0) {
    return (
      <div className="it-canvas" style={{ display: "grid", placeItems: "center", minHeight: 200 }}>
        <span style={{ font: "400 13px var(--font-body)", color: "var(--erp-ink-50)" }}>
          This workflow has no nodes to display.
        </span>
      </div>
    );
  }

  const path = (a: (typeof placed)[number], b: (typeof placed)[number]) => {
    const x1 = a.px + NODE_W, y1 = a.py + NODE_H / 2;
    const x2 = b.px, y2 = b.py + NODE_H / 2;
    const mx = (x1 + x2) / 2;
    return `M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`;
  };

  return (
    <div>
      <div className="it-canvas-bar">
        <span style={{ font: "400 12px var(--font-body)", color: "var(--erp-ink-50)" }}>
          {placed.length} node{placed.length === 1 ? "" : "s"} · {edges.length} connection{edges.length === 1 ? "" : "s"}
        </span>
        <div className="it-canvas-zoom">
          <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" onClick={() => setZoom((z) => Math.max(0.4, +(z - 0.1).toFixed(2)))} aria-label="Zoom out">−</button>
          <span style={{ font: "400 12px var(--font-body)", color: "var(--erp-ink-60)", minWidth: 44, textAlign: "center" }}>{Math.round(zoom * 100)}%</span>
          <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" onClick={() => setZoom((z) => Math.min(2, +(z + 0.1).toFixed(2)))} aria-label="Zoom in">+</button>
          <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" onClick={() => setZoom(1)}>Reset</button>
        </div>
      </div>

      <div className="it-canvas">
        <div className="it-canvas__inner" style={{ width, height, transform: `scale(${zoom})` }}>
          <svg className="it-edges" viewBox={`0 0 ${width} ${height}`} width={width} height={height} preserveAspectRatio="none">
            {edges.map((e, i) => (
              <path key={i} d={path(e.from, e.to)} fill="none" stroke="var(--erp-accent, #6E5A43)" strokeWidth={1.3} strokeOpacity={0.55} />
            ))}
          </svg>
          {placed.map((n) => (
            <div key={n.name} className="it-node" style={{ left: n.px, top: n.py, height: NODE_H }} title={`${n.name} (${n.type})`}>
              <span className="it-node__name">{n.name}</span>
              <span className="it-node__type">{n.type}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
