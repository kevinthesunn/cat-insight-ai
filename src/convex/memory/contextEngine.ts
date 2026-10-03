// §17 branch-scoped context retrieval — pure engine (policies, traverse, gate, pack).
// Traversal is deterministic code over the uniform `graph_edges` list; no LLM here.

export type EdgeType =
  | "HOSTS" | "CONTAINS" | "INSTALLED_ON" | "HAD" | "MATCHES" | "AFFECTS"
  | "ADDRESSED" | "USED" | "FOLLOWED_BY" | "FIX_FOR" | "EVIDENCED_BY"
  | "GROUPS" | "CONTAINS_EVENT";

export type GEdge = {
  sourceType: string;
  sourceId: string;
  edgeType: EdgeType;
  targetType: string;
  targetId: string;
  occurredAt?: number;
  props?: Record<string, unknown>;
};

export type GNode = {
  id: string;
  type: "site" | "machine" | "system" | "component" | "episode" | "signature" | "fix_card" | "cluster" | "part";
  label: string;
  props?: Record<string, unknown>; // occurredAt, siteAlias, superseded, removedAt, status, summary…
};

export type Intent = "fault_help" | "asset_history" | "site_status" | "pattern_check" | "general_unknown";

// ---- §17.5 context_policies.yaml equivalent (validated at startup by ctx code) ----
export type TemplateStep = {
  from: "anchor" | "episodes" | "signatures" | "fix_cards" | "machines" | "machine" | "clusters" | "component" | "system";
  edges: EdgeType[];
  limit: number;
  order?: "recency";
  crossSite?: boolean; // widening may reach sibling units on other sites (redacted)
  resetToAnchor?: boolean; // restart the frontier at the anchor nodes
  where?: {
    notSuperseded?: boolean;
    assetActive?: boolean;
    notRetired?: boolean;
    sameSiteAsAnchor?: boolean;
  };
};

export type Template = {
  intent: Intent;
  anchor: "machine" | "site" | "signature";
  steps: TemplateStep[];
  never_include: Array<GNode["type"]>;
  widen_to?: string[]; // e.g. "same_signature_on_sibling_units_same_model"
  budget: { max_nodes: number; max_tokens: number };
};

const COMMON: Record<string, Template> = {
  fault_help: {
    intent: "fault_help",
    anchor: "machine",
    steps: [
      { from: "anchor", edges: ["CONTAINS"], limit: 8 },
      { from: "component", edges: ["HAD"], limit: 12, order: "recency", where: { notSuperseded: true, assetActive: true, sameSiteAsAnchor: true } },
      { from: "machine", resetToAnchor: true, edges: ["HAD"], limit: 12, order: "recency", where: { notSuperseded: true, assetActive: true, sameSiteAsAnchor: true } },
      { from: "episodes", edges: ["MATCHES"], limit: 5 },
      { from: "signatures", edges: ["FIX_FOR"], limit: 6, where: { notRetired: true } },
      { from: "fix_cards", edges: ["EVIDENCED_BY"], limit: 8, where: { notRetired: true } },
    ],
    never_include: ["cluster"],
    widen_to: ["same_signature_on_sibling_units_same_model"],
    budget: { max_nodes: 24, max_tokens: 1800 },
  },
  asset_history: {
    intent: "asset_history",
    anchor: "machine",
    steps: [
      { from: "anchor", edges: ["CONTAINS"], limit: 10 },
      { from: "component", edges: ["HAD"], limit: 12, order: "recency", where: { notSuperseded: true, assetActive: true } },
      { from: "machine", resetToAnchor: true, edges: ["HAD"], limit: 20, order: "recency", where: { notSuperseded: true, assetActive: true } },
      { from: "episodes", edges: ["MATCHES"], limit: 6 },
      { from: "signatures", edges: ["FIX_FOR"], limit: 4, where: { notRetired: true } },
    ],
    never_include: ["cluster"],
    budget: { max_nodes: 24, max_tokens: 1600 },
  },
  site_status: {
    intent: "site_status",
    anchor: "site",
    steps: [
      { from: "anchor", edges: ["HOSTS"], limit: 20 },
      { from: "machines", edges: ["HAD"], limit: 20, order: "recency", where: { notSuperseded: true, assetActive: true } },
      { from: "episodes", edges: ["MATCHES"], limit: 8 },
    ],
    never_include: ["cluster"],
    budget: { max_nodes: 30, max_tokens: 2200 },
  },
  pattern_check: {
    intent: "pattern_check",
    anchor: "machine",
    steps: [
      { from: "anchor", edges: ["HAD"], limit: 10, order: "recency", where: { notSuperseded: true } },
      { from: "episodes", edges: ["MATCHES"], limit: 5 },
      { from: "signatures", edges: ["GROUPS"], limit: 4 },
      { from: "clusters", edges: ["CONTAINS_EVENT"], limit: 12, where: { notSuperseded: true } },
    ],
    never_include: [],
    widen_to: ["same_signature_on_sibling_units_same_model"],
    budget: { max_nodes: 30, max_tokens: 2200 },
  },
  general_unknown: {
    intent: "general_unknown",
    anchor: "machine",
    steps: [
      { from: "anchor", edges: ["HAD"], limit: 3, order: "recency", where: { notSuperseded: true } },
    ],
    never_include: ["cluster"],
    budget: { max_nodes: 6, max_tokens: 400 },
  },
};

export const POLICIES: Record<Intent, Template> = COMMON;

export const EDGE_WEIGHTS: Record<EdgeType, number> = {
  HOSTS: 0.9, CONTAINS: 0.9, INSTALLED_ON: 0.9,
  HAD: 1.0, MATCHES: 1.0, AFFECTS: 0.8,
  ADDRESSED: 0.9, USED: 0.6, FOLLOWED_BY: 0.95,
  FIX_FOR: 1.0, EVIDENCED_BY: 0.95, GROUPS: 0.9, CONTAINS_EVENT: 0.85,
};

// ---- types (§17.3) ----
export type ManifestItem = {
  node_type: string;
  node_id: string;
  path: string[];
  reason: string;
  score: number;
  redacted: boolean;
};

export type Manifest = {
  queryId: string;
  role: string;
  intent: Intent;
  anchors: string[];
  items: ManifestItem[];
  widened: boolean;
  widen_reason: string | null;
  token_estimate: number;
};

export type ScopeCtx = {
  role: string;
  allowedSiteIds: string[] | null; // null = all sites (engineer/admin)
  ownSiteId?: string | null;
  isCrew: boolean; // operator/technician/manager → redaction applies
};

// ---- §17.4.4 deterministic traversal ----
export function traverse(input: {
  edges: GEdge[];
  nodes: Map<string, GNode>;
  anchors: string[]; // asset ids
  template: Template;
  scope: ScopeCtx;
  now: number;
  widen?: string | null; // widen_to key
  focusSignatureId?: string | null; // fault_help: episodes outside this fault are dropped
}): ManifestItem[] {
  const { edges, nodes, template, scope, now } = input;
  const byNode = (id: string) => nodes.get(id);
  const decay = 0.85;
  const items = new Map<string, ManifestItem>();

  const siteAllowed = (siteId: unknown) =>
    scope.allowedSiteIds == null || (siteId != null && scope.allowedSiteIds.includes(String(siteId)));

  const passesWhere = (
    step: TemplateStep,
    nodeId: string,
    depth: number,
    frontierSiteId: unknown,
  ): boolean => {
    const node = byNode(nodeId);
    if (!node) return false;
    const w = step.where ?? {};
    if (w.notSuperseded && node.props?.superseded) return false;
    if (w.notRetired && node.props?.status === "retired") return false;
    if (w.assetActive && node.props?.removedAt != null && node.props?.assetRemovedBeforeEvent !== false) {
      // drop events on assets removed before the event's relevance (§17.4.5)
      const removedAt = node.props?.removedAt as number | undefined;
      const occurredAt = node.props?.occurredAt as number | undefined;
      if (removedAt != null && occurredAt != null && removedAt < occurredAt) return false;
    }
    if (w.sameSiteAsAnchor && !step.crossSite && !siteAllowed(frontierSiteId ?? node.props?.siteId)) return false;
    // scope first (§17.4.1): episodes/machines outside the user's sites are never fetched
    const nodeSite = node.props?.siteId;
    if (!step.crossSite && (node.type === "episode" || node.type === "machine")) {
      if (!siteAllowed(nodeSite)) return false;
    }
    void depth;
    return true;
  };

  // frontier starts at anchors
  let frontier: Array<{ id: string; siteId: unknown; path: string[]; depth: number; baseScore: number }> = [];
  for (const a of input.anchors) {
    const n = byNode(a);
    if (!n) continue;
    frontier.push({ id: a, siteId: n.props?.siteId, path: [], depth: 0, baseScore: 1 });
    items.set(a, {
      node_type: n.type,
      node_id: a,
      path: [],
      reason: "query anchor",
      score: 1,
      redacted: false,
    });
  }

  const steps = [...template.steps];
  if (input.widen) {
    // controlled widening: sibling units with the same signature + model (§17.4.8);
    // explicit, once, and redacted for crew roles
    steps.push({
      from: "signatures",
      edges: ["MATCHES"],
      limit: 10,
      order: "recency",
      crossSite: true,
      where: { notSuperseded: true },
    });
  }

  // fault_help is fault-scoped: episodes about other components on this machine
  // are distractors and never enter the manifest (§17.8.11)
  const focus = input.template.intent === "fault_help" ? input.focusSignatureId ?? null : null;

  const fromType = (stepFrom: TemplateStep["from"]) =>
    ({ episodes: "episode", signatures: "signature", fix_cards: "fix_card", machines: "machine", clusters: "cluster", component: "component", system: "system" } as Record<string, string>)[stepFrom];

  for (const step of steps) {
    if (step.resetToAnchor) {
      frontier = input.anchors
        .filter((a) => byNode(a))
        .map((a) => ({ id: a, siteId: byNode(a)?.props?.siteId, path: [], depth: 0, baseScore: 1 }));
    }
    const next: typeof frontier = [];
    for (const f of frontier) {
      const fType = byNode(f.id)?.type;
      const wantType = fromType(step.from);
      const isAnchorStart = step.from === "anchor" && f.path.length === 0;
      if (!isAnchorStart && fType !== wantType) continue;
      for (const e of edges) {
        if (!step.edges.includes(e.edgeType)) continue;
        // edges are directed (§17.2); templates walk some of them backwards
        // (e.g. signature →fix cards via FIX_FOR). Match both directions.
        let nextId: string;
        let occurredAt: number | undefined;
        if (e.sourceId === f.id) {
          nextId = e.targetId;
          occurredAt = e.occurredAt;
        } else if (e.targetId === f.id) {
          nextId = e.sourceId;
          occurredAt = e.occurredAt;
        } else continue;
        const target = byNode(nextId);
        if (!target) continue;
        if (template.never_include.includes(target.type)) continue;
        if (focus && target.type === "episode" && target.props?.signatureId && target.props.signatureId !== focus) continue;
        if (!passesWhere(step, nextId, f.depth + 1, f.siteId)) continue;
        if (items.has(nextId)) continue;
        const score =
          (EDGE_WEIGHTS[e.edgeType] ?? 0.5) * Math.pow(decay, f.depth) *
          recencyFactor(occurredAt ?? target.props?.occurredAt as number | undefined, now);
        items.set(nextId, {
          node_type: target.type,
          node_id: nextId,
          path: [...f.path, e.edgeType],
          reason: `${e.edgeType} via ${byNode(f.id)?.label ?? f.id}`,
          score,
          redacted: scope.isCrew && (target.type === "episode" || target.props?.siteId !== scope.ownSiteId),
        });
        next.push({
          id: nextId,
          siteId: target.props?.siteId ?? f.siteId,
          path: [...f.path, e.edgeType],
          depth: f.depth + 1,
          baseScore: score,
        });
      }
    }
    // order + limit per step
    const ordered = step.order === "recency"
      ? next.sort((a, b) => (byNode(b.id)?.props?.occurredAt as number ?? 0) - (byNode(a.id)?.props?.occurredAt as number ?? 0))
      : next;
    frontier = ordered.slice(0, step.limit);
  }

  // widening continues from the signatures already in the manifest
  if (input.widen) {
    const sigFrontier = [...items.values()]
      .filter((it) => it.node_type === "signature")
      .map((it) => ({ id: it.node_id, siteId: byNode(it.node_id)?.props?.siteId, path: it.path, depth: it.path.length, baseScore: it.score }));
    const widenStep = steps[steps.length - 1];
    const next: typeof frontier = [];
    for (const f of sigFrontier) {
      for (const e of edges) {
        if (!widenStep.edges.includes(e.edgeType)) continue;
        let nextId: string;
        let occurredAt: number | undefined;
        if (e.sourceId === f.id) { nextId = e.targetId; occurredAt = e.occurredAt; }
        else if (e.targetId === f.id) { nextId = e.sourceId; occurredAt = e.occurredAt; }
        else continue;
        const target = byNode(nextId);
        if (!target || target.type !== "episode" || target.props?.superseded) continue;
        if (items.has(nextId)) continue;
        const score = (EDGE_WEIGHTS[e.edgeType] ?? 0.5) * Math.pow(decay, f.depth) * recencyFactor(occurredAt ?? target.props?.occurredAt as number | undefined, now);
        items.set(nextId, {
          node_type: "episode",
          node_id: nextId,
          path: [...f.path, "MATCHES"],
          reason: `widened: ${input.widen}`,
          score: score * 0.8, // widened context is discounted
          redacted: scope.isCrew,
        });
        next.push({ id: nextId, siteId: target.props?.siteId, path: [...f.path, "MATCHES"], depth: f.depth + 1, baseScore: score });
      }
    }
    frontier = next.slice(0, widenStep.limit);
  }

  return [...items.values()];
}

function recencyFactor(occurredAt: number | undefined, now: number): number {
  if (occurredAt == null) return 0.8;
  const days = Math.max(0, (now - occurredAt) / 86_400_000);
  return Math.exp(-days / 180);
}

// ---- §17.4.5 gate: validity, scoring, redaction, budget → Manifest ----
export function gate(input: {
  rawItems: ManifestItem[];
  nodes: Map<string, GNode>;
  template: Template;
  queryId: string;
  role: string;
  intent: Intent;
  anchors: string[];
  now: number;
  widened?: boolean;
  widenReason?: string | null;
}): Manifest {
  const minScore = Number(process.env.CONTEXT_MIN_SCORE ?? 0.3);
  let kept = input.rawItems.filter((it) => {
    if (!it.path || it.path.length === 0) {
      // anchors are kept; everything else needs a path
      return input.anchors.includes(it.node_id);
    }
    if (!it.reason) return false;
    return it.score >= minScore;
  });

  // budget: drop lowest-scored first (§17.4.5)
  const maxNodes = input.template.budget.max_nodes;
  kept = kept.sort((a, b) => b.score - a.score).slice(0, maxNodes);

  // token estimate: ~4 chars per token of the packed text
  const maxTokens = input.template.budget.max_tokens;
  let packedLen = packManifest(kept, input.nodes, input.now).length;
  while (packedLen / 4 > maxTokens && kept.length > 1) {
    kept = kept.slice(0, kept.length - 1);
    packedLen = packManifest(kept, input.nodes, input.now).length;
  }

  return {
    queryId: input.queryId,
    role: input.role,
    intent: input.intent,
    anchors: input.anchors,
    items: kept,
    widened: input.widened ?? false,
    widen_reason: input.widenReason ?? null,
    token_estimate: Math.ceil(packedLen / 4),
  };
}

// ---- §17 pack ----
export function packManifest(items: ManifestItem[], nodes: Map<string, GNode>, now: number): string {
  const lines: string[] = [];
  for (const it of items) {
    const n = nodes.get(it.node_id);
    if (!n) continue;
    const bits: string[] = [];
    if (n.props?.occurredAt) {
      const days = Math.round((now - (n.props.occurredAt as number)) / 86_400_000);
      bits.push(days <= 0 ? "today" : `${days}d ago`);
    }
    if (n.props?.siteAlias) bits.push(String(n.props.siteAlias));
    if (n.props?.summary) bits.push(String(n.props.summary));
    const suffix = bits.length ? ` (${bits.join(" · ")})` : "";
    lines.push(`- [${n.type}] ${n.label}${suffix}${it.redacted ? " {redacted}" : ""}`);
  }
  return lines.join("\n");
}

// ---- answer validation (§17.4.6/7) ----
export type AnswerPayload = {
  answer: string;
  steps: string[];
  citations: string[];
  needs_more_context: { reason: string; suggested_template: string } | null;
};

export function validateAnswer(
  parsed: unknown,
  manifestItemIds: string[],
): { ok: boolean; answer: AnswerPayload | null; flagged: string[] } {
  if (!parsed || typeof parsed !== "object") return { ok: false, answer: null, flagged: [] };
  const p = parsed as Record<string, unknown>;
  const manifestSet = new Set(manifestItemIds);
  const rawCitations = Array.isArray(p.citations) ? p.citations.map(String) : [];
  const flagged = rawCitations.filter((c) => !manifestSet.has(c));
  const citations = rawCitations.filter((c) => manifestSet.has(c));
  const needsMore =
    p.needs_more_context && typeof p.needs_more_context === "object"
      ? {
          reason: String((p.needs_more_context as Record<string, unknown>).reason ?? ""),
          suggested_template: String(
            (p.needs_more_context as Record<string, unknown>).suggested_template ?? "",
          ),
        }
      : null;
  const answer: AnswerPayload = {
    answer: String(p.answer ?? "").slice(0, 2000),
    steps: Array.isArray(p.steps) ? p.steps.map(String).slice(0, 8) : [],
    citations,
    needs_more_context:
      needsMore && POLICIES[needsMore.suggested_template as Intent]
        ? needsMore
        : null,
  };
  // a claim citing a node outside the manifest is never displayed as fact (§17.4.7)
  if (!answer.answer) return { ok: false, answer: null, flagged };
  return { ok: true, answer, flagged };
}
