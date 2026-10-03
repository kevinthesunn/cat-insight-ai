import { v } from "convex/values";
import { api } from "./_generated/api";
import { mutation } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { embedParts, embedText } from "./memory/core";
import { buildFixCardSpecs } from "./memory/domain";

// ============================================================================
// Deterministic simulator seeded with REAL Caterpillar product data (§14.1).
//
// Researched and verified against public CAT sources (see DECISIONS.md D12):
//  - Serial prefixes: 336 → TTY · 320 GC → LKS (2022 320GC dealer listing) ·
//    D8T → FMC (US-built) · D6 XE → KEG
//  - Fault codes (CAT CDL CID-FMI + J1939 SPN-FMI + event codes):
//    94-11 CID 0094 fuel delivery pressure · 94-18/E198 low fuel pressure ·
//    110-0/E360 coolant temperature high · 41-3/41-4 8V DC supply (the fault
//    that piles six sensor codes onto the dash at once) · 2458-2 DPF
//    differential pressure erratic · 190-8 engine speed abnormal frequency
//  - Part numbers verified on parts.cat.com / dealer listings: 1R-0749
//    (secondary fuel filter), 326-4700 (C6.4 fuel injector, 320D), 239-4418
//    (320 track tension cylinder), 216-0024 (pump group), 9T-6857 (piston
//    pump), 344-1722 (belt tensioner, C7.1/C6.6)
//
// Behavioral invariants (pattern engine, baselines, §17 swap story, fix-card
// rebuild) are unchanged from the original simulator — only the dressing is
// real: model/serial data, spoken codes, part numbers, and operator phrasing.
// ============================================================================

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

    // ---- sites (aliased Site A/B/C by creation order, §13) ----
    const siteDefs = [
      { name: "Calico Basin Aggregates", region: "Southwest" },
      { name: "Keystone Mine Services", region: "Intermountain" },
      { name: "Tidewater Terminal Contracting", region: "Gulf" },
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

    // ---- fleet: 40 machines, real Cat models + production serial prefixes ----
    const machineModels = [
      { model: "336", cls: "excavator", prefix: "TTY", base: 151, count: 12 }, // Next Gen 336, Cat C9.3
      { model: "320", cls: "excavator", prefix: "LKS", base: 208, count: 8 }, // 320 GC, Cat C4.4
      { model: "D8T", cls: "dozer", prefix: "FMC", base: 411, count: 10 }, // D8T, Cat C15 ACERT
      { model: "D6 XE", cls: "dozer", prefix: "KEG", base: 221, count: 10 }, // D6 XE, Cat C9.3B
    ];
    const systems = ["Hydraulics", "Engine", "Powertrain", "Undercarriage", "Electrical", "Cab"];
    const machineIds: Id<"machines">[] = [];
    const machineInfo: Array<{ id: Id<"machines">; assetId: Id<"assets">; siteId: Id<"sites">; model: string; cls: string; serial: string; unit: string }> = [];
    for (const m of machineModels) {
      for (let i = 0; i < m.count; i++) {
        const serial = `${m.prefix}${String(m.base + i).padStart(5, "0")}`;
        const unit = `${m.model}-${String(i + 1).padStart(2, "0")}`;
        const siteId = siteIds[i % 3];
        const machineId = (await ctx.db.insert("machines", {
          serialNumber: serial,
          unitNumber: unit,
          model: m.model,
          machineClass: m.cls,
          siteId,
          qrTag: `QR-${serial}`,
          createdAt: NOW - 380 * DAY,
        })) as Id<"machines">;
        const mAsset = (await ctx.db.insert("assets", {
          parentId: (await ctx.db.query("assets").withIndex("by_path", (q) => q.eq("path", `s${i % 3}`)).first())!._id,
          kind: "machine",
          name: `Cat ${unit}`,
          serialNumber: serial,
          model: m.model,
          path: `s${i % 3}/m${machineIds.length + 1}`,
          createdAt: NOW - 380 * DAY,
        })) as Id<"assets">;
        await ctx.db.patch(machineId, { assetId: mAsset });
        for (let si = 0; si < systems.length; si++) {
          await ctx.db.insert("assets", {
            parentId: mAsset,
            kind: "system",
            name: systems[si],
            path: `s${i % 3}/m${machineIds.length + 1}/sys${si}`,
            createdAt: NOW - 380 * DAY,
          });
        }
        machineIds.push(machineId);
        machineInfo.push({ id: machineId, assetId: mAsset, siteId, model: m.model, cls: m.cls, serial, unit });
      }
    }

    // component instances on the fault-relevant machines (+ 2 pump swaps for §17.1).
    // Components live under their real system: Hydraulics(0), Engine(1), Undercarriage(3).
    const componentPlans: Array<{
      mi: number; comp: string; label: string; pn?: string; sys: number;
      swap?: { oldPn: string; removedDays: number };
    }> = [
      { mi: 0, comp: "hydraulic_pump", label: "Main hydraulic pump", pn: "216-0024", sys: 0, swap: { oldPn: "9T-6857", removedDays: 200 } },
      { mi: 2, comp: "hydraulic_pump", label: "Main hydraulic pump", pn: "216-0024", sys: 0, swap: { oldPn: "9T-6857", removedDays: 200 } },
      { mi: 1, comp: "hydraulic_pump", label: "Main hydraulic pump", pn: "216-0024", sys: 0 },
      { mi: 3, comp: "hydraulic_pump", label: "Main hydraulic pump", pn: "216-0024", sys: 0 },
      { mi: 4, comp: "track_tensioner", label: "Track adjuster assembly", pn: "239-4418", sys: 3 },
      { mi: 5, comp: "engine_turbo", label: "Turbocharger group", sys: 1 },
      { mi: 8, comp: "final_drive", label: "Final drive group", sys: 3 },
      { mi: 9, comp: "fuel_injector", label: "Fuel injector", pn: "326-4700", sys: 1 },
      { mi: 14, comp: "hydraulic_pump", label: "Main hydraulic pump", pn: "216-0024", sys: 0 },
      { mi: 22, comp: "hydraulic_pump", label: "Main hydraulic pump", pn: "216-0024", sys: 0 },
      { mi: 23, comp: "track_tensioner", label: "Track adjuster assembly", pn: "239-4418", sys: 3 },
      { mi: 26, comp: "final_drive", label: "Final drive group", sys: 3 },
    ];
    for (const p of componentPlans) {
      const info = machineInfo[p.mi];
      const siteIdx = siteIds.indexOf(info.siteId);
      const parentSystem = (
        await ctx.db
          .query("assets")
          .withIndex("by_path", (q) => q.eq("path", `s${siteIdx}/m${p.mi + 1}/sys${p.sys}`))
          .first()
      )!;
      if (p.swap) {
        await ctx.db.insert("assets", {
          parentId: parentSystem._id,
          kind: "component",
          name: `${p.label} (old)`,
          partNumber: p.swap.oldPn,
          path: `s${siteIdx}/m${p.mi + 1}/sys${p.sys}/${p.comp}-old`,
          installedAt: NOW - 370 * DAY,
          removedAt: NOW - p.swap.removedDays * DAY,
          createdAt: NOW - 370 * DAY,
        });
        await ctx.db.insert("assets", {
          parentId: parentSystem._id,
          kind: "component",
          name: p.label,
          partNumber: p.pn,
          path: `s${siteIdx}/m${p.mi + 1}/sys${p.sys}/${p.comp}`,
          installedAt: NOW - p.swap.removedDays * DAY,
          createdAt: NOW - p.swap.removedDays * DAY,
        });
      } else {
        await ctx.db.insert("assets", {
          parentId: parentSystem._id,
          kind: "component",
          name: p.label,
          partNumber: p.pn,
          path: `s${siteIdx}/m${p.mi + 1}/sys${p.sys}/${p.comp}`,
          installedAt: NOW - 370 * DAY,
          createdAt: NOW - 370 * DAY,
        });
      }
    }

    // ---- monthly machine state snapshots (6 months) ----
    // Machine software in Cat format (release-build), e.g. 4N2-1042.
    // Planted pattern units share software 4N2-1198 — the emergent-pattern hint.
    const plantedUnits = [1, 4, 13, 14]; // 336s at site B + 320s at site C — 4 units / 2 sites
    for (let i = 0; i < machineInfo.length; i++) {
      const info = machineInfo[i];
      const firmware = plantedUnits.includes(i) ? "4N2-1198" : "4N2-1042";
      const attachment =
        info.cls === "excavator"
          ? ["GP bucket", "Hydraulic hammer", "Compaction wheel"][i % 3]
          : ["6-way blade", "Semi-U blade", "Ripper"][i % 3];
      for (let m = 6; m >= 1; m--) {
        await ctx.db.insert("machineStateSnapshots", {
          machineId: info.id,
          capturedAt: NOW - m * 30 * DAY,
          engineHours: 7100 + (6 - m) * 180 + Math.floor(rng() * 40),
          firmware,
          attachment,
        });
      }
    }

    // ---- fault signatures (semantic identities; codes only where crews say them) ----
    type SigDef = { cls: string; component: string; code: string | null; summary: string };
    const sigDefs: SigDef[] = [
      { cls: "excavator", component: "hydraulic_pump", code: null, summary: "main pump whining, loses power under load" },
      { cls: "excavator", component: "track_tensioner", code: null, summary: "track loose, tensioner going soft" },
      { cls: "excavator", component: "engine_turbo", code: null, summary: "turbo whistle, no boost on hills" },
      { cls: "excavator", component: "fuel_injector", code: "94-11", summary: "rough running, white smoke — fuel delivery pressure" },
      { cls: "excavator", component: "final_drive", code: null, summary: "clunking from final drive when slewing" },
      { cls: "excavator", component: "hydraulic_hose", code: null, summary: "hose weeping at the boom fitting" },
      { cls: "excavator", component: "engine_water_pump", code: "110-0", summary: "coolant temperature climbing, overheating events" },
      { cls: "excavator", component: "sensor", code: "2458-2", summary: "DPF differential pressure reading erratic" },
      { cls: "dozer", component: "hydraulic_pump", code: null, summary: "pump noisy cold, fades when warm" },
      { cls: "dozer", component: "track_tensioner", code: null, summary: "left track slack, squeals on grading" },
      { cls: "dozer", component: "final_drive", code: null, summary: "final drive leaking, oil on the tracks" },
      { cls: "dozer", component: "electrical_harness", code: "41-4", summary: "8-volt reference fault, sensor codes pile up" },
    ];
    const sigIds: Id<"faultSignatures">[] = [];
    for (const s of sigDefs) {
      sigIds.push(
        (await ctx.db.insert("faultSignatures", {
          machineClass: s.cls,
          component: s.component,
          faultCode: s.code ?? undefined,
          symptomSummary: s.summary,
          embedding: embedParts([s.component.replace(/_/g, " "), s.code, s.summary]),
          firstSeen: NOW - 170 * DAY,
          lastSeen: NOW - 1 * DAY,
        })) as Id<"faultSignatures">,
      );
    }

    const PUMP = 0, TRACKX = 1, TURBO = 2, INJ = 3, FD = 4, HOSE = 5, WATER = 6, SENS = 7,
      PUMPD = 8, TRACKD = 9, FDD = 10, ELEC = 11;

    // episode factory
    const users = await ctx.db.query("users").collect();
    const userNames = users.map((u: any) => u.name).filter(Boolean) as string[];
    const actor = () => (userNames.length ? pick(userNames) : "Crew");
    void actor;
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
        severity: kind === "repair" ? "stopped" : /derate|dead|shutdown|overheat/.test(raw) ? "stopped" : "degraded",
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
        engineHours: 7200 + (180 - daysAgo),
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
    ) => {
      const epId = (await addEpisode(mi, "repair", daysAgo, action, sigIdx)) as Id<"episodes">;
      await ctx.db.insert("repairs", {
        episodeId: epId,
        signatureId: sigIds[sigIdx],
        actionTaken: action,
        parts,
        outcomeStatus: outcome,
        outcomeResolvedAt: outcome === "held" ? NOW - (daysAgo - 20) * DAY : undefined,
      });
      return epId;
    };

    // ---- planted pattern: main hydraulic pump, 4 units / 2 sites, last 21 days ----
    // The signature across sites: pump inlet restriction on Next Gen excavators —
    // history shows the hose-and-coupling repair holds, clamp-only does not.
    const plantedRepairs: Array<{ mi: number; days: number; action: string; outcome: "held" | "recurred"; parts: Array<{ name: string; partNumber?: string }> }> = [
      { mi: 0, days: 38, action: "Replaced main pump inlet hose and coupling group, refilled with Cat HYDO Advanced and bled the system", outcome: "held", parts: [{ name: "Inlet hose" }, { name: "Pump coupling group" }] },
      { mi: 2, days: 33, action: "Swapped pump inlet hose and coupling, refilled and bled the hydraulics", outcome: "held", parts: [{ name: "Inlet hose" }] },
      { mi: 5, days: 30, action: "Tightened the inlet clamp only, didn't pull the hose", outcome: "recurred", parts: [] },
    ];
    for (const r of plantedRepairs) await addRepair(r.mi, r.days, r.action, PUMP, r.outcome, r.parts);
    const plantedFresh: Array<[number, number, string, "voice_note" | "sensor_alarm"]> = [
      [1, 18, "main pump is whining like crazy and she loses power when I load the bucket", "voice_note"],
      [4, 14, "hydro pump screaming, machine feels weak digging, almost derates", "voice_note"],
      [14, 10, "ALARM — pump pressure low on the monitor, machine derated, whine at high load", "sensor_alarm"],
      [13, 6, "pump noise and barely digs, feels like the hydraulics gave up", "voice_note"],
      [1, 4, "same pump whine again after warmup, worse than yesterday", "voice_note"],
    ];
    for (const [mi, days, raw, kind] of plantedFresh) {
      await addEpisode(mi, kind, days, raw, PUMP);
    }
    await addRepair(1, 8, "Fitted new inlet hose and coupling, refilled with Cat HYDO Advanced and bled", PUMP, "pending", [{ name: "Inlet hose" }]);

    // ---- baseline noise over 6 months + a high-volume but baseline-normal
    // track-tensioner signature that must NOT be surfaced (§14.6) ----
    const phrases: Record<number, string[]> = {
      [TRACKX]: ["track feels loose on tight turns", "left track climbing off in soft ground, tension low", "grease cylinder on the adjuster weeping, track went soft", "track squeals when I swing uphill", "adjuster grease fitting keeps losing pressure"],
      [TURBO]: ["whistling from the turbo, no boost on hills", "boost drops off under load, whistle at high RPM", "turbo whine then she falls on her face uphill"],
      [INJ]: ["engine missing and blowing white smoke, threw a 94-11 fuel delivery pressure", "hard start cold, 94-11 back on the screen again", "low fuel pressure warning E198, smells rich at idle", "rough under load, white smoke — 94-11 came back after the storm"],
      [FD]: ["clunk from the final drive when I slew", "final drive grinding on hard swing", "bang out of the swing drive under load"],
      [HOSE]: ["small weep at the boom hose fitting", "boom line damp, wiping hydraulic oil off every shift", "seep at the stick cylinder fitting, watching it"],
      [WATER]: ["temp gauge climbing, 110-0 up and she's near derate", "E360 high coolant temp — shut down and let her cool", "coolant level low again, no visible leak yet", "radiator core plugged with dust, temp events every hour"],
      [SENS]: ["2458-2 keeps coming back, DPF pressure reading jumping around", "cleaned the DPF pressure ports and the 2458-2 cleared for a day", "2458-2 erratic again, soot readout all over the place"],
      [PUMPD]: ["dozer pump noisy cold then fades warm", "hydraulics loud first hour on the D6", "pump whines at cold start, fine after warmup"],
      [TRACKD]: ["left track slack on the dozer, squeals grading", "D8 track keeps going loose every few shifts", "track tension low, blade chatter on hard pan"],
      [FDD]: ["final drive oil all over the tracks, no code just the leak", "gear oil weeping at the drive hub", "final drive seep, keeping an eye on the level"],
      [ELEC]: ["dash throwing 41-4 plus six sensor codes at once — classic 8-volt reference", "41-4 again, screen resets itself at startup", "intermittent 41-4, found chafe behind the dash last time"],
    };
    // track_tensioner: HIGH volume in-window but matching a high baseline → not surfaced
    for (let k = 0; k < 40; k++) {
      const mi = Math.floor(rng() * machineInfo.length);
      if (machineInfo[mi].cls !== "excavator") continue;
      await addEpisode(mi, "voice_note", 20 + Math.floor(rng() * 150), pick(phrases[TRACKX]), TRACKX);
    }
    for (const mi of [3, 7, 11, 16, 25, 31]) {
      await addEpisode(mi, "voice_note", Math.floor(rng() * 28), pick(phrases[TRACKX]), TRACKX);
    }
    for (const [sigIdx, count] of [[TURBO, 9], [INJ, 8], [FD, 7], [HOSE, 6], [WATER, 6], [SENS, 5], [PUMPD, 8], [TRACKD, 7], [FDD, 6], [ELEC, 5]] as const) {
      for (let k = 0; k < count; k++) {
        const cls = sigDefs[sigIdx].cls;
        const candidates = machineInfo.map((info, idx) => ({ info, idx })).filter((x) => x.info.cls === cls);
        const chosen = pick(candidates);
        await addEpisode(chosen.idx, rng() < 0.6 ? "voice_note" : "sensor_alarm", Math.floor(rng() * 170), pick(phrases[sigIdx]), sigIdx);
      }
    }

    // ---- repairs across the other signatures so several fix cards exist ----
    await addRepair(9, 60, "Re-tensioned the track and re-greased the adjuster cylinder, checked the fitting", TRACKX, "held", []);
    await addRepair(16, 52, "Replaced track adjuster tension cylinder 239-4418, re-tensioned to spec", TRACKX, "held", [{ name: "Track tension cylinder", partNumber: "239-4418" }]);
    await addRepair(23, 95, "Pulled the final drive hub seal, fitted a new seal and refilled with gear oil", FDD, "held", [{ name: "Final drive seal" }]);
    await addRepair(26, 88, "Replaced final drive seal, flushed and refilled the hub", FDD, "recurred", [{ name: "Final drive seal" }]);
    await addRepair(23, 60, "Found harness chafe behind the dash, re-pinned the connector and cleared the 41-4", ELEC, "held", []);
    await addRepair(9, 45, "Replaced the No.3 injector 326-4700 and both secondary fuel filters 1R-0749, bled the fuel system", INJ, "held", [
      { name: "Fuel injector", partNumber: "326-4700" },
      { name: "Secondary fuel filter", partNumber: "1R-0749" },
    ]);
    await addRepair(3, 70, "Replaced the thermostat and radiator cap, pressure-tested the system, backfilled with Cat ELC", WATER, "held", []);

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
        id: sigIds[i], machineClass: s.cls, modelFamily: null,
        component: s.component, faultCode: s.code ?? undefined, symptomSummary: s.summary,
        embedding: embedParts([s.component.replace(/_/g, " "), s.code, s.summary]),
        firstSeen: NOW - 170 * DAY, lastSeen: NOW,
      })),
      episodes: allEpisodes,
      repairs: allRepairs,
      machines: machineInfo.map((m) => ({ id: m.id, model: m.model, machineClass: m.cls, siteId: m.siteId, unitNumber: m.unit, serialNumber: m.serial })),
    });
    for (const spec of specs) {
      await ctx.runMutation(api.ingest.writeFixCard, {
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
      });
    }

    // raise the planted cluster immediately so the engineer inbox is warm
    await ctx.runMutation(api.ingest.runPatternScan, {});

    return { seeded: true, episodes: epSeq, cards: specs.length };
  },
});

/** Demo reset: clears all app tables (users/auth untouched) so seedSiteMemory
 *  can run again. Dev/demo helper — replaces the previous mock dataset. */
export const clearSiteMemory = mutation({
  args: {},
  handler: async (ctx) => {
    // children first: evidence → repairs/feedback → episodes → members →
    // clusters/cards → snapshots/signatures → assets → machines/sites → logs
    const order = [
      "fixCardEvidence", "repairs", "feedback", "episodes",
      "patternClusterMembers", "patternClusters", "fixCards",
      "machineStateSnapshots", "faultSignatures", "assets", "machines",
      "sites", "manifests", "auditLog",
    ] as const;
    const counts: Record<string, number> = {};
    for (const table of order) {
      const rows = await ctx.db.query(table).collect();
      for (const row of rows) await ctx.db.delete(row._id);
      counts[table] = rows.length;
    }
    return { cleared: true, counts };
  },
});
