import { Button } from "@/components/ui/button";
import { api } from "@/convex/_generated/api";
import { useQuery } from "convex/react";
import {
  ArrowLeft, Loader2, Lock, Network, Search, X, ZoomIn, ZoomOut,
} from "lucide-react";
import { useMemo, useState } from "react";
import { Link } from "react-router";
import { cn } from "@/lib/utils";
import { timeAgo } from "@/components/shared";
import { useAuth } from "@/hooks/use-auth";
import { Brand, ROLE_META } from "./Dashboard";

// ---- §17.2 graph shapes (matches ops.buildGraph output) ----
type GNode = { id: string; type: string; label: string; props?: Record<string, unknown> };
type GEdge = {
  sourceType: string; sourceId: string; edgeType: string;
  targetType: string; targetId: string; occurredAt?: number;
};

const LAYER_ORDER = ["site", "machine", "component", "episode", "signature", "fix_card", "cluster", "part"];
const LAYER_LABEL: Record<string, string> = {
  site: "Sites", machine: "Machines", component: "Components", episode: "Episodes",
  signature: "Signatures", fix_card: "Fix cards", cluster: "Patterns", part: "Parts",
};
const LAYER_HINT: Record<string, string> = {
  site: "where it happened", machine: "the unit", component: "the part that failed",
  episode: "voice notes · alarms · repairs", signature: "normalized faults",
  fix_card: "the best-known fix", cluster: "emerging patterns", part: "parts used",
};

const NODE_CLS: Record<string, { rect: string; text: string }> = {
  site: { rect: "fill-stone-800 stroke-stone-900 dark:fill-stone-700 dark:stroke-stone-600", text: "text-stone-50" },
  machine: { rect: "fill-sky-100 stroke-sky-300 dark:fill-sky-950 dark:stroke-sky-800", text: "text-sky-900 dark:text-sky-200" },
  component: { rect: "fill-emerald-100 stroke-emerald-300 dark:fill-emerald-950 dark:stroke-emerald-800", text: "text-emerald-900 dark:text-emerald-200" },
  episode: { rect: "fill-amber-100 stroke-amber-300 dark:fill-amber-950 dark:stroke-amber-800", text: "text-amber-900 dark:text-amber-200" },
  signature: { rect: "fill-violet-100 stroke-violet-300 dark:fill-violet-950 dark:stroke-violet-800", text: "text-violet-900 dark:text-violet-200" },
  fix_card: { rect: "fill-teal-100 stroke-teal-300 dark:fill-teal-950 dark:stroke-teal-800", text: "text-teal-900 dark:text-teal-200" },
  cluster: { rect: "fill-red-100 stroke-red-300 dark:fill-red-950 dark:stroke-red-800", text: "text-red-900 dark:text-red-200" },
  part: { rect: "fill-stone-100 stroke-stone-300 dark:fill-stone-800 dark:stroke-stone-700", text: "text-stone-600 dark:text-stone-300" },
};

const EVENT_EDGES = new Set(["HAD", "MATCHES", "ADDRESSED", "USED", "FOLLOWED_BY"]);
const KNOWLEDGE_EDGES = new Set(["FIX_FOR", "EVIDENCED_BY", "GROUPS", "AFFECTS"]);
const edgeCls = (t: string) =>
  EVENT_EDGES.has(t) ? "stroke-amber-400" : KNOWLEDGE_EDGES.has(t) ? "stroke-violet-400" : "stroke-stone-300 dark:stroke-stone-700";

const STRUCTURAL = new Set(["site", "machine", "component"]);
const TOGGLE_TYPES = ["episode", "signature", "fix_card", "cluster", "part"] as const;

// layout constants
const NODE_W = 188, NODE_H = 30, COL_GAP = 96, ROW_GAP = 14, PAD = 44, MAX_NODES = 420;
const short = (s: string, n = 30) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

type RenderNode = GNode & { x: number; y: number; dim: boolean; faded: boolean };
type RenderEdge = { key: string; d: string; type: string; hl: boolean; op: number };

export default function KnowledgeGraph() {
  const { user } = useAuth();
  const graph = useQuery(api.ops.graphEdges, {});
  const role = user?.role ?? null;
  const allowed = role === "manager" || role === "engineer" || role === "admin";
  const isManager = role === "manager";

  const [siteFilter, setSiteFilter] = useState("all");
  const [types, setTypes] = useState<Record<string, boolean>>({
    episode: true, signature: true, fix_card: true, cluster: true, part: false,
  });
  const [search, setSearch] = useState("");
  const [zoom, setZoom] = useState(0.75);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hoverId, setHoverId] = useState<string | null>(null);

  const focus = hoverId ?? selectedId;

  const siteOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const n of graph?.nodes ?? []) {
      if (n.type !== "site") continue;
      const id = String(n.props?.siteId ?? n.id);
      if (!seen.has(id)) seen.set(id, n.label);
    }
    return [...seen.entries()].map(([id, label]) => ({ id, label }));
  }, [graph]);

  const siteLabelFor = useMemo(() => {
    const m = new Map(siteOptions.map((s) => [s.id, s.label]));
    return (id: string) => m.get(id) ?? "another site";
  }, [siteOptions]);

  const effectiveSite = isManager && user?.siteId ? String(user.siteId) : siteFilter;

  const layout = useMemo(() => {
    const nodes = graph?.nodes ?? [];
    const edges = graph?.edges ?? [];
    if (nodes.length === 0) return null;

    const byId = new Map(nodes.map((n) => [n.id, n]));
    const enabled = new Set(Object.entries(types).filter(([, on]) => on).map(([t]) => t));

    // adjacency (undirected view of the edge list)
    const adj = new Map<string, GEdge[]>();
    for (const e of edges) {
      if (!byId.has(e.sourceId) || !byId.has(e.targetId)) continue;
      (adj.get(e.sourceId) ?? adj.set(e.sourceId, []).get(e.sourceId)!).push(e);
      (adj.get(e.targetId) ?? adj.set(e.targetId, []).get(e.targetId)!).push(e);
    }

    // §17.4.1 scope-first: seed with the site's structural branch, then walk
    // outward to the knowledge attached to it (signatures/cards/patterns are
    // shared across sites by design — that is the point of the memory layer).
    const kept = new Set<string>();
    for (const n of nodes) {
      if (!STRUCTURAL.has(n.type)) continue;
      if (effectiveSite !== "all" && String(n.props?.siteId ?? "") !== effectiveSite) continue;
      kept.add(n.id);
    }
    let frontier = [...kept];
    for (let depth = 0; depth < 3 && frontier.length; depth++) {
      const next: string[] = [];
      for (const id of frontier) {
        for (const e of adj.get(id) ?? []) {
          const other = e.sourceId === id ? e.targetId : e.sourceId;
          if (kept.has(other)) continue;
          const t = byId.get(other)!.type;
          if (STRUCTURAL.has(t) || enabled.has(t)) {
            kept.add(other);
            next.push(other);
          }
        }
      }
      frontier = next;
    }

    // cap: drop the oldest episodes first so recents always survive
    let dropped = 0;
    let keptNodes = nodes.filter((n) => kept.has(n.id));
    if (keptNodes.length > MAX_NODES) {
      const eps = keptNodes
        .filter((n) => n.type === "episode")
        .sort((a, b) => Number(b.props?.occurredAt ?? 0) - Number(a.props?.occurredAt ?? 0));
      const keep = new Set(eps.slice(0, Math.max(0, MAX_NODES - (keptNodes.length - eps.length))).map((n) => n.id));
      const before = keptNodes.length;
      keptNodes = keptNodes.filter((n) => n.type !== "episode" || keep.has(n.id));
      dropped = before - keptNodes.length;
    }
    const keptIds = new Set(keptNodes.map((n) => n.id));

    // positions: one column per layer, stacked and centered
    const pos = new Map<string, { x: number; y: number }>();
    let maxRows = 1;
    LAYER_ORDER.forEach((type, li) => {
      const col = keptNodes.filter((n) => n.type === type);
      const sorted =
        type === "episode"
          ? col.sort((a, b) => Number(b.props?.occurredAt ?? 0) - Number(a.props?.occurredAt ?? 0))
          : col.sort((a, b) => a.label.localeCompare(b.label));
      maxRows = Math.max(maxRows, sorted.length);
      sorted.forEach((n, i) => {
        pos.set(n.id, {
          x: PAD + NODE_W / 2 + li * (NODE_W + COL_GAP),
          y: PAD + NODE_H / 2 + i * (NODE_H + ROW_GAP),
        });
      });
    });
    const width = PAD * 2 + LAYER_ORDER.length * (NODE_W + COL_GAP) - COL_GAP;
    const height = Math.max(420, PAD * 2 + maxRows * (NODE_H + ROW_GAP) - ROW_GAP);

    const q = search.trim().toLowerCase();
    const matches = (n: GNode) => !q || n.label.toLowerCase().includes(q);

    const nbrs = new Set<string>();
    const renderEdges: RenderEdge[] = [];
    for (const e of edges) {
      if (!keptIds.has(e.sourceId) || !keptIds.has(e.targetId) || e.sourceId === e.targetId) continue;
      const a = pos.get(e.sourceId);
      const b = pos.get(e.targetId);
      if (!a || !b) continue;
      const hl = focus != null && (e.sourceId === focus || e.targetId === focus);
      if (hl) nbrs.add(e.sourceId === focus ? e.targetId : e.sourceId);
      const dx = Math.max(46, Math.abs(b.x - a.x) * 0.45);
      const op = focus ? (hl ? 0.9 : 0.05) : 0.5;
      renderEdges.push({
        key: `${e.sourceId}|${e.edgeType}|${e.targetId}|${renderEdges.length}`,
        type: e.edgeType,
        d: `M ${a.x + NODE_W / 2} ${a.y} C ${a.x + NODE_W / 2 + dx} ${a.y}, ${b.x - NODE_W / 2 - dx} ${b.y}, ${b.x - NODE_W / 2} ${b.y}`,
        hl,
        op: q && !(matches(byId.get(e.sourceId)!) || matches(byId.get(e.targetId)!)) ? Math.min(op, 0.12) : op,
      });
    }

    const renderNodes: RenderNode[] = keptNodes.flatMap((n) => {
      const p = pos.get(n.id);
      if (!p) return [];
      const degraded = Boolean(n.props?.superseded) || n.props?.status === "retired";
      let dim = false;
      if (focus) dim = n.id !== focus && !nbrs.has(n.id);
      const faded = (q && !matches(n)) || degraded;
      return { ...n, x: p.x, y: p.y, dim, faded };
    });

    const counts = new Map<string, number>();
    for (const n of renderNodes) counts.set(n.type, (counts.get(n.type) ?? 0) + 1);

    return { renderNodes, renderEdges, width, height, dropped, counts, nbrs, keptEpisodes: counts.get("episode") ?? 0 };
  }, [graph, effectiveSite, types, search, focus]);

  const selected = useMemo(
    () => layout?.renderNodes.find((n) => n.id === selectedId) ?? null,
    [layout, selectedId],
  );

  const connected = useMemo(() => {
    if (!selected || !graph) return [];
    const rows: Array<{ type: string; label: string; id: string; dir: "in" | "out" }> = [];
    for (const e of graph.edges) {
      if (e.sourceId === selected.id && layout?.renderNodes.some((n) => n.id === e.targetId))
        rows.push({ type: e.edgeType, label: short(graph.nodes.find((n) => n.id === e.targetId)?.label ?? e.targetId, 34), id: e.targetId, dir: "out" });
      if (e.targetId === selected.id && layout?.renderNodes.some((n) => n.id === e.sourceId))
        rows.push({ type: e.edgeType, label: short(graph.nodes.find((n) => n.id === e.sourceId)?.label ?? e.sourceId, 34), id: e.sourceId, dir: "in" });
    }
    return rows;
  }, [selected, graph, layout]);

  if (graph === undefined) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-background">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Loading the memory graph…
        </div>
      </main>
    );
  }

  if (!allowed) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-background p-6">
        <div className="max-w-md rounded-2xl border border-border bg-card p-8 text-center shadow-soft">
          <span className="mx-auto flex size-12 items-center justify-center rounded-xl bg-amber-100 text-amber-900">
            <Lock className="size-6" />
          </span>
          <h1 className="mt-4 font-display text-xl font-bold">Engineers and site managers only</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            The knowledge graph shows how every machine, fault, and fix connects across sites. Crew views stay voice-first in the dashboard.
          </p>
          <Button asChild className="mt-5 gap-2">
            <Link to="/dashboard"><ArrowLeft className="size-4" /> Back to dashboard</Link>
          </Button>
        </div>
      </main>
    );
  }

  return (
    <main className="mx-auto w-full max-w-[1500px] px-4 pb-16 pt-8 sm:px-6">
      <div className="flex flex-wrap items-center gap-3">
        <Button asChild variant="ghost" size="sm" className="gap-1.5 text-muted-foreground">
          <Link to="/dashboard"><ArrowLeft className="size-4" /> Dashboard</Link>
        </Button>
        <Brand />
        {role && ROLE_META[role] && (
          <span className={cn("rounded-full border px-2.5 py-1 text-xs font-medium", ROLE_META[role].cls)}>
            {ROLE_META[role].label}
          </span>
        )}
        <span className="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground">
          <Network className="size-3.5" />
          {layout ? `${layout.renderNodes.length} nodes · ${layout.renderEdges.length} edges` : "no data"}
        </span>
      </div>

      <div className="mt-4">
        <h1 className="font-display text-2xl font-bold tracking-tight">Knowledge graph</h1>
        <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
          Every voice note, alarm, and repair filed against the machine it happened to — then normalized into
          signatures, fix cards, and cross-site patterns. Click a node to inspect it.
        </p>
      </div>

      {/* controls */}
      <div className="mt-5 flex flex-wrap items-center gap-2 rounded-2xl border border-border bg-card p-3 shadow-soft">
        {isManager ? (
          <span className="flex h-9 items-center gap-1.5 rounded-lg border border-sky-200 bg-sky-50 px-3 text-sm font-medium text-sky-900">
            <Lock className="size-3.5" /> {siteOptions.find((s) => s.id === effectiveSite)?.label ?? "Your site"} · site-scoped
          </span>
        ) : (
          <select
            value={effectiveSite}
            onChange={(e) => setSiteFilter(e.target.value)}
            className="h-9 rounded-lg border border-input bg-background px-3 text-sm"
          >
            <option value="all">All sites</option>
            {siteOptions.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
          </select>
        )}

        <div className="flex flex-wrap items-center gap-1">
          {TOGGLE_TYPES.map((t) => (
            <button
              key={t}
              onClick={() => setTypes((prev) => ({ ...prev, [t]: !prev[t] }))}
              className={cn(
                "flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors",
                types[t]
                  ? "border-stone-300 bg-secondary text-foreground"
                  : "border-border bg-background text-muted-foreground",
              )}
            >
              <span className={cn("size-2 rounded-full", NODE_CLS[t].rect.split(" ")[0].replace("fill-", "bg-"))} />
              {LAYER_LABEL[t]}
              {layout?.counts.get(t) ? <span className="text-muted-foreground">{layout.counts.get(t)}</span> : null}
            </button>
          ))}
        </div>

        <label className="relative ml-auto">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search nodes…"
            className="h-9 w-44 rounded-lg border border-input bg-background pl-8 pr-7 text-sm placeholder:text-muted-foreground"
          />
          {search && (
            <button onClick={() => setSearch("")} className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
              <X className="size-3.5" />
            </button>
          )}
        </label>

        <div className="flex items-center gap-1 rounded-lg border border-border bg-background p-1">
          <button onClick={() => setZoom((z) => Math.max(0.4, +(z - 0.15).toFixed(2)))} className="rounded p-1.5 hover:bg-secondary" title="Zoom out">
            <ZoomOut className="size-4" />
          </button>
          <span className="w-10 text-center text-xs tabular-nums text-muted-foreground">{Math.round(zoom * 100)}%</span>
          <button onClick={() => setZoom((z) => Math.min(1.5, +(z + 0.15).toFixed(2)))} className="rounded p-1.5 hover:bg-secondary" title="Zoom in">
            <ZoomIn className="size-4" />
          </button>
        </div>
      </div>

      {layout && layout.dropped > 0 && (
        <p className="mt-2 text-xs text-muted-foreground">
          Showing the {layout.keptEpisodes} most recent episodes — {layout.dropped} older ones hidden. Filter to one site or turn off episodes to see everything.
        </p>
      )}

      <div className="mt-3 grid gap-4 xl:grid-cols-[1fr_320px]">
        {/* canvas */}
        <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-soft">
          {layout ? (
            <div className="bg-grid-faint max-h-[68vh] overflow-auto p-4">
              <svg
                viewBox={`0 0 ${layout.width} ${layout.height}`}
                width={layout.width * zoom}
                height={layout.height * zoom}
                className="max-w-none"
                onClick={() => setSelectedId(null)}
              >
                {layout.renderEdges.map((e) => (
                  <path
                    key={e.key}
                    d={e.d}
                    fill="none"
                    strokeWidth={e.hl ? 2 : 1}
                    className={cn(edgeCls(e.type), "transition-opacity duration-200")}
                    opacity={e.op}
                  />
                ))}
                {layout.renderNodes.map((n) => {
                  const cls = NODE_CLS[n.type] ?? NODE_CLS.part;
                  const isSel = n.id === selectedId;
                  const isNbr = layout.nbrs.has(n.id);
                  return (
                    <g
                      key={n.id}
                      transform={`translate(${n.x},${n.y})`}
                      className="cursor-pointer"
                      opacity={n.dim ? 0.14 : n.faded ? 0.5 : 1}
                      onMouseEnter={() => setHoverId(n.id)}
                      onMouseLeave={() => setHoverId(null)}
                      onClick={(ev) => { ev.stopPropagation(); setSelectedId(n.id === selectedId ? null : n.id); }}
                    >
                      <title>{n.label}</title>
                      <rect
                        x={-NODE_W / 2} y={-NODE_H / 2} width={NODE_W} height={NODE_H} rx={10}
                        strokeWidth={isSel ? 2 : isNbr ? 1.5 : 1}
                        strokeDasharray={n.props?.superseded || n.props?.status === "retired" ? "4 3" : undefined}
                        className={cls.rect}
                      />
                      {isSel && (
                        <rect x={-NODE_W / 2 - 3} y={-NODE_H / 2 - 3} width={NODE_W + 6} height={NODE_H + 6} rx={12} fill="none" strokeWidth={2} className="stroke-amber-500" />
                      )}
                      <text textAnchor="middle" dominantBaseline="central" className={cn("fill-current text-[11px] font-medium", cls.text)}>
                        {short(n.label)}
                      </text>
                    </g>
                  );
                })}
                {/* column headers */}
                {LAYER_ORDER.map((type, li) => (
                  <text
                    key={type}
                    x={PAD + li * (NODE_W + COL_GAP)}
                    y={PAD - 18}
                    className="fill-current text-[11px] font-semibold uppercase tracking-wide text-muted-foreground"
                  >
                    {LAYER_LABEL[type]}
                  </text>
                ))}
              </svg>
            </div>
          ) : (
            <div className="flex h-64 items-center justify-center text-sm text-muted-foreground">
              No graph data yet — report a voice note or run the simulator from the dashboard first.
            </div>
          )}
        </div>

        {/* detail panel */}
        <aside className="space-y-4">
          {selected ? (
            <div className="rounded-2xl border border-border bg-card p-5 shadow-soft">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <span className={cn("rounded-full border px-2 py-0.5 text-[11px] font-semibold", NODE_CLS[selected.type]?.text ?? "text-muted-foreground")}>
                    {LAYER_LABEL[selected.type] ?? selected.type}
                  </span>
                  <h2 className="mt-2 font-display text-base font-bold leading-snug">{selected.label}</h2>
                </div>
                <button onClick={() => setSelectedId(null)} className="rounded p-1 text-muted-foreground hover:bg-secondary hover:text-foreground">
                  <X className="size-4" />
                </button>
              </div>

              <dl className="mt-3 space-y-1.5 text-sm">
                {(() => {
                  const p = (selected.props ?? {}) as Record<string, unknown>;
                  const rows: Array<[string, string]> = [];
                  if (p.siteAlias) rows.push(["Site", String(p.siteAlias)]);
                  else if (p.siteId) rows.push(["Site", siteLabelFor(String(p.siteId))]);
                  if (p.occurredAt) rows.push(["When", timeAgo(Number(p.occurredAt))]);
                  if (p.unitNumber) rows.push(["Unit", String(p.unitNumber)]);
                  if (p.serialNumber) rows.push(["Serial", String(p.serialNumber)]);
                  if (p.partNumber) rows.push(["Part no.", String(p.partNumber)]);
                  if (p.installedAt) rows.push(["Installed", timeAgo(Number(p.installedAt))]);
                  if (p.removedAt) rows.push(["Removed", timeAgo(Number(p.removedAt))]);
                  if (p.status) rows.push(["Status", String(p.status).replace(/_/g, " ")]);
                  if (p.extractionStatus) rows.push(["Extraction", String(p.extractionStatus)]);
                  if (p.summary) rows.push(["Summary", String(p.summary)]);
                  if (p.superseded) rows.push(["Superseded", "yes — deletion correction"]);
                  return rows.map(([k, v]) => (
                    <div key={k} className="flex gap-2">
                      <dt className="w-20 shrink-0 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{k}</dt>
                      <dd className="min-w-0 flex-1 break-words">{v}</dd>
                    </div>
                  ));
                })()}
              </dl>

              {connected.length > 0 && (
                <div className="mt-4 border-t border-border pt-3">
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Connected ({connected.length})</p>
                  <ul className="mt-2 max-h-56 space-y-1 overflow-y-auto pr-1">
                    {connected.map((c, i) => (
                      <li key={`${c.id}-${i}`}>
                        <button
                          onClick={() => setSelectedId(c.id)}
                          className="flex w-full items-center gap-2 rounded-lg border border-border/70 px-2.5 py-1.5 text-left text-xs transition-colors hover:border-amber-400/60 hover:bg-secondary"
                        >
                          <span className="shrink-0 rounded bg-secondary px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">{c.type}</span>
                          <span className="min-w-0 flex-1 truncate">{c.label}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          ) : (
            <div className="rounded-2xl border border-dashed border-border bg-card p-5 shadow-soft">
              <p className="font-display text-sm font-bold">Node inspector</p>
              <p className="mt-1 text-sm text-muted-foreground">
                Click any node to see its details and everything it connects to. Hover to trace a branch.
              </p>
            </div>
          )}

          <div className="rounded-2xl border border-border bg-card p-5 shadow-soft">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Legend</p>
            <div className="mt-2 grid grid-cols-2 gap-1.5 text-xs">
              {LAYER_ORDER.map((t) => (
                <span key={t} className="flex items-center gap-1.5 text-muted-foreground">
                  <span className={cn("size-2.5 shrink-0 rounded-sm", NODE_CLS[t].rect.split(" ")[0].replace("fill-", "bg-"))} />
                  {LAYER_LABEL[t]}
                </span>
              ))}
            </div>
            <div className="mt-3 space-y-1 border-t border-border pt-3 text-xs text-muted-foreground">
              <p className="flex items-center gap-2"><span className="h-0.5 w-5 rounded bg-stone-300 dark:bg-stone-700" /> structure — hosts / contains / installed on</p>
              <p className="flex items-center gap-2"><span className="h-0.5 w-5 rounded bg-amber-400" /> events — had / matches / used / followed by</p>
              <p className="flex items-center gap-2"><span className="h-0.5 w-5 rounded bg-violet-400" /> knowledge — fix for / evidenced by / groups</p>
            </div>
            <p className="mt-3 border-t border-border pt-3 text-xs text-muted-foreground">
              Dashed outlines mark superseded episodes and retired fix cards. Reading left to right is the
              memory pipeline: event → signature → fix.
            </p>
          </div>
        </aside>
      </div>
    </main>
  );
}
