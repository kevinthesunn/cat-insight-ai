import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import { api } from "./_generated/api";
import { action, mutation, query } from "./_generated/server";
import {
  embedParts, embedText, redactText, validateExtraction,
  type ExtractionResult,
} from "./memory/core";
import {
  buildFixCardSpecs, evaluatePattern, matchSignature, withinRecurrenceWindow,
} from "./memory/domain";
import { groqCardText, groqExtract, groqTranscribe } from "./memory/groq";
import { componentKeys, recurrenceWindow } from "./memory/vocab";
import type { Id } from "./_generated/dataModel";

const DAY = 86_400_000;
const now = () => Date.now();

async function me(ctx: { db: any; auth: any }) {
  const userId = await getAuthUserId(ctx);
  return userId ? await ctx.db.get(userId) : null;
}

/** §8.1 store raw first — never block the crew on the LLM. */
export const recordEpisode = mutation({
  args: {
    machineId: v.id("machines"),
    kind: v.union(
      v.literal("voice_note"),
      v.literal("sensor_alarm"),
      v.literal("repair"),
      v.literal("inspection"),
    ),
    occurredAt: v.optional(v.number()),
    engineHours: v.optional(v.number()),
    rawText: v.optional(v.string()),
    audioBase64: v.optional(v.string()),
    mimeType: v.optional(v.string()),
    idempotencyKey: v.string(),
    hint: v.optional(v.string()), // crew's clarifying tap (§8.8)
  },
  handler: async (ctx, args) => {
    const user = await me(ctx);
    const machine = await ctx.db.get(args.machineId);
    if (!machine) throw new Error("Unknown machine");

    // §8 idempotency: client-generated key; retries never double-insert
    const existing = await ctx.db
      .query("episodes")
      .withIndex("by_idem", (q) => q.eq("idempotencyKey", args.idempotencyKey))
      .first();
    if (existing) return { episodeId: existing._id, duplicate: true };

    const site = await ctx.db.get(machine.siteId);
    const allUsers = await ctx.db.query("users").collect();
    const redacted = redactText(args.rawText ?? args.hint ?? "", {
      operatorNames: allUsers.map((u) => u.name ?? "").filter(Boolean),
      serials: [machine.serialNumber],
      unitNumbers: [machine.unitNumber ?? ""].filter(Boolean),
      locationNames: [site?.name ?? ""].filter(Boolean),
    });

    const textForEmbedding = [args.rawText, args.hint].filter(Boolean).join(" ");
    const episodeId = await ctx.db.insert("episodes", {
      machineId: args.machineId,
      siteId: machine.siteId,
      userId: user?._id,
      assetId: machine.assetId,
      kind: args.kind,
      occurredAt: args.occurredAt ?? now(),
      engineHours: args.engineHours,
      rawText: args.rawText,
      redactedText: redacted,
      embedding: embedText(textForEmbedding),
      extractionStatus: "pending",
      idempotencyKey: args.idempotencyKey,
      createdAt: now(),
    });

    await ctx.scheduler.runAfter(0, api.ingest.processEpisode, {
      episodeId,
      audioBase64: args.audioBase64,
      mimeType: args.mimeType,
      hint: args.hint,
    });
    return { episodeId, duplicate: false };
  },
});

/** Read-only view the action uses (actions have no db handle). */
export const episodeForProcessing = query({
  args: { episodeId: v.id("episodes") },
  handler: async (ctx, { episodeId }) => {
    const episode = await ctx.db.get(episodeId);
    if (!episode) return null;
    const machine = await ctx.db.get(episode.machineId);
    if (!machine) return null;
    return {
      episode: {
        _id: episode._id,
        kind: episode.kind,
        rawText: episode.rawText,
        machineId: episode.machineId,
        extractionStatus: episode.extractionStatus,
        occurredAt: episode.occurredAt,
      },
      machineClass: machine.machineClass,
      allowedComponents: componentKeys(machine.machineClass),
    };
  },
});

/** §8.2–3: transcribe (voice) + extract with the LLM; one retry, then failed. */
export const processEpisode = action({
  args: {
    episodeId: v.id("episodes"),
    audioBase64: v.optional(v.string()),
    mimeType: v.optional(v.string()),
    hint: v.optional(v.string()),
  },
  handler: async (ctx, { episodeId, audioBase64, mimeType, hint }) => {
    const data = await ctx.runQuery(api.ingest.episodeForProcessing, { episodeId });
    if (!data || data.episode.extractionStatus !== "pending") return;

    let rawText = data.episode.rawText ?? "";
    if (!rawText && audioBase64) {
      rawText = await groqTranscribe(audioBase64, mimeType ?? "audio/webm");
    }
    if (!rawText && !hint) {
      await ctx.runMutation(api.ingest.markFailed, { episodeId });
      return;
    }

    let extraction: ExtractionResult | null = null;
    for (let attempt = 0; attempt < 2 && extraction === null; attempt++) {
      try {
        const parsed = await groqExtract(
          rawText || hint || "",
          data.machineClass,
          data.allowedComponents,
          hint,
        );
        extraction = validateExtraction(parsed, rawText || hint || "", data.machineClass);
      } catch {
        extraction = null;
      }
    }
    if (!extraction) {
      await ctx.runMutation(api.ingest.markFailed, { episodeId });
      return;
    }
    await ctx.runMutation(api.ingest.finalizeExtraction, {
      episodeId,
      extraction,
      rawText,
    });
  },
});

export const markFailed = mutation({
  args: { episodeId: v.id("episodes") },
  handler: async (ctx, { episodeId }) => {
    await ctx.db.patch(episodeId, { extractionStatus: "failed" });
  },
});

/** §8.4–7: embed, normalize signature, attach state, trigger downstream work. */
export const finalizeExtraction = mutation({
  args: {
    episodeId: v.id("episodes"),
    extraction: v.any(),
    rawText: v.string(),
  },
  handler: async (ctx, { episodeId, extraction, rawText }) => {
    const ep = await ctx.db.get(episodeId);
    if (!ep) return;
    const machine = await ctx.db.get(ep.machineId);
    if (!machine) return;
    const ex = extraction as ExtractionResult;

    // §8.4 embed from structure (falls back to raw text already stored)
    const embed = embedParts([
      ex.component_label ?? ex.component,
      ex.fault_code,
      ...ex.symptoms,
      ex.action_taken,
    ]);

    // §7 normalize signature
    const candidates = await ctx.db
      .query("faultSignatures")
      .withIndex("by_class", (q) => q.eq("machineClass", machine.machineClass))
      .collect();
    const matchedId = matchSignature(
      candidates.map((c) => ({
        id: c._id,
        machineClass: c.machineClass,
        modelFamily: c.modelFamily,
        component: c.component,
        faultCode: c.faultCode,
        symptomSummary: c.symptomSummary,
        embedding: c.embedding,
        firstSeen: c.firstSeen,
        lastSeen: c.lastSeen,
      })),
      {
        machineClass: machine.machineClass,
        component: ex.component,
        faultCode: ex.fault_code,
        embedding: embed,
      },
    );
    let signatureId = matchedId;
    if (!signatureId) {
      signatureId = await ctx.db.insert("faultSignatures", {
        machineClass: machine.machineClass,
        modelFamily: machine.model,
        component: ex.component,
        faultCode: ex.fault_code ?? undefined,
        symptomSummary: ex.symptoms[0] ?? ex.component_label ?? rawText.slice(0, 80),
        embedding: embed,
        firstSeen: ep.occurredAt,
        lastSeen: ep.occurredAt,
      });
    } else {
      await ctx.db.patch(signatureId, { lastSeen: ep.occurredAt });
    }

    // §8.6 attach machine state (latest snapshot engine hours)
    let engineHours = ep.engineHours;
    if (engineHours == null) {
      const snaps = await ctx.db
        .query("machineStateSnapshots")
        .withIndex("by_machine", (q) => q.eq("machineId", ep.machineId))
        .collect();
      const latest = snaps
        .filter((s) => s.capturedAt <= ep.occurredAt)
        .sort((a, b) => b.capturedAt - a.capturedAt)[0];
      engineHours = latest?.engineHours;
    }

    await ctx.db.patch(episodeId, {
      rawText: rawText || ep.rawText,
      structured: { ...ex, hint_used: undefined },
      extractionStatus: "ok",
      signatureId,
      embedding: embed,
      engineHours,
    });

    // §9 recurrence: same signature on the same machine inside the window
    if (ep.kind === "repair") {
      await ctx.db.insert("repairs", {
        episodeId,
        signatureId,
        actionTaken: ex.action_taken ?? rawText.slice(0, 400),
        parts: ex.parts.map((p) => ({
          name: p.name,
          partNumber: p.part_number ?? undefined,
        })),
        outcomeStatus: "pending",
      });
    }
    // §9: any new episode with the same signature inside the window flips the
    // most recent preceding pending repair to `recurred`
    await flipRecurrences(ctx, machine, signatureId);

    // §10 on-write consolidation for repairs; signatures with repairs only
    if (ep.kind === "repair") {
      await ctx.scheduler.runAfter(0, api.ingest.consolidateSignature, {
        signatureId,
        useLLM: true,
      });
    }
  },
});

async function flipRecurrences(
  ctx: any,
  machine: { _id: string; machineClass: string },
  signatureId: string,
) {
  const sig = await ctx.db.get(signatureId);
  if (!sig) return;
  const window = recurrenceWindow(machine.machineClass, sig.component);
  const machineEpisodes = await ctx.db
    .query("episodes")
    .withIndex("by_machine", (q) => q.eq("machineId", machine._id))
    .collect();
  const byId = new Map(machineEpisodes.map((e) => [e._id, e]));
  const newest = byId.get(
    [...machineEpisodes]
      .filter((e) => e.signatureId === signatureId)
      .sort((a, b) => b.occurredAt - a.occurredAt)[0]?._id,
  );
  if (!newest) return;
  for (const priorEp of machineEpisodes) {
    if (priorEp.kind !== "repair" || priorEp.signatureId !== signatureId) continue;
    const priorRepairs = await ctx.db
      .query("repairs")
      .withIndex("by_episode", (q) => q.eq("episodeId", priorEp._id))
      .collect();
    for (const rep of priorRepairs) {
      if (rep.outcomeStatus !== "pending") continue;
      const prior = byId.get(rep.episodeId);
      if (!prior || prior._id === newest._id) continue;
      if (
        withinRecurrenceWindow(
          { occurredAt: prior.occurredAt, engineHours: prior.engineHours },
          { occurredAt: newest.occurredAt, engineHours: newest.engineHours },
          window,
        )
      ) {
        await ctx.db.patch(rep._id, {
          outcomeStatus: "recurred",
          recurrenceEpisodeId: newest._id,
        });
      }
    }
  }
}

export const consolidateSignature = action({
  args: { signatureId: v.id("faultSignatures"), useLLM: v.boolean() },
  handler: async (ctx, { signatureId, useLLM }) => {
    const input = await ctx.runQuery(api.ingest.consolidationInput, { signatureId });
    if (!input) return;
    const specs = buildFixCardSpecs({
      signatures: input.signatures,
      episodes: input.episodes,
      repairs: input.repairs,
      machines: input.machines,
      retiredSignatureIds: input.retiredSignatureIds,
    });
    for (const spec of specs.filter((s) => s.signatureId === signatureId)) {
      let text: { title: string; steps: string[]; caveats: string | null } | null = null;
      if (useLLM && spec.needsLLMText) {
        text = await groqCardText(
          spec.evidence.map((episodeId) => {
            const e = input.episodes.find((x) => x.id === episodeId);
            const r = input.repairs.find((x) => x.episodeId === episodeId);
            const m = input.machines.find((x) => x.id === e?.machineId);
            return {
              action: r?.actionTaken ?? "",
              parts: (r?.parts ?? []).map((p) => p.partNumber ?? p.name),
              outcome: r?.outcomeStatus ?? "unknown",
              unit: m?.unitNumber ?? m?.serialNumber ?? "unit",
              site: input.siteNames[m?.siteId ?? ""] ?? "site",
            };
          }),
        );
      }
      await ctx.runMutation(api.ingest.writeFixCard, {
        signatureId,
        title: text?.title ?? spec.title,
        steps: text?.steps ?? spec.steps,
        caveats: text?.caveats ?? spec.caveats,
        heldCount: spec.heldCount,
        recurredCount: spec.recurredCount,
        pendingCount: spec.pendingCount,
        distinctUnits: spec.distinctUnits,
        distinctSites: spec.distinctSites,
        lastUsedAt: spec.lastUsedAt,
        status: spec.status,
        evidence: spec.evidence,
      });
    }
  },
});

export const consolidationInput = query({
  args: { signatureId: v.id("faultSignatures") },
  handler: async (ctx, { signatureId }) => {
    const signature = await ctx.db.get(signatureId);
    if (!signature) return null;
    const sigEpisodes = await ctx.db
      .query("episodes")
      .withIndex("by_signature", (q) => q.eq("signatureId", signatureId))
      .collect();
    const repairEps = sigEpisodes.filter((e) => e.kind === "repair");
    const repairs = (
      await Promise.all(
        repairEps.map(async (e) => {
          const r = await ctx.db
            .query("repairs")
            .withIndex("by_episode", (q) => q.eq("episodeId", e._id))
            .first();
          return r ? { ...r, signatureId: signatureId as string | undefined, parts: r.parts } : null;
        }),
      )
    ).filter(Boolean) as any[];
    const machines = await ctx.db.query("machines").collect();
    const sites = await ctx.db.query("sites").collect();
    const clusters = await ctx.db.query("patternClusters").collect();
    const allSignatures = await ctx.db.query("faultSignatures").collect();
    return {
      signatures: allSignatures.map((s) => ({
        id: s._id,
        machineClass: s.machineClass,
        modelFamily: s.modelFamily,
        component: s.component,
        faultCode: s.faultCode,
        symptomSummary: s.symptomSummary,
        embedding: s.embedding,
        firstSeen: s.firstSeen,
        lastSeen: s.lastSeen,
      })),
      episodes: repairEps.map((e) => ({
        id: e._id,
        machineId: e.machineId,
        siteId: e.siteId,
        kind: e.kind,
        occurredAt: e.occurredAt,
        rawText: e.rawText,
        signatureId: e.signatureId,
        supersedes: e.supersedes,
      })),
      repairs: repairs.map((r) => ({
        episodeId: r.episodeId,
        signatureId: r.signatureId,
        actionTaken: r.actionTaken,
        parts: r.parts,
        outcomeStatus: r.outcomeStatus,
        outcomeResolvedAt: r.outcomeResolvedAt,
        recurrenceEpisodeId: r.recurrenceEpisodeId,
      })),
      machines: machines.map((m) => ({
        id: m._id,
        model: m.model,
        machineClass: m.machineClass,
        siteId: m.siteId,
        unitNumber: m.unitNumber,
        serialNumber: m.serialNumber,
      })),
      siteNames: Object.fromEntries(sites.map((s) => [s._id, s.name])),
      retiredSignatureIds: clusters
        .filter((c) => c.status === "fixed_in_product")
        .map((c) => c.signatureId)
        .filter(Boolean) as string[],
    };
  },
});

export const writeFixCard = mutation({
  args: {
    signatureId: v.id("faultSignatures"),
    title: v.string(),
    steps: v.array(v.string()),
    caveats: v.optional(v.string()),
    heldCount: v.number(),
    recurredCount: v.number(),
    pendingCount: v.number(),
    distinctUnits: v.number(),
    distinctSites: v.number(),
    lastUsedAt: v.optional(v.number()),
    status: v.union(
      v.literal("active"),
      v.literal("retired"),
      v.literal("needs_review"),
    ),
    evidence: v.array(v.id("episodes")),
  },
  handler: async (ctx, spec): Promise<Id<"fixCards">> => {
    const existing = await ctx.db
      .query("fixCards")
      .withIndex("by_signature", (q) => q.eq("signatureId", spec.signatureId))
      .collect();
    const match = existing.find(
      (c) =>
        (c.steps[0] ?? "").toLowerCase().slice(0, 60) ===
        (spec.steps[0] ?? "").toLowerCase().slice(0, 60),
    );
    let cardId: Id<"fixCards">;
    if (match) {
      cardId = match._id;
      await ctx.db.patch(cardId, {
        title: spec.title,
        steps: spec.steps,
        caveats: spec.caveats,
        heldCount: spec.heldCount,
        recurredCount: spec.recurredCount,
        pendingCount: spec.pendingCount,
        distinctUnits: spec.distinctUnits,
        distinctSites: spec.distinctSites,
        lastUsedAt: spec.lastUsedAt,
        status: spec.status,
        version: match.version + 1,
        updatedAt: now(),
      });
    } else {
      cardId = await ctx.db.insert("fixCards", {
        signatureId: spec.signatureId,
        title: spec.title,
        steps: spec.steps,
        parts: [],
        caveats: spec.caveats,
        heldCount: spec.heldCount,
        recurredCount: spec.recurredCount,
        pendingCount: spec.pendingCount,
        distinctUnits: spec.distinctUnits,
        distinctSites: spec.distinctSites,
        lastUsedAt: spec.lastUsedAt,
        version: 1,
        status: spec.status,
        updatedAt: now(),
      });
    }
    for (const episodeId of spec.evidence) {
      const existing = await ctx.db
        .query("fixCardEvidence")
        .withIndex("by_card", (q) =>
          q.eq("fixCardId", cardId).eq("repairEpisodeId", episodeId),
        )
        .first();
      if (!existing)
        await ctx.db.insert("fixCardEvidence", {
          fixCardId: cardId,
          repairEpisodeId: episodeId,
        });
    }
    return cardId;
  },
});

// ---- §9 outcome_sweeper: finalize elapsed recurrence windows ----
export const sweepOutcomes = mutation({
  args: {},
  handler: async (ctx) => {
    const nowTs = now();
    const pending = await ctx.db
      .query("repairs")
      .filter((q: any) => q.eq(q.field("outcomeStatus"), "pending"))
      .collect();
    let flipped = 0;
    for (const rep of pending) {
      const ep = await ctx.db.get(rep.episodeId);
      if (!ep || ep.supersedes) continue;
      const machine = await ctx.db.get(ep.machineId);
      if (!machine) continue;
      const sig = rep.signatureId ? await ctx.db.get(rep.signatureId) : null;
      if (!sig) continue;
      const window = recurrenceWindow(machine.machineClass, sig.component);
      // engine hours from the latest snapshot at sweep time when available
      const snaps = await ctx.db
        .query("machineStateSnapshots")
        .withIndex("by_machine", (q) => q.eq("machineId", ep.machineId))
        .collect();
      const latestHours = snaps
        .filter((s) => s.capturedAt <= nowTs && s.engineHours != null)
        .sort((a, b) => b.capturedAt - a.capturedAt)[0]?.engineHours;
      const elapsed = withinRecurrenceWindow(
        { occurredAt: ep.occurredAt, engineHours: ep.engineHours },
        { occurredAt: nowTs, engineHours: latestHours ?? null },
        window,
      );
      if (!elapsed) {
        await ctx.db.patch(rep._id, {
          outcomeStatus: "held",
          outcomeResolvedAt: nowTs,
        });
        flipped++;
      }
    }
    return { flipped };
  },
});

// ---- §12 pattern engine scan (idempotent upserts) ----
export const runPatternScan = mutation({
  args: {},
  handler: async (ctx) => {
    const nowTs = now();
    const signatures = await ctx.db.query("faultSignatures").collect();
    const episodes = (await ctx.db.query("episodes").collect()).filter(
      (e) => e.signatureId && !e.supersedes,
    );
    const repairs = await ctx.db.query("repairs").collect();
    const machines = await ctx.db.query("machines").collect();
    const snapshots = await ctx.db.query("machineStateSnapshots").collect();
    const machineAttrs: Record<string, { firmware?: string | null; attachment?: string | null }> = {};
    for (const s of snapshots.sort((a, b) => b.capturedAt - a.capturedAt)) {
      if (!machineAttrs[s.machineId]) {
        machineAttrs[s.machineId] = { firmware: s.firmware, attachment: s.attachment };
      }
    }
    const openBySignature = new Map<string, any>();
    for (const c of await ctx.db.query("patternClusters").collect()) {
      if (c.signatureId && ["new", "investigating", "known_issue"].includes(c.status)) {
        openBySignature.set(c.signatureId, c);
      }
    }

    const raised: string[] = [];
    for (const sig of signatures) {
      const evalRes = evaluatePattern({
        signature: {
          id: sig._id,
          machineClass: sig.machineClass,
          modelFamily: sig.modelFamily,
          component: sig.component,
          faultCode: sig.faultCode,
          symptomSummary: sig.symptomSummary,
          embedding: sig.embedding,
          firstSeen: sig.firstSeen,
          lastSeen: sig.lastSeen,
        },
        episodes: episodes.map((e) => ({
          id: e._id,
          machineId: e.machineId,
          siteId: e.siteId,
          kind: e.kind,
          occurredAt: e.occurredAt,
          signatureId: e.signatureId,
          supersedes: e.supersedes,
        })),
        repairs: repairs.map((r) => ({
          episodeId: r.episodeId,
          signatureId: r.signatureId,
          actionTaken: r.actionTaken,
          parts: r.parts,
          outcomeStatus: r.outcomeStatus,
        })),
        machines: machines.map((m) => ({
          id: m._id,
          model: m.model,
          machineClass: m.machineClass,
          siteId: m.siteId,
          unitNumber: m.unitNumber,
          serialNumber: m.serialNumber,
        })),
        machineAttrs,
        now: nowTs,
        hasOpenCluster: openBySignature.has(sig._id),
      });
      if (!evalRes.raise && !evalRes.watch) continue;
      const open = openBySignature.get(sig._id);
      let clusterId: string;
      if (open) {
        clusterId = open._id;
        await ctx.db.patch(clusterId, {
          unitCount: evalRes.unitCount,
          siteCount: evalRes.siteCount,
          episodeCount: evalRes.episodeCount,
          baselineRate: evalRes.baselineRate,
          observedRate: evalRes.observedRate,
          score: evalRes.score,
          windowStart: evalRes.windowStart,
          windowEnd: evalRes.windowEnd,
          sharedHints: evalRes.hints,
          updatedAt: nowTs,
        });
      } else {
        clusterId = await ctx.db.insert("patternClusters", {
          signatureId: sig._id,
          windowStart: evalRes.windowStart,
          windowEnd: evalRes.windowEnd,
          unitCount: evalRes.unitCount,
          siteCount: evalRes.siteCount,
          episodeCount: evalRes.episodeCount,
          baselineRate: evalRes.baselineRate,
          observedRate: evalRes.observedRate,
          score: evalRes.score,
          status: "new",
          sharedHints: evalRes.hints,
          updatedAt: nowTs,
        });
      }
      // idempotent member sync
      const existingMembers = await ctx.db
        .query("patternClusterMembers")
        .withIndex("by_cluster", (q) => q.eq("clusterId", clusterId))
        .collect();
      const have = new Set(existingMembers.map((m) => m.episodeId));
      for (const epId of evalRes.memberIds) {
        if (!have.has(epId as Id<"episodes">)) {
          await ctx.db.insert("patternClusterMembers", {
            clusterId,
            episodeId: epId as Id<"episodes">,
          });
        }
      }
      raised.push(String(clusterId));
    }
    return { raised };
  },
});
