import { v } from "convex/values";
import { api } from "./_generated/api";
import { mutation } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { embedParts, embedText } from "./memory/core";
import { buildFixCardSpecs } from "./memory/domain";

const DAY = 86_400_000;

function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const seedSiteMemory = mutation({
  args: {},
  handler: async (ctx) => {
    if ((await ctx.db.query("sites").collect()).length > 0) {
      return { seeded: false };
    }
    const rng = mulberry32(20261003);
    const NOW = Date.now();
    const pick = <T>(arr: T[]): T => arr[Math.floor(rng() * arr.length)];

    // ---- sites (aliased Site A/B/C by creation order) ----
    const siteDefs = [
      { name: "Ajax Quarry", region: "Northeast" },
      { name: "Bellville Mine", region: "Southwest" },
      { name: "Corrigan Port", region: "Gulf" },
    ];
    const siteIds: Id<"sites">[] = [];
    for (const s of siteDefs) {
      siteIds.push(
        (await ctx.db.insert("sites", { name: s.name, region: s.region, createdAt: NOW - 400 * DAY })) as Id<"sites">,
      );
      await ctx.db.insert("assets", {
        kind: "site",
        name: s.name,
        path: `s${siteIds.length - 1}`,
        createdAt: NOW - 400 * DAY,
      });
    }

    // ---- machines: 40 across 4 models / 2 classes ----
    const machineDefs: Array<{ model: string; cls: string; site: number; n: number }> = [
      ...Array.from({ length: 12 }, (_, i) => ({ model: "336", cls: "excavator", site: i % 3, n: i })),
      ...Array.from({ length: 8 }, (_, i) => ({ model: "320", cls: "excavator", site: i % 3, n: i })),
      ...Array.from({ length: 10 }, (_, i) => ({ model: "D8", cls: "dozer", site: i % 3, n: i })),
      ...Array.from({ length: 10 }, (_, i) => ({ model: "D6", cls: "dozer", site: i % 3, n: i })),
    ];
    const systems = ["Hydraulics", "Engine", "Powertrain", "Undercarriage", "Electrical", "Cab"];
    const machineIds: Id<"machines">[] = [];
    const machineAssetIds: Id<"assets">[] = [];
    const machineInfo: Array<{ id: Id<"machines">; assetId: Id<"assets">; siteId: Id<"sites">; model: string; cls: string; serial: string; unit: string }> = [];
    for (const d of machineDefs) {
      const serial = `SIM-${d.model}-${String(d.n + 1).padStart(3, "0")}`;
      const unit = `Unit ${machineIds.length + 1}`;
      const siteId = siteIds[d.site];
      const machineId = (await ctx.db.insert("machines", {
        serialNumber: serial,
        unitNumber: unit,
        model: d.model,
        machineClass: d.cls,
        siteId,
        qrTag: `QR-${serial}`,
        createdAt: NOW - 380 * DAY,
      })) as Id<"machines">;
      const mAsset = (await ctx.db.insert("assets", {
        parentId: (await ctx.db.query("assets").withIndex("by_path", (q) => q.eq("path", `s${d.site}`)).first())!._id,
        kind: "machine",
        name: `${d.model} ${unit}`,
        serialNumber: serial,
        model: d.model,
        path: `s${d.site}/m${machineIds.length + 1}`,
        createdAt: NOW - 380 * DAY,
      })) as Id<"assets">;
      await ctx.db.patch(machineId, { assetId: mAsset });
      for (let si = 0; si < systems.length; si++) {
        await ctx.db.insert("assets", {
          parentId: mAsset,
          kind: "system",
          name: systems[si],
          path: `s${d.site}/m${machineIds.length + 1}/sys${si}`,
          createdAt: NOW - 380 * DAY,
        });
      }
      machineIds.push(machineId);
      machineAssetIds.push(mAsset);
      machineInfo.push({ id: machineId, assetId: mAsset, siteId, model: d.model, cls: d.cls, serial, unit });
    }

    // component assets for the fault-relevant components (+ 2 swaps for §17.1)
    const componentPlans: Array<{ mi: number; comp: string; label: string; swap?: boolean }> = [
      { mi: 0, comp: "hydraulic_pump", label: "Main hydraulic pump", swap: true }, // replaced 60d ago
      { mi: 2, comp: "hydraulic_pump", label: "Main hydraulic pump", swap: true }, // replaced 200d ago
      { mi: 1, comp: "hydraulic_pump", label: "Main hydraulic pump" },
      { mi: 3, comp: "hydraulic_pump", label: "Main hydraulic pump" },
      { mi: 4, comp: "track_tensioner", label: "Track tensioner" },
      { mi: 5, comp: "engine_turbo", label: "Engine turbocharger" },
      { mi: 8, comp: "final_drive", label: "Final drive" },
      { mi: 9, comp: "fuel_injector", label: "Fuel injector" },
      { mi: 14, comp: "hydraulic_pump", label: "Main hydraulic pump" },
      { mi: 22, comp: "hydraulic_pump", label: "Main hydraulic pump" },
      { mi: 23, comp: "track_tensioner", label: "Track tensioner" },
      { mi: 26, comp: "final_drive", label: "Final drive" },
    ];
    for (const p of componentPlans) {
      const info = machineInfo[p.mi];
      const siteIdx = siteIds.indexOf(info.siteId);
      const parentSystem = (
        await ctx.db
          .query("assets")
          .withIndex("by_path", (q) => q.eq("path", `s${siteIdx}/m${p.mi + 1}/sys0`))
          .first()
      )!;
      if (p.swap) {
        await ctx.db.insert("assets", {
          parentId: parentSystem._id,
          kind: "component",
          name: `${p.label} (old)`,
          partNumber: "1R-9901",
          path: `s${siteIdx}/m${p.mi + 1}/sys0/${p.comp}-old`,
          installedAt: NOW - 370 * DAY,
          removedAt: NOW - 200 * DAY,
          createdAt: NOW - 370 * DAY,
        });
        await ctx.db.insert("assets", {
          parentId: parentSystem._id,
          kind: "component",
          name: p.label,
          partNumber: "1R-0749",
          path: `s${siteIdx}/m${p.mi + 1}/sys0/${p.comp}`,
          installedAt: NOW - 200 * DAY,
          createdAt: NOW - 200 * DAY,
        });
      } else {
        await ctx.db.insert("assets", {
          parentId: parentSystem._id,
          kind: "component",
          name: p.label,
          partNumber: "1R-0749",
          path: `s${siteIdx}/m${p.mi + 1}/sys0/${p.comp}`,
          installedAt: NOW - 370 * DAY,
          createdAt: NOW - 370 * DAY,
        });
      }
    }

    // ---- snapshots: firmware / hours per machine (monthly, 6 months) ----
    // planted units run firmware 3.2.14; everyone else 3.2.12
    const plantedUnits = [1, 4, 14, 22]; // 2 at Site A(0), 2 at Site B(1) — via machineDefs indexes
    for (let i = 0; i < machineInfo.length; i++) {
      const info = machineInfo[i];
      const firmware = plantedUnits.includes(i) ? "3.2.14" : "3.2.12";
      const attachment = i % 3 === 0 ? "GP bucket" : i % 3 === 1 ? "Hyd hammer" : "GP bucket";
      for (let m = 6; m >= 1; m--) {
        await ctx.db.insert("machineStateSnapshots", {
          machineId: info.id,
          capturedAt: NOW - m * 30 * DAY,
          engineHours: 3000 + (6 - m) * 180 + Math.floor(rng() * 40),
          firmware,
          attachment,
        });
      }
    }

    // ---- signatures (pre-authored semantic identities) ----
    type SigDef = { cls: string; component: string; code: string | null; summary: string; model?: string };
    const sigDefs: SigDef[] = [
      { cls: "excavator", component: "hydraulic_pump", code: null, summary: "pump whining, loses power under load" },
      { cls: "excavator", component: "track_tensioner", code: null, summary: "track loose on tight turns" },
      { cls: "excavator", component: "engine_turbo", code: null, summary: "whistle noise, low power up hills" },
      { cls: "excavator", component: "fuel_injector", code: "94-11", summary: "running rough, white smoke, hard start" },
      { cls: "excavator", component: "final_drive", code: null, summary: "clunking from final drive when slewing" },
      { cls: "excavator", component: "hydraulic_hose", code: null, summary: "hose weeping at boom fitting" },
      { cls: "dozer", component: "hydraulic_pump", code: null, summary: "pump noisy cold, fades when warm" },
      { cls: "dozer", component: "track_tensioner", code: null, summary: "left track slack, squeals on grading" },
      { cls: "dozer", component: "final_drive", code: "132-9", summary: "final drive leak, oil on tracks" },
      { cls: "dozer", component: "electrical_harness", code: null, summary: "dash lights flicker, intermittent faults" },
    ];
    const sigIds: Id<"faultSignatures">[] = [];
    for (const s of sigDefs) {
      sigIds.push(
        (await ctx.db.insert("faultSignatures", {
          machineClass: s.cls,
          modelFamily: s.model ?? undefined,
          component: s.component,
          faultCode: s.code ?? undefined,
          symptomSummary: s.summary,
          embedding: embedParts([s.component.replace(/_/g, " "), s.code, s.summary]),
          firstSeen: NOW - 170 * DAY,
          lastSeen: NOW - 1 * DAY,
        })) as Id<"faultSignatures">,
      );
    }

    // episode factory
    const users = await ctx.db.query("users").collect();
    const userNames = users.map((u: any) => u.name).filter(Boolean) as string[];
    const actor = () => (userNames.length ? pick(userNames) : "Crew");
    let epSeq = 0;
    const addEpisode = async (
      mi: number,
      kind: "voice_note" | "sensor_alarm" | "repair" | "inspection",
      daysAgo: number,
      raw: string,
      sigIdx: number,
      structuredExtra: Record<string, unknown> = {},
    ) => {
      const info = machineInfo[mi];
      const sig = sigDefs[sigIdx];
      const occurredAt = NOW - daysAgo * DAY - Math.floor(rng() * DAY);
      const structured = {
        kind_confirmed: kind,
        component: sig.component,
        component_label: null,
        fault_code: sig.code,
        symptoms: [raw.slice(0, 80)],
        severity: kind === "repair" ? "stopped" : raw.includes("derate") || raw.includes("dead") ? "stopped" : "degraded",
        action_taken: kind === "repair" ? raw : null,
        parts: [],
        resolved_by_crew: kind === "repair",
        confidence: 0.9,
        ...structuredExtra,
      };
      epSeq++;
      return await ctx.db.insert("episodes", {
        machineId: info.id,
        siteId: info.siteId,
        assetId: info.assetId,
        kind,
        occurredAt,
        engineHours: 3000 + (180 - daysAgo) * 1,
        rawText: raw,
        redactedText: raw,
        structured,
        extractionStatus: "ok" as const,
        signatureId: sigIds[sigIdx],
        embedding: embedParts([sig.component.replace(/_/g, " "), sig.code, raw]),
        idempotencyKey: `seed-${epSeq}`,
        createdAt: occurredAt,
      });
    };

    // repair factory (repairs table + outcome bookkeeping)
    const addRepair = async (
      mi: number,
      daysAgo: number,
      action: string,
      sigIdx: number,
      outcome: "held" | "recurred" | "pending",
      parts: Array<{ name: string; partNumber?: string }> = [],
      recurrenceEpisodeId?: string,
    ) => {
      const epId = (await addEpisode(mi, "repair", daysAgo, action, sigIdx)) as Id<"episodes">;
      await ctx.db.insert("repairs", {
        episodeId: epId,
        signatureId: sigIds[sigIdx],
        actionTaken: action,
        parts,
        outcomeStatus: outcome,
        outcomeResolvedAt: outcome === "held" ? NOW - (daysAgo - 20) * DAY : undefined,
        recurrenceEpisodeId: recurrenceEpisodeId as never,
      });
      return epId;
    };

    const PUMP = 0, TRACKX = 1, TURBO = 2, INJ = 3, FD = 4, HOSE = 5, PUMPD = 6, TRACKD = 7, FDD = 8, ELEC = 9;

    // ---- planted pattern: excavator hydraulic pump, 4 units / 2 sites, last 21 days ----
    // prior history: 3 repairs 3-6 weeks ago (2 held, 1 recurred) → the fix card
    const plantedRepairs: Array<{ mi: number; days: number; action: string; outcome: "held" | "recurred"; parts: Array<{ name: string; partNumber?: string }> }> = [
      { mi: 0, days: 38, action: "Replace main pump inlet hose and coupling, refill and bleed the hydraulics", outcome: "held", parts: [{ name: "Inlet hose", partNumber: "1R-3451" }] },
      { mi: 2, days: 33, action: "Swap pump inlet hose and coupling, bleed the system, test cycle", outcome: "held", parts: [{ name: "Inlet hose", partNumber: "1R-3451" }] },
      { mi: 5, days: 30, action: "Tighten pump inlet clamp only", outcome: "recurred", parts: [] },
    ];
    for (const r of plantedRepairs) await addRepair(r.mi, r.days, r.action, PUMP, r.outcome, r.parts);
    // fresh alarms/voice notes on 4 units (2 sites) in the last 3 weeks
    const plantedFresh: Array<[number, number, string]> = [
      [1, 18, "main pump is whining like crazy and she loses power when I load the bucket"],
      [4, 14, "hydro pump screaming, machine feels weak digging, almost derates"],
      [14, 10, "ALARM 336 hydraulic pump pressure low — derate active, whine at high load"],
      [22, 6, "pump noise and barely digs, feels like the hydraulics gave up"],
      [1, 4, "same pump whine again after warmup, worse than yesterday"],
    ];
    for (const [mi, days, raw] of plantedFresh) {
      await addEpisode(mi, raw.startsWith("ALARM") ? "sensor_alarm" : "voice_note", days, raw, PUMP);
    }
    // a pending repair attempt inside the window on one planted unit
    await addRepair(1, 8, "Replaced pump inlet hose with 1R-3451, bled system", PUMP, "pending", [{ name: "Inlet hose", partNumber: "1R-3451" }]);

    // ---- baseline noise: other signatures over 6 months, plus a high-volume but
    // baseline-normal signature (track_tensioner) that must NOT be raised (§14.6) ----
    const phrases: Record<number, string[]> = {
      [TRACKX]: ["track feels loose on tight turns", "left track squealing, tension off", "track slack, keeps throwing itself", "grease cylinder on track loses pressure", "track jumps off in soft mud", "tensioner feels soft, track clunks"],
      [TURBO]: ["whistling from the turbo, no boost on hills", "turbo whines then power drops off", "looks like a boost leak, whistle at RPM"],
      [INJ]: ["engine running rough, white smoke at startup", "hard start in the morning, white smoke", "missing under load, smells rich"],
      [FD]: ["clunk from the final drive when slewing", "final drive grinding on swing", "slew makes a bang, final drive noisy"],
      [HOSE]: ["small weep at the boom hose fitting", "boom hose damp, wiping oil daily", "hose seep at the fitting, watching it"],
      [PUMPD]: ["dozer pump noisy cold then fades", "hydraulics loud first hour, then quiet", "pump wine cold start on the D6"],
      [TRACKD]: ["left track slack on the dozer", "track squeals while grading, tension low", "D8 track keeps going loose"],
      [FDD]: ["final drive oil on the tracks, leak", "dozer final drive seep, code 132-9 up", "oil weeping at the final drive hub"],
      [ELEC]: ["dash lights flicker, electrical faults come and go", "wiring gremlin, screen resets itself", "intermittent fault lights, harness looks fine"],
    };
    // track_tensioner: HIGH volume in-window but matching a high baseline → not surfaced
    for (let k = 0; k < 40; k++) {
      const mi = Math.floor(rng() * machineInfo.length);
      if (machineInfo[mi].cls !== "excavator") continue;
      await addEpisode(mi, "voice_note", 20 + Math.floor(rng() * 150), pick(phrases[TRACKX]), TRACKX);
    }
    for (let k = 0; k < 6; k++) {
      const mi = pick([3, 7, 11, 16, 25, 31]);
      await addEpisode(mi, "voice_note", Math.floor(rng() * 28), pick(phrases[TRACKX]), TRACKX);
    }
    for (const [sigIdx, list] of [[TURBO, 9], [INJ, 8], [FD, 7], [HOSE, 6], [PUMPD, 8], [TRACKD, 7], [FDD, 6], [ELEC, 5]] as const) {
      for (let k = 0; k < list; k++) {
        const cls = sigDefs[sigIdx].cls;
        const candidates = machineInfo.map((info, idx) => ({ info, idx })).filter((x) => x.info.cls === cls);
        const chosen = pick(candidates);
        await addEpisode(chosen.idx, rng() < 0.6 ? "voice_note" : "sensor_alarm", Math.floor(rng() * 170), pick(phrases[sigIdx]), sigIdx);
      }
    }

    // repairs for the other signatures so several fix cards exist
    await addRepair(9, 60, "Shim and re-grease the track tensioner, check the grease cylinder seal", TRACKX, "held", []);
    await addRepair(16, 52, "Replace track tensioner grease cylinder and re-tension", TRACKX, "held", [{ name: "Grease cylinder", partNumber: "4I-7388" }]);
    await addRepair(23, 95, "Replace final drive oil seal and top off oil", FDD, "held", [{ name: "Drive seal", partNumber: "9S-8081" }]);
    await addRepair(26, 88, "Replace final drive seal, flush and refill", FDD, "recurred", [{ name: "Drive seal", partNumber: "9S-8081" }]);
    await addRepair(23, 60, "Repair harness chafe at the dash, re-pin connector", ELEC, "held", []);

    // ---- consolidation: derive fix cards from episodes alone (§10, §14.5) ----
    const allEpisodes: any[] = (await ctx.db.query("episodes").collect()).map((e: any) => ({
      id: e._id, machineId: e.machineId, siteId: e.siteId, kind: e.kind,
      occurredAt: e.occurredAt, rawText: e.rawText, signatureId: e.signatureId,
      supersedes: e.supersedes, embedding: e.embedding,
    }));
    const allRepairs: any[] = (await ctx.db.query("repairs").collect()).map((r: any) => ({
      episodeId: r.episodeId, signatureId: r.signatureId, actionTaken: r.actionTaken,
      parts: r.parts, outcomeStatus: r.outcomeStatus,
    }));
    const specs = buildFixCardSpecs({
      signatures: sigDefs.map((s, i) => ({
        id: sigIds[i], machineClass: s.cls, modelFamily: s.model ?? null,
        component: s.component,          faultCode: s.code ?? undefined, symptomSummary: s.summary,
        embedding: embedParts([s.component.replace(/_/g, " "), s.code, s.summary]),
        firstSeen: NOW - 170 * DAY, lastSeen: NOW,
      })),
      episodes: allEpisodes,
      repairs: allRepairs,
      machines: machineInfo.map((m) => ({ id: m.id, model: m.model, machineClass: m.cls, siteId: m.siteId, unitNumber: m.unit, serialNumber: m.serial })),
    });
    for (const spec of specs) {
      const cardId = (await ctx.runMutation(api.ingest.writeFixCard, {
        signatureId: spec.signatureId as Id<"faultSignatures">,
        title: spec.title,
        steps: spec.steps,
        caveats: spec.caveats ?? undefined,
        heldCount: spec.heldCount,
        recurredCount: spec.recurredCount,
        pendingCount: spec.pendingCount,
        distinctUnits: spec.distinctUnits,
        distinctSites: spec.distinctSites,
        lastUsedAt: spec.lastUsedAt ?? undefined,
        status: spec.status,
        evidence: spec.evidence as Id<"episodes">[],
      })) as Id<"fixCards">;
      void cardId;
    }

    // raise the planted cluster immediately so the engineer inbox is warm
    await ctx.runMutation(api.ingest.runPatternScan, {});

    return { seeded: true, episodes: epSeq, cards: specs.length };
  },
});
