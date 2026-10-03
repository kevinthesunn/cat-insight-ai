import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import { api } from "./_generated/api";
import { action, mutation, query } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import {
  gate, packManifest, traverse, validateAnswer,
  POLICIES, type GEdge, type GNode, type Intent, type ScopeCtx,
} from "./memory/contextEngine";
import { groqAnswer } from "./memory/groq";
import { isCrew } from "./store";
import { buildGraph } from "./ops";

// helpers take the loose ctx shape (action/query ctx types differ)

const INTENT_RULES: Array<[Intent, RegExp]> = [
  ["fault_help", /\b(fix|broken|not working|won'?t|whats wrong|what'?s wrong|problem|help|repair how|stuck|failing)\b/i],
  ["asset_history", /\b(history|timeline|been through|past (issues|repairs|problems)|log for)\b/i],
  ["site_status", /\b(site status|happening on site|going on at|overview of the site|across the site|site summary)\b/i],
  ["pattern_check", /\b(pattern|spreading|recurring across|other units|other machines|fleet.?wide|cluster)\b/i],
];

function classifyIntent(question: string): Intent {
  for (const [intent, re] of INTENT_RULES) if (re.test(question)) return intent;
  return "general_unknown";
}

/** §17.4.2 anchor resolution — deterministic first; clarify rather than guess. */
async function resolveAnchors(
  ctx: any,
  question: string,
  ui: any,
  scope: ScopeCtx,
): Promise<{ anchors: string[]; clarification: { reason: string; options: Array<{ id: string; label: string }> } | null }> {
  const { nodes } = await buildGraph(ctx, { crew: scope.isCrew });
  const byId = new Map(nodes.map((n) => [n.id, n]));

  const candidates: string[] = [];
  if (ui?.assetId && byId.has(ui.assetId)) candidates.push(ui.assetId);
  if (ui?.machineId) {
    const machineAsset = nodes.find((n) => n.type === "machine" && n.props?.machineId === ui.machineId);
    if (machineAsset) candidates.push(machineAsset.id);
  }
  if (ui?.siteId) {
    const siteAsset = nodes.find((n) => n.type === "site" && n.props?.siteId === ui.siteId);
    if (siteAsset) candidates.push(siteAsset.id);
  }
  if (candidates.length > 0) return { anchors: candidates, clarification: null };

  // deterministic lookup: unit number / serial in the question
  const unitMatch = question.match(/\b(?:unit|unit\s?#|u)\s?(\d{1,4})\b/i);
  if (unitMatch) {
    const m = nodes.find(
      (n) => n.type === "machine" && String(n.props?.unitNumber ?? "").toLowerCase() === unitMatch[1],
    );
    if (m) return { anchors: [m.id], clarification: null };
  }
  const serialMatch = question.match(/\b([a-z]{2,5}[-\s]?\d{3,6})\b/i);
  if (serialMatch) {
    const m = nodes.find(
      (n) => n.type === "machine" && String(n.props?.serialNumber ?? "").toLowerCase().replace(/\s/g, "") === serialMatch[1].toLowerCase().replace(/\s/g, ""),
    );
    if (m) return { anchors: [m.id], clarification: null };
  }

  // ambiguity → clarification with ≤4 tap options (§17.4.2)
  const options = nodes
    .filter((n) => n.type === "machine" && (scope.allowedSiteIds == null || scope.allowedSiteIds.includes(String(n.props?.siteId))))
    .slice(0, 4)
    .map((n) => ({ id: n.id, label: n.label }));
  if (options.length > 0) {
    return { anchors: [], clarification: { reason: "Which machine?", options } };
  }
  return { anchors: [], clarification: { reason: "No machines in scope", options: [] } };
}

export const queryContext = action({
  args: {
    question: v.string(),
    ui_context: v.optional(
      v.object({
        machineId: v.optional(v.id("machines")),
        assetId: v.optional(v.id("assets")),
        siteId: v.optional(v.id("sites")),
        faultCardId: v.optional(v.id("fixCards")),
      }),
    ),
  },
  handler: async (ctx, { question, ui_context }) => {
    const started = Date.now();
    const userId = await getAuthUserId(ctx);
    const user = userId ? await ctx.runQuery(api.users.currentUser) : null;
    if (!user) throw new Error("Sign in required");

    const scope: ScopeCtx = {
      role: user.role ?? "operator",
      allowedSiteIds: user.siteId ? [user.siteId] : null,
      ownSiteId: user.siteId ?? null,
      isCrew: isCrew(user),
    };

    const resolved = await resolveAnchors(ctx, question, ui_context, scope);
    if (resolved.clarification) {
      return { clarification: resolved.clarification };
    }

    const intent: Intent = classifyIntent(question);
    const template = POLICIES[intent];
    const graph = await buildGraph(ctx, { crew: scope.isCrew });
    const nodes = new Map<string, GNode>(graph.nodes.map((n) => [n.id, n as GNode]));
    const edges = graph.edges as unknown as GEdge[];

    // fault_help focus: the signature the query is about (latest on the anchor's
    // episodes, or the explicitly opened fault card). Episodes about other
    // components of the same machine are distractors (§17.8.11).
    let focusSignatureId: string | null = null;
    {
      const hadEps = edges
        .filter((e) => e.edgeType === "HAD" && resolved.anchors.includes(e.sourceId))
        .map((e) => nodes.get(e.targetId))
        .filter((n): n is GNode => Boolean(n) && n!.type === "episode" && !n!.props?.superseded)
        .sort((a, b) => (b!.props?.occurredAt as number ?? 0) - (a!.props?.occurredAt as number ?? 0));
      const cardSig = edges.find((e) => e.edgeType === "FIX_FOR" && e.sourceId === ui_context?.faultCardId)?.targetId;
      focusSignatureId = (cardSig as string | undefined) ?? hadEps[0]?.props?.signatureId as string | null ?? null;
    }

    const runOnce = async (widen: string | null) => {
      const rawItems = traverse({ edges, nodes, anchors: resolved.anchors, template, scope, now: Date.now(), widen, focusSignatureId });
      const manifest = gate({
        rawItems, nodes, template, queryId: "pending", role: scope.role, intent, anchors: resolved.anchors, now: Date.now(),
        widened: Boolean(widen), widenReason: widen,
      });
      const packed = packManifest(manifest.items, nodes, Date.now());
      return { manifest, packed };
    };

    let { manifest, packed } = await runOnce(null);
    let parsed: unknown = null;
    let flagged: string[] = [];
    let widened = false;
    let widenReason: string | null = null;

    const first = await groqAnswer(scope.role, question, packed).catch(() => null);
    let answer = first ? validateAnswer(first, manifest.items.map((i) => i.node_id)) : null;
    const needsMore = answer?.ok ? answer.answer?.needs_more_context : null;
    if (needsMore && !manifest.widened) {
      const suggested = needsMore.suggested_template as Intent;
      const canWiden =
        (POLICIES[intent].widen_to ?? []).includes(needsMore.reason) ||
        suggested === intent ||
        (POLICIES[intent].widen_to ?? []).length > 0;
      // controlled widening: at most once, only along widen_to (§17.4.8)
      if (canWiden) {
        widened = true;
        widenReason = needsMore.reason;
        ({ manifest, packed } = await runOnce(widenReason));
        const second = await groqAnswer(scope.role, question, packed).catch(() => null);
        answer = second ? validateAnswer(second, manifest.items.map((i) => i.node_id)) : null;
        parsed = answer?.answer ?? null;
      }
    } else {
      parsed = answer?.answer ?? null;
    }
    if (answer) flagged = answer.flagged;

    const manifestId: Id<"manifests"> = await ctx.runMutation(api.context.logManifest, {
      role: scope.role,
      intent,
      anchors: resolved.anchors as Id<"assets">[],
      items: manifest.items,
      widened,
      answer: parsed ?? undefined,
      latencyMs: Date.now() - started,
    });

    const a = answer?.answer;
    return {
      queryId: manifestId,
      answer: a?.answer ?? "No confident answer from the available context.",
      steps: a?.steps ?? [],
      citations: a?.citations ?? [],
      flaggedCitations: flagged,
      needs_more_context: a?.needs_more_context ?? null,
      manifest_summary: {
        intent,
        nodeCount: manifest.items.length,
        tokenEstimate: manifest.token_estimate,
        widened,
        widenReason,
      },
      widened,
    };
  },
});

export const logManifest = mutation({
  args: {
    role: v.string(),
    intent: v.string(),
    anchors: v.array(v.id("assets")),
    items: v.any(),
    widened: v.boolean(),
    answer: v.optional(v.any()),
    latencyMs: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("manifests", { ...args, createdAt: Date.now() });
  },
});

/** §17.6 GET /api/assets/{id}/branch — explorer debug view (engineer only). */
export const assetBranch = query({
  args: { assetId: v.id("assets"), intent: v.optional(v.string()) },
  handler: async (ctx, { assetId, intent }) => {
    const userId = await getAuthUserId(ctx);
    const user = userId ? await ctx.db.get(userId) : null;
    if (!user || !["engineer", "admin"].includes(user.role ?? "")) {
      return { forbidden: true as const };
    }
    const template = POLICIES[(intent as Intent) in POLICIES ? (intent as Intent) : "fault_help"];
    const graph = await buildGraph(ctx, { crew: false });
    const nodes = new Map<string, GNode>(graph.nodes.map((n) => [n.id, n as GNode]));
    const hadEps = (graph.edges as unknown as GEdge[])
      .filter((e) => e.edgeType === "HAD" && e.sourceId === assetId)
      .map((e) => nodes.get(e.targetId))
      .filter((n): n is GNode => Boolean(n) && n!.type === "episode")
      .sort((a, b) => (b!.props?.occurredAt as number ?? 0) - (a!.props?.occurredAt as number ?? 0));
    const rawItems = traverse({
      edges: graph.edges as unknown as GEdge[],
      nodes,
      anchors: [assetId],
      template,
      scope: { role: user.role ?? "engineer", allowedSiteIds: null, ownSiteId: null, isCrew: false },
      now: Date.now(),
      focusSignatureId: hadEps[0]?.props?.signatureId as string | null ?? null,
    });
    const manifest = gate({
      rawItems, nodes, template, queryId: "debug", role: user.role ?? "engineer",
      intent: template.intent, anchors: [assetId], now: Date.now(),
    });
    return {
      intent: template.intent,
      items: manifest.items,
      packed: packManifest(manifest.items, nodes, Date.now()),
      tokenEstimate: manifest.token_estimate,
    };
  },
});

void mutation;
