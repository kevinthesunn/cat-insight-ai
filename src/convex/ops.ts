import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { canSeeRaw, isCrew, siteAliases } from "./store";

type Ctx = { db: any; auth: any };

async function me(ctx: Ctx) {
  const userId = await getAuthUserId(ctx);
  return userId ? await ctx.db.get(userId) : null;
}

async function requireEngineer(ctx: Ctx) {
  const user = await me(ctx);
  if (!user || !canSeeRaw(user)) throw new Error("Engineer access required");
  return user;
}

/** §5 emerging_patterns + §12 dashboard data. */
export const emergingPatterns = query({
  args: {},
  handler: async (ctx) => {
    const user = await me(ctx);
    if (!user) return null;
    const crew = isCrew(user);
    const aliases = await siteAliases(ctx);
    const clusters = (await ctx.db.query("patternClusters").collect()).sort(
      (a: any, b: any) => (b.score ?? 0) - (a.score ?? 0),
    );
    const out = [] as any[];
    for (const c of clusters) {
      const members = await ctx.db
        .query("patternClusterMembers")
        .withIndex("by_cluster", (q) => q.eq("clusterId", c._id))
        .collect();
      const memberSites = new Set<string>();
      const memberRows = [] as any[];
      for (const m of members) {
        const ep = await ctx.db.get(m.episodeId);
        if (!ep || ep.supersedes) continue;
        memberSites.add(ep.siteId ?? "");
        const machine = await ctx.db.get(ep.machineId);
        memberRows.push({
          episodeId: ep._id,
          machineLabel: machine ? machine.unitNumber ?? machine.serialNumber : "unit",
          siteLabel: crew
            ? (aliases.get(ep.siteId ?? "")?.alias ?? "site")
            : `${aliases.get(ep.siteId ?? "")?.name ?? ""}`,
          at: ep.occurredAt,
          text: crew ? (ep.redactedText ?? "").slice(0, 140) : (ep.rawText ?? "").slice(0, 240),
          kind: ep.kind,
        });
      }
      // managers are site-scoped: only clusters touching their site
      if (user.role === "manager" && user.siteId && !memberSites.has(user.siteId)) continue;
      if (crew && user.siteId && !memberSites.has(user.siteId)) continue;
      const sig = c.signatureId ? await ctx.db.get(c.signatureId) : null;
      out.push({
        id: c._id,
        status: c.status,
        score: c.score,
        unitCount: c.unitCount,
        siteCount: c.siteCount,
        episodeCount: c.episodeCount,
        baselineRate: c.baselineRate,
        observedRate: c.observedRate,
        windowStart: c.windowStart,
        windowEnd: c.windowEnd,
        hints: (c.sharedHints as string[] | undefined) ?? [],
        engineerNotes: c.engineerNotes,
        updatedAt: c.updatedAt,
        signature: sig
          ? { id: sig._id, component: sig.component, faultCode: sig.faultCode, machineClass: sig.machineClass, symptomSummary: sig.symptomSummary }
          : null,
        members: memberRows,
      });
    }
    return { patterns: out, role: user.role };
  },
});

const CLUSTER_STATUSES = ["new", "investigating", "known_issue", "fixed_in_product", "dismissed"] as const;

export const updateClusterStatus = mutation({
  args: {
    clusterId: v.id("patternClusters"),
    status: v.union(...CLUSTER_STATUSES.map((s) => v.literal(s))),
    notes: v.optional(v.string()),
  },
  handler: async (ctx, { clusterId, status, notes }) => {
    await requireEngineer(ctx);
    const patch: Record<string, unknown> = { status, updatedAt: Date.now() };
    if (notes !== undefined) patch.engineerNotes = notes;
    await ctx.db.patch(clusterId, patch);
    const cluster = await ctx.db.get(clusterId);
    // §10.4: fixed_in_product retires the signature's fix cards
    if (status === "fixed_in_product" && cluster?.signatureId) {
      const cards = await ctx.db
        .query("fixCards")
        .withIndex("by_signature", (q) => q.eq("signatureId", cluster.signatureId!))
        .collect();
      for (const card of cards) {
        await ctx.db.patch(card._id, { status: "retired", updatedAt: Date.now() });
      }
    }
  },
});

/** Engineer dashboard: "Push guidance to affected sites" (§12). */
export const pushGuidance = mutation({
  args: { clusterId: v.id("patternClusters"), note: v.string() },
  handler: async (ctx, { clusterId, note }) => {
    const user = await requireEngineer(ctx);
    const cluster = await ctx.db.get(clusterId);
    if (!cluster?.signatureId) throw new Error("Cluster has no signature");
    const cards = await ctx.db
      .query("fixCards")
      .withIndex("by_signature", (q) => q.eq("signatureId", cluster.signatureId!))
      .collect();
    for (const card of cards) {
      if (card.status === "retired") continue;
      await ctx.db.patch(card._id, {
        guidanceNote: note.slice(0, 400),
        guidanceBy: user.name ?? "CAT Engineering",
        updatedAt: Date.now(),
      });
    }
  },
});

// ---- §17.2 graph_edges: uniform edge list; the traversal engine reads only this ----
export async function buildGraph(ctx: Ctx, opts: { crew: boolean }) {
  const crew = opts.crew;
  const aliases = await siteAliases(ctx);

    const assets = await ctx.db.query("assets").collect();
    const machines = await ctx.db.query("machines").collect();
    const machineById = new Map(machines.map((m: any) => [m._id, m]));
    const episodes = await ctx.db.query("episodes").collect();
    const signatures = await ctx.db.query("faultSignatures").collect();
    const cards = await ctx.db.query("fixCards").collect();
    const clusters = await ctx.db.query("patternClusters").collect();
    const members = await ctx.db.query("patternClusterMembers").collect();
    const repairs = await ctx.db.query("repairs").collect();
    const repairByEpisode = new Map(repairs.map((r: any) => [r.episodeId, r]));

    type GEdge = { sourceType: string; sourceId: string; edgeType: string; targetType: string; targetId: string; occurredAt?: number; props?: Record<string, unknown> };
    type GNode = { id: string; type: string; label: string; props?: Record<string, unknown> };
    const nodes: GNode[] = [];
    const edges: GEdge[] = [];

    // asset tree root site for each asset (walk parents)
    const assetById = new Map(assets.map((a: any) => [a._id, a]));
    const rootSiteOf = (a: any): string | null => {
      let cur: any = a;
      for (let i = 0; i < 6 && cur?.parentId; i++) cur = assetById.get(cur.parentId);
      return cur?.kind === "site" ? (cur.props?.siteId ?? cur._id) : cur?._id ?? null;
    };

    const siteRows = await ctx.db.query("sites").collect();
    const siteAssetToSite = new Map<string, string>();
    const siteAssets = assets.filter((a: any) => a.kind === "site");
    for (const s of siteAssets) {
      const row = siteRows.find((r: any) => r.name === s.name);
      if (row) siteAssetToSite.set(s._id, row._id);
      nodes.push({ id: s._id, type: "site", label: crew ? (row ? aliases.get(row._id)?.alias ?? s.name : s.name) : s.name, props: { siteId: row?._id ?? s._id } });
    }
    for (const a of assets) {
      if (a.kind === "site") continue;
      const machine = a.kind === "machine" ? machines.find((m: any) => m.assetId === a._id) : null;
      const siteId = a.kind === "machine" ? machine?.siteId ?? null : siteAssetToSite.get(rootSiteOf(a) ?? "") ?? null;
      nodes.push({
        id: a._id,
        type: a.kind,
        label: a.name,
        props: {
          siteId,
          machineId: machine?._id,
          unitNumber: machine?.unitNumber,
          serialNumber: machine?.serialNumber,
          removedAt: a.removedAt,
          partNumber: a.partNumber,
          installedAt: a.installedAt,
        },
      });
    }
    for (const a of assets) {
      if (a.parentId) {
        const parent = assetById.get(a.parentId);
        edges.push({ sourceType: parent.kind, sourceId: parent._id, edgeType: a.kind === "machine" ? "HOSTS" : "CONTAINS", targetType: a.kind, targetId: a._id });
        if (a.kind === "component") {
          // INSTALLED_ON: component → machine asset
          let cur: any = a;
          for (let i = 0; i < 6 && cur?.parentId; i++) cur = assetById.get(cur.parentId);
          if (cur?.kind === "machine") {
            edges.push({ sourceType: "component", sourceId: a._id, edgeType: "INSTALLED_ON", targetType: "machine", targetId: cur._id, occurredAt: a.installedAt });
          }
        }
      }
    }

    const sigById = new Map(signatures.map((s: any) => [s._id, s]));
    for (const ep of episodes) {
      const machine = machineById.get(ep.machineId);
      nodes.push({
        id: ep._id,
        type: "episode",
        label: `${ep.kind}: ${(crew ? ep.redactedText ?? "" : ep.rawText ?? "").slice(0, 60)}`,
        props: {
          occurredAt: ep.occurredAt,
          siteId: ep.siteId,
          siteAlias: aliases.get(ep.siteId ?? "")?.alias,
          superseded: Boolean(ep.supersedes),
          summary: crew ? (ep.redactedText ?? "").slice(0, 160) : (ep.rawText ?? "").slice(0, 160),
          extractionStatus: ep.extractionStatus,
        },
      });
      // HAD: most specific asset (default to machine's asset)
      const assetId = ep.assetId ?? machine?.assetId;
      if (assetId) edges.push({ sourceType: "asset", sourceId: assetId, edgeType: "HAD", targetType: "episode", targetId: ep._id, occurredAt: ep.occurredAt, props: { siteId: ep.siteId } });
      if (ep.signatureId) edges.push({ sourceType: "episode", sourceId: ep._id, edgeType: "MATCHES", targetType: "signature", targetId: ep.signatureId, occurredAt: ep.occurredAt, props: { siteId: ep.siteId } });
      const repair = repairByEpisode.get(ep._id);
      if (repair) {
        if (repair.signatureId) edges.push({ sourceType: "episode", sourceId: ep._id, edgeType: "ADDRESSED", targetType: "signature", targetId: repair.signatureId, occurredAt: ep.occurredAt });
        for (const p of repair.parts) {
          const partId = `part:${p.partNumber ?? p.name}`;
          nodes.push({ id: partId, type: "part", label: p.partNumber ?? p.name });
          edges.push({ sourceType: "episode", sourceId: ep._id, edgeType: "USED", targetType: "part", targetId: partId, occurredAt: ep.occurredAt });
        }
        if (repair.recurrenceEpisodeId) {
          edges.push({ sourceType: "episode", sourceId: ep._id, edgeType: "FOLLOWED_BY", targetType: "episode", targetId: repair.recurrenceEpisodeId });
        }
      }
    }
    for (const s of signatures) {
      nodes.push({ id: s._id, type: "signature", label: `${s.component.replace(/_/g, " ")}${s.faultCode ? ` · ${s.faultCode}` : ""}`, props: { summary: s.symptomSummary } });
      edges.push({ sourceType: "signature", sourceId: s._id, edgeType: "AFFECTS", targetType: "part", targetId: `comp:${s.machineClass}:${s.component}` });
      nodes.push({ id: `comp:${s.machineClass}:${s.component}`, type: "part", label: `${s.component.replace(/_/g, " ")} (${s.machineClass})` });
    }
    for (const c of cards) {
      nodes.push({ id: c._id, type: "fix_card", label: c.title, props: { status: c.status, summary: `held ${c.heldCount} · recurred ${c.recurredCount}` } });
      edges.push({ sourceType: "fix_card", sourceId: c._id, edgeType: "FIX_FOR", targetType: "signature", targetId: c.signatureId });
    }
    const evidence = await ctx.db.query("fixCardEvidence").collect();
    for (const ev of evidence) {
      edges.push({ sourceType: "fix_card", sourceId: ev.fixCardId, edgeType: "EVIDENCED_BY", targetType: "episode", targetId: ev.repairEpisodeId });
    }
    const memberByCluster = new Map<string, string[]>();
    for (const m of members) {
      const list = memberByCluster.get(m.clusterId) ?? [];
      list.push(m.episodeId);
      memberByCluster.set(m.clusterId, list);
    }
    for (const c of clusters) {
      const sig = c.signatureId ? sigById.get(c.signatureId) : null;
      nodes.push({ id: c._id, type: "cluster", label: `Pattern: ${sig?.component?.replace(/_/g, " ") ?? "unknown"} (${c.unitCount} units)`, props: { status: c.status, summary: c.engineerNotes ?? undefined } });
      if (c.signatureId) edges.push({ sourceType: "cluster", sourceId: c._id, edgeType: "GROUPS", targetType: "signature", targetId: c.signatureId });
      for (const epId of memberByCluster.get(c._id) ?? []) {
        edges.push({ sourceType: "cluster", sourceId: c._id, edgeType: "CONTAINS_EVENT", targetType: "episode", targetId: epId });
      }
    }

    return { nodes, edges };
}

export const graphEdges = query({
  args: {},
  handler: async (ctx) => {
    const user = await me(ctx);
    if (!user) return null;
    return await buildGraph(ctx, { crew: isCrew(user) });
  },
});

/** §17.6 manifest access: full for engineers, summary otherwise. */
export const getManifest = query({
  args: { manifestId: v.id("manifests") },
  handler: async (ctx, { manifestId }) => {
    const user = await me(ctx);
    if (!user) return null;
    const m = await ctx.db.get(manifestId);
    if (!m) return null;
    if (canSeeRaw(user)) return m;
    return {
      id: m._id,
      role: m.role,
      intent: m.intent,
      itemCount: (m.items as any[])?.length ?? 0,
      widened: m.widened,
      createdAt: m.createdAt,
    };
  },
});
