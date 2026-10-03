import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import { api } from "./_generated/api";
import { mutation, query } from "./_generated/server";
import { embedText, findFaultCodes } from "./memory/core";
import {
  rankFixCards, type EpisodeLike, type FixCardLike, type MachineLike, type SignatureLike,
} from "./memory/domain";
import type { Id, Doc } from "./_generated/dataModel";

type Ctx = { db: any; auth: any };
type UserDoc = Doc<"users"> | null;

async function me(ctx: Ctx): Promise<UserDoc> {
  const userId = await getAuthUserId(ctx);
  return userId ? await ctx.db.get(userId) : null;
}

export function isCrew(user: UserDoc): boolean {
  return !user?.role || user.role === "operator" || user.role === "technician" || user.role === "manager";
}

export function canSeeRaw(user: UserDoc): boolean {
  return user?.role === "engineer" || user?.role === "admin";
}

/** Sites aliased "Site A/B/C" by creation order (§13 cross-site redaction). */
export async function siteAliases(ctx: Ctx): Promise<Map<string, { alias: string; name: string }>> {
  const sites = (await ctx.db.query("sites").collect()).sort((a: any, b: any) => a.createdAt - b.createdAt);
  const map = new Map<string, { alias: string; name: string }>();
  sites.forEach((s: any, i: number) => {
    map.set(s._id, { alias: `Site ${String.fromCharCode(65 + i)}`, name: s.name });
  });
  return map;
}

async function latestSnapshot(ctx: Ctx, machineId: string, now: number) {
  const snaps = await ctx.db
    .query("machineStateSnapshots")
    .withIndex("by_machine", (q) => q.eq("machineId", machineId as Id<"machines">))
    .collect();
  return snaps.filter((s) => s.capturedAt <= now).sort((a, b) => b.capturedAt - a.capturedAt)[0] ?? null;
}

/** §5/§11 find_fixes — the crew loop (acceptance 2). */
export const findFixes = query({
  args: {
    machineId: v.id("machines"),
    episodeId: v.optional(v.id("episodes")),
    queryText: v.optional(v.string()),
    now: v.number(),
  },
  handler: async (ctx, { machineId, episodeId, queryText, now }) => {
    const user = await me(ctx);
    if (!user) return null;
    const machine = await ctx.db.get(machineId);
    if (!machine) return null;
    if (isCrew(user) && machine.siteId !== user.siteId) return { forbidden: true as const };

    let queryEmbedding: number[];
    let queryCode: string | null = null;
    let matchedSignatureId: Id<"faultSignatures"> | null = null;
    if (episodeId) {
      const ep = await ctx.db.get(episodeId);
      if (ep) {
        queryEmbedding = ep.embedding ?? embedText(ep.rawText ?? "");
        queryCode = (ep.structured as any)?.fault_code ?? null;
        matchedSignatureId = ep.signatureId ?? null;
      } else queryEmbedding = embedText("");
    } else if (queryText && queryText.trim()) {
      queryEmbedding = embedText(queryText);
      queryCode = findFaultCodes(queryText)[0] ?? null;
    } else {
      const machineEps = await ctx.db
        .query("episodes")
        .withIndex("by_machine", (q) => q.eq("machineId", machineId))
        .collect();
      const latest = machineEps
        .filter((e) => e.embedding && !e.supersedes)
        .sort((a, b) => b.occurredAt - a.occurredAt)[0];
      queryEmbedding = latest?.embedding ?? embedText("");
      queryCode = (latest?.structured as any)?.fault_code ?? null;
      matchedSignatureId = latest?.signatureId ?? null;
    }

    const signatures = await ctx.db
      .query("faultSignatures")
      .withIndex("by_class", (q) => q.eq("machineClass", machine.machineClass))
      .collect();
    const sigMap = new Map<string, SignatureLike>(
      signatures.map((s) => [s._id, { id: s._id, machineClass: s.machineClass, modelFamily: s.modelFamily, component: s.component, faultCode: s.faultCode, symptomSummary: s.symptomSummary, embedding: s.embedding, firstSeen: s.firstSeen, lastSeen: s.lastSeen }]),
    );

    const allCards = await ctx.db.query("fixCards").collect();
    const cards: FixCardLike[] = [];
    for (const c of allCards) {
      const sig = sigMap.get(c.signatureId);
      if (!sig) continue;
      cards.push({
        id: c._id, signatureId: c.signatureId, title: c.title, steps: c.steps,
        parts: c.parts, caveats: c.caveats, heldCount: c.heldCount,
        recurredCount: c.recurredCount, pendingCount: c.pendingCount,
        distinctUnits: c.distinctUnits, distinctSites: c.distinctSites,
        lastUsedAt: c.lastUsedAt, status: c.status,
      });
    }

    const snap = await latestSnapshot(ctx, machineId, now);
    const { ranked, noConfidentMatch } = rankFixCards(
      cards,
      sigMap,
      {
        queryEmbedding,
        queryFaultCode: queryCode,
        queryMachine: { id: machine._id, model: machine.model, machineClass: machine.machineClass, siteId: machine.siteId, unitNumber: machine.unitNumber, serialNumber: machine.serialNumber },
        queryFirmware: snap?.firmware ?? null,
        queryAttachment: snap?.attachment ?? null,
        now,
      },
      3,
    );

    // evidence lines with §13 redaction
    const aliases = await siteAliases(ctx);
    const crew = isCrew(user);
    const withEvidence = [] as any[];
    for (const r of ranked) {
      const rows = await ctx.db
        .query("fixCardEvidence")
        .withIndex("by_card", (q) => q.eq("fixCardId", r.card.id as Id<"fixCards">))
        .collect();
      const evidence = [] as any[];
      for (const row of rows.slice(0, 6)) {
        const ep = await ctx.db.get(row.repairEpisodeId);
        if (!ep || ep.supersedes) continue;
        const alias = aliases.get(ep.siteId ?? "") ?? { alias: "another site", name: "" };
        evidence.push({
          episodeId: ep._id,
          siteLabel: crew ? alias.alias : `${alias.name} (${alias.alias})`,
          at: ep.occurredAt,
          outcome: "episode",
          snippet: crew ? (ep.redactedText ?? "").slice(0, 140) : (ep.rawText ?? "").slice(0, 240),
        });
      }
      withEvidence.push({
        cardId: r.card.id,
        title: r.card.title,
        steps: r.card.steps,
        parts: r.card.parts,
        caveats: r.card.caveats,
        held: r.card.heldCount,
        recurred: r.card.recurredCount,
        pending: r.card.pendingCount,
        distinctUnits: r.card.distinctUnits,
        distinctSites: r.card.distinctSites,
        lastUsedAt: r.card.lastUsedAt,
        guidanceNote: r.card.guidanceNote,
        score: r.score,
        breakdown: r.breakdown,
        confident: r.confident,
        evidence,
        matchedSignatureId,
      });
    }
    return {
      machine: { id: machine._id, unitNumber: machine.unitNumber, model: machine.model, machineClass: machine.machineClass },
      ranked: withEvidence,
      noConfidentMatch,
    };
  },
});

/** §5 machine_history — role-scoped, redacted for crew. */
export const machineHistory = query({
  args: { machineId: v.id("machines"), limit: v.optional(v.number()) },
  handler: async (ctx, { machineId, limit }) => {
    const user = await me(ctx);
    if (!user) return null;
    const machine = await ctx.db.get(machineId);
    if (!machine) return null;
    if (isCrew(user) && machine.siteId !== user.siteId) return { forbidden: true as const };
    const crew = isCrew(user);
    const eps = await ctx.db
      .query("episodes")
      .withIndex("by_machine", (q) => q.eq("machineId", machineId))
      .collect();
    const sigs = new Map<string, Doc<"faultSignatures">>();
    const out = [] as any[];
    for (const ep of eps.sort((a, b) => b.occurredAt - a.occurredAt).slice(0, limit ?? 50)) {
      if (ep.supersedes) continue;
      let sigLabel: string | null = null;
      if (ep.signatureId) {
        if (!sigs.has(ep.signatureId)) sigs.set(ep.signatureId, (await ctx.db.get(ep.signatureId))!);
        const s = sigs.get(ep.signatureId);
        sigLabel = s ? `${s.component.replace(/_/g, " ")}${s.faultCode ? ` (${s.faultCode})` : ""}` : null;
      }
      out.push({
        id: ep._id,
        kind: ep.kind,
        at: ep.occurredAt,
        text: crew ? (ep.redactedText ?? "") : (ep.rawText ?? ""),
        severity: (ep.structured as any)?.severity ?? null,
        component: (ep.structured as any)?.component ?? null,
        signatureLabel: sigLabel,
        extractionStatus: ep.extractionStatus,
        flagged: ep.flaggedForEngineer ?? false,
      });
    }
    return { episodes: out, machine: { id: machine._id, unitNumber: machine.unitNumber, model: machine.model, machineClass: machine.machineClass } };
  },
});

/** Crew poll after send: pipeline status + fixes (uses embeddings while pending — acceptance 2). */
export const episodeStatus = query({
  args: { episodeId: v.id("episodes"), now: v.number() },
  handler: async (ctx, { episodeId, now }) => {
    const user = await me(ctx);
    if (!user) return null;
    const ep = await ctx.db.get(episodeId);
    if (!ep) return null;
    const crew = isCrew(user);
    const fixes = await ctx.runQuery(api.store.findFixes, {
      machineId: ep.machineId,
      episodeId,
      now,
    });
    return {
      extractionStatus: ep.extractionStatus,
      structured: crew
        ? { component: (ep.structured as any)?.component, severity: (ep.structured as any)?.severity }
        : ep.structured,
      signatureId: ep.signatureId,
      flagged: ep.flaggedForEngineer ?? false,
      fixes,
    };
  },
});

/** §5 record_outcome — crew taps worked / didn't work / haven't tried (§9: signal, not ground truth). */
export const recordFeedback = mutation({
  args: {
    fixCardId: v.id("fixCards"),
    machineId: v.optional(v.id("machines")),
    verdict: v.union(v.literal("worked"), v.literal("didnt_work"), v.literal("not_tried")),
  },
  handler: async (ctx, { fixCardId, machineId, verdict }) => {
    const user = await me(ctx);
    await ctx.db.insert("feedback", {
      fixCardId,
      machineId,
      userId: user?._id,
      verdict,
      createdAt: Date.now(),
    });
  },
});

/** §13 deletion: tombstone via correction episode + consolidation rebuild. */
export const deleteEpisode = mutation({
  args: { episodeId: v.id("episodes") },
  handler: async (ctx, { episodeId }) => {
    const user = await me(ctx);
    if (!canSeeRaw(user) && user?.role !== "manager") throw new Error("Not allowed");
    const ep = await ctx.db.get(episodeId);
    if (!ep || ep.supersedes) return;
    await ctx.db.insert("episodes", {
      machineId: ep.machineId,
      siteId: ep.siteId,
      userId: user?._id,
      assetId: ep.assetId,
      kind: "correction",
      occurredAt: Date.now(),
      rawText: `Deletion of episode ${episodeId}`,
      redactedText: "[deleted]",
      embedding: [],
      structured: { deleted: true, supersedes: episodeId },
      extractionStatus: "ok",
      signatureId: ep.signatureId,
      supersedes: episodeId,
      createdAt: Date.now(),
    });
    if (ep.kind === "repair" && ep.signatureId) {
      await ctx.scheduler.runAfter(0, api.ingest.consolidateSignature, {
        signatureId: ep.signatureId,
        useLLM: false,
      });
    }
  },
});

/** §13 raw access is engineer/admin-only and audit-logged. */
export const revealRawEpisode = mutation({
  args: { episodeId: v.id("episodes") },
  handler: async (ctx, { episodeId }) => {
    const user = await me(ctx);
    if (!canSeeRaw(user)) throw new Error("Engineer access required");
    await ctx.db.insert("auditLog", {
      actorId: user!._id,
      action: "read_raw_episode",
      targetType: "episode",
      targetId: episodeId,
      createdAt: Date.now(),
    });
    const ep = await ctx.db.get(episodeId);
    return { rawText: ep?.rawText ?? "", audioUri: ep?.audioUri ?? null };
  },
});

export const setDefaultMachine = mutation({
  args: { machineId: v.id("machines") },
  handler: async (ctx, { machineId }) => {
    const user = await me(ctx);
    if (!user) throw new Error("Sign in required");
    await ctx.db.patch(user._id, { defaultMachineId: machineId });
  },
});

export const flagEpisode = mutation({
  args: { episodeId: v.id("episodes") },
  handler: async (ctx, { episodeId }) => {
    await ctx.db.patch(episodeId, { flaggedForEngineer: true });
  },
});

/** Crew app bootstrap: me + my site machines + aliases. */
export const crewBootstrap = query({
  args: {},
  handler: async (ctx) => {
    const user = await me(ctx);
    if (!user) return null;
    const aliases = await siteAliases(ctx);
    const site = user.siteId ? await ctx.db.get(user.siteId) : null;
    const machines = user.siteId
      ? await ctx.db
          .query("machines")
          .withIndex("by_site", (q) => q.eq("siteId", user.siteId!))
          .collect()
      : [];
    return {
      user: { id: user._id, name: user.name, role: user.role, defaultMachineId: user.defaultMachineId },
      site: site ? { id: site._id, name: site.name, alias: aliases.get(site._id)?.alias ?? "" } : null,
      machines: machines.map((m) => ({
        id: m._id,
        unitNumber: m.unitNumber,
        model: m.model,
        machineClass: m.machineClass,
        serialNumber: m.serialNumber,
        qrTag: m.qrTag,
      })),
    };
  },
});
