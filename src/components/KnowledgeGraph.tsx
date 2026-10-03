import { useMemo } from "react";
import { motion } from "framer-motion";

type Node = { id: string; kind: string; label: string; sub?: string; severity?: string };
type Edge = { from: string; to: string; label?: string; kind?: string };

const KIND_FILL: Record<string, string> = {
  site: "#292524",
  machine: "#D9A506",
  event: "#A8A29E",
  report: "#64748B",
  fix: "#10B981",
  pattern: "#8B5CF6",
};

const EDGE_STROKE: Record<string, string> = {
  fleet: "#D6D3D1",
  memory: "#D6D3D1",
  raised: "#F87171",
  escalated: "#D9A506",
  targets: "#CBD5E1",
  fix: "#6EE7B7",
  pattern: "#C4B5FD",
};

const LEGEND = [
  { kind: "site", label: "Job site" },
  { kind: "machine", label: "CAT asset" },
  { kind: "event", label: "Memory event" },
  { kind: "alert", label: "Alert" },
  { kind: "report", label: "CAT engineering" },
  { kind: "fix", label: "Quick fix" },
  { kind: "pattern", label: "Pattern insight" },
];

function clamp(v: number, min: number, max: number) {
  return Math.min(max, Math.max(min, v));
}

export default function KnowledgeGraph({ nodes, edges }: { nodes: Node[]; edges: Edge[] }) {
  const layout = useMemo(() => {
    const W = 840;
    const H = 500;
    const cx = W / 2;
    const cy = H / 2;
    const pos = new Map<string, { x: number; y: number }>();

    const sites = nodes.filter((n) => n.kind === "site");
    sites.forEach((s, i) => {
      const spread = sites.length <= 1 ? 0 : (i - (sites.length - 1) / 2) * 260;
      pos.set(s.id, { x: cx + spread, y: cy });
    });

    const machines = nodes.filter((n) => n.kind === "machine");
    machines.forEach((m, i) => {
      const angle = machines.length === 1 ? 0 : (i / machines.length) * Math.PI * 2 - Math.PI / 2;
      pos.set(m.id, { x: cx + 205 * Math.cos(angle), y: cy + 122 * Math.sin(angle) });
    });

    const satellites = nodes.filter((n) => !n.kind.startsWith("site") && n.kind !== "machine");
    const parentOf = new Map<string, string>();
    for (const e of edges) {
      if (!parentOf.has(e.to)) parentOf.set(e.to, e.from);
    }
    const slotCounters = new Map<string, number>();
    satellites.forEach((n) => {
      const anchorId = parentOf.get(n.id) ?? "";
      const anchor = pos.get(anchorId);
      const base = anchor ? Math.atan2(anchor.y - cy, anchor.x - cx) : 0;
      const slot = slotCounters.get(anchorId) ?? 0;
      slotCounters.set(anchorId, slot + 1);
      const offsets = [-0.42, 0, 0.42, -0.78, 0.78];
      const angle = base + offsets[slot % offsets.length];
      pos.set(n.id, {
        x: clamp(cx + 330 * Math.cos(angle), 64, W - 64),
        y: clamp(cy + 192 * Math.sin(angle), 52, H - 52),
      });
    });

    return { W, H, pos };
  }, [nodes, edges]);

  return (
    <div>
      <svg viewBox={`0 0 ${layout.W} ${layout.H}`} className="w-full">
        {edges.map((e, i) => {
          const a = layout.pos.get(e.from);
          const b = layout.pos.get(e.to);
          if (!a || !b) return null;
          const stroke = EDGE_STROKE[e.kind ?? "memory"] ?? EDGE_STROKE.memory;
          return (
            <motion.line
              key={`${e.from}-${e.to}-${i}`}
              x1={a.x} y1={a.y} x2={b.x} y2={b.y}
              stroke={stroke}
              strokeWidth={e.kind === "fleet" ? 2 : 1.25}
              strokeDasharray={e.kind === "pattern" || e.kind === "fix" ? "4 4" : undefined}
              opacity={0.65}
              initial={{ pathLength: 0, opacity: 0 }}
              animate={{ pathLength: 1, opacity: 0.65 }}
              transition={{ duration: 0.6, delay: 0.15 + i * 0.02 }}
            />
          );
        })}
        {nodes.map((n, i) => {
          const p = layout.pos.get(n.id);
          if (!p) return null;
          const r = n.kind === "site" ? 11 : n.kind === "machine" ? 8 : 6;
          const fill =
            n.kind === "alert"
              ? n.severity === "critical" ? "#DC2626" : "#F59E0B"
              : (KIND_FILL[n.kind] ?? "#A8A29E");
          const label = n.label.length > 24 ? n.label.slice(0, 22) + "…" : n.label;
          return (
            <motion.g
              key={n.id}
              initial={{ opacity: 0, scale: 0 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ delay: i * 0.025, type: "spring", stiffness: 260, damping: 20 }}
            >
              <title>{n.sub ? `${n.label} — ${n.sub}` : n.label}</title>
              <circle cx={p.x} cy={p.y} r={r} fill={fill} stroke="white" strokeWidth={1.5} />
              {n.kind === "alert" && (
                <circle cx={p.x} cy={p.y} r={r + 4} fill="none" stroke={fill} strokeWidth={1} opacity={0.5} />
              )}
              <text
                x={p.x}
                y={p.y + r + 13}
                textAnchor="middle"
                fontSize={n.kind === "site" ? 12 : 10.5}
                fontWeight={n.kind === "site" ? 600 : 400}
                fill={n.kind === "site" ? "#292524" : "#57534E"}
              >
                {label}
              </text>
            </motion.g>
          );
        })}
      </svg>
      <div className="flex flex-wrap gap-x-4 gap-y-1.5 px-1 pb-1">
        {LEGEND.map((l) => (
          <span key={l.kind} className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <span
              className="size-2 rounded-full"
              style={{ background: l.kind === "alert" ? "#DC2626" : (KIND_FILL[l.kind] ?? "#A8A29E") }}
            />
            {l.label}
          </span>
        ))}
      </div>
    </div>
  );
}
