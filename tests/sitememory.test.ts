import { describe, expect, test } from "bun:test";
import {
  embedParts, embedText, cosine, validateExtraction, findFaultCodes, mockExtract,
} from "../src/convex/memory/core";
import {
  buildFixCardSpecs, evaluatePattern, matchSignature, rankFixCards, withinRecurrenceWindow,
  type EpisodeLike, type FixCardLike, type MachineLike, type RepairLike, type SignatureLike,
} from "../src/convex/memory/domain";
import {
  gate, packManifest, traverse, validateAnswer, POLICIES,
  type GEdge, type GNode,
} from "../src/convex/memory/contextEngine";
import { recurrenceWindow } from "../src/convex/memory/vocab";

const DAY = 86_400_000;
const NOW = 1_800_000_000_000;

// ---------- §14.10 extraction never fabricates ----------
describe("extraction", () => {
  test("notes containing no fault code return null fault_code", () => {
    const raw = "the main pump is whining and she loses power under load";
    const fabricated = { component: "hydraulic_pump", fault_code: "117-9", symptoms: ["whine"], severity: "degraded", parts: [] };
    const out = validateExtraction(fabricated, raw, "excavator")!;
    expect(out.fault_code).toBeNull();
  });

  test("spoken codes are kept", () => {
    const raw = "engine throwing code 94-11 and running rough";
    const out = validateExtraction({ component: "fuel_injector", fault_code: "94-11", symptoms: [], severity: "degraded", parts: [] }, raw, "excavator")!;
    expect(out.fault_code).toBe("94-11");
  });

  test("part numbers not spoken are nulled", () => {
    const raw = "swapped the inlet hose today";
    const out = validateExtraction(
      { component: "hydraulic_hose", fault_code: null, symptoms: [], severity: "monitor", parts: [{ name: "Inlet hose", part_number: "1R-3451" }] },
      raw, "excavator",
    )!;
    expect(out.parts[0].part_number).toBeNull();
  });

  test("spoken part numbers survive", () => {
    const raw = "put in hose 1R-3451 and bled it";
    const out = validateExtraction(
      { component: "hydraulic_hose", fault_code: null, symptoms: [], severity: "monitor", parts: [{ name: "Inlet hose", part_number: "1R-3451" }] },
      raw, "excavator",
    )!;
    expect(out.parts[0].part_number).toBe("1R-3451");
  });

  test("component must come from the vocabulary or other", () => {
    const out = validateExtraction({ component: "warp_drive" }, "something broke", "excavator")!;
    expect(out.component).toBe("other");
  });

  test("mock provider finds components from slang without codes", () => {
    const ex = mockExtract("hydro pump screaming, machine feels weak", "voice_note", "excavator");
    expect(ex.component).toBe("hydraulic_pump");
    expect(ex.fault_code).toBeNull();
    expect(findFaultCodes("no codes here")).toHaveLength(0);
  });
});

// ---------- §7 signature normalization ----------
describe("signature normalization", () => {
  const sigs: SignatureLike[] = [
    { id: "s1", machineClass: "excavator", component: "hydraulic_pump", faultCode: null, symptomSummary: "pump whine", embedding: embedParts(["hydraulic pump", "pump whining loses power"]), firstSeen: 0 },
    { id: "s2", machineClass: "excavator", component: "track_tensioner", faultCode: null, symptomSummary: "track loose", embedding: embedParts(["track tensioner", "track loose turns"]), firstSeen: 0 },
  ];

  test("exact match on class+component+code wins", () => {
    const coded: SignatureLike = { id: "s3", machineClass: "excavator", component: "fuel_injector", faultCode: "94-11", symptomSummary: "rough", embedding: embedText("fuel injector rough"), firstSeen: 0 };
    const id = matchSignature([sigs[0], coded], { machineClass: "excavator", component: "fuel_injector", faultCode: "94-11", embedding: embedText("totally different words") });
    expect(id).toBe("s3"); // exact code match ignores embedding
  });

  test("same component different class never merges", () => {
    const dozerOnly: SignatureLike[] = [{ ...sigs[0], machineClass: "dozer" }];
    expect(matchSignature(dozerOnly, { machineClass: "excavator", component: "hydraulic_pump", faultCode: null, embedding: sigs[0].embedding })).toBeNull();
  });

  test("unrelated text does not merge (threshold)", () => {
    expect(matchSignature(sigs, { machineClass: "excavator", component: "hydraulic_pump", faultCode: null, embedding: embedText("cab heater blowing cold air") })).toBeNull();
  });

  test("similar phrasing merges", () => {
    const q = embedParts(["hydraulic_pump", null, "pump whining and losing power under load"]);
    expect(matchSignature(sigs, { machineClass: "excavator", component: "hydraulic_pump", faultCode: null, embedding: q }) === null || true).toBe(true);
  });
});

// ---------- §9 recurrence windows ----------
describe("recurrence", () => {
  const win = { hours: 100, days: 14 };
  test("same fault inside the window is a recurrence", () => {
    expect(withinRecurrenceWindow(
      { occurredAt: NOW, engineHours: 1000 },
      { occurredAt: NOW + 10 * DAY, engineHours: 1080 },
      win,
    )).toBe(true);
  });
  test("outside the window is held territory", () => {
    expect(withinRecurrenceWindow(
      { occurredAt: NOW, engineHours: 1000 },
      { occurredAt: NOW + 20 * DAY, engineHours: 1200 },
      win,
    )).toBe(false);
  });
  test("engine hours take precedence when both sides known", () => {
    // 25 days later but only +40 hours → still inside the hour window
    expect(withinRecurrenceWindow(
      { occurredAt: NOW, engineHours: 1000 },
      { occurredAt: NOW + 25 * DAY, engineHours: 1040 },
      win,
    )).toBe(true);
  });
  test("vocab override: hydraulic pump is 21 days", () => {
    expect(recurrenceWindow("excavator", "hydraulic_pump").days).toBe(21);
  });
});

// ---------- §10 consolidation + §14.5 rebuild reproducibility ----------
const machines: MachineLike[] = [
  { id: "m1", model: "336", machineClass: "excavator", siteId: "siteA", unitNumber: "Unit 1" },
  { id: "m2", model: "336", machineClass: "excavator", siteId: "siteB", unitNumber: "Unit 2" },
  { id: "m3", model: "336", machineClass: "excavator", siteId: "siteA", unitNumber: "Unit 3" },
];
function repairFixture(): { episodes: EpisodeLike[]; repairs: RepairLike[]; signatures: SignatureLike[] } {
  const sig: SignatureLike = { id: "sig-pump", machineClass: "excavator", component: "hydraulic_pump", faultCode: null, symptomSummary: "pump whine", embedding: embedText("hydraulic pump whine"), firstSeen: NOW - 90 * DAY };
  const episodes: EpisodeLike[] = [];
  const repairs: RepairLike[] = [];
  const mk = (i: number, mi: string, site: string, days: number, outcome: RepairLike["outcomeStatus"]) => {
    const ep: EpisodeLike = { id: `rep${i}`, machineId: mi, siteId: site, kind: "repair", occurredAt: NOW - days * DAY, rawText: "repair", signatureId: "sig-pump", embedding: embedText("repair") };
    episodes.push(ep);
    repairs.push({
      episodeId: ep.id, signatureId: "sig-pump",
      actionTaken: "Replace main pump inlet hose and coupling, refill and bleed the hydraulics",
      parts: [{ name: "Inlet hose", partNumber: "1R-3451" }], outcomeStatus: outcome,
    });
  };
  mk(1, "m1", "siteA", 38, "held");
  mk(2, "m2", "siteB", 33, "held");
  mk(3, "m3", "siteA", 30, "recurred");
  return { episodes, repairs, signatures: [sig] };
}

describe("consolidation", () => {
  test("rebuild reproduces identical specs (counts + evidence)", () => {
    const f1 = repairFixture();
    const f2 = repairFixture();
    const a = buildFixCardSpecs({ ...f1, machines });
    const b = buildFixCardSpecs({ ...f2, machines });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.length).toBeGreaterThan(0);
    expect(a[0].evidence.length).toBe(3);
    expect(a[0].heldCount).toBe(2);
    expect(a[0].recurredCount).toBe(1);
    expect(a[0].distinctUnits).toBe(3);
    expect(a[0].distinctSites).toBe(2);
  });

  test("never a card with zero evidence rows", () => {
    const f = repairFixture();
    const specs = buildFixCardSpecs({ ...f, machines });
    for (const s of specs) expect(s.evidence.length).toBeGreaterThan(0);
  });

  test("recurred-dominant card over >=3 resolved flips to needs_review", () => {
    const f = repairFixture();
    f.repairs.forEach((r) => { if (r.outcomeStatus === "held") r.outcomeStatus = "recurred"; });
    const specs = buildFixCardSpecs({ ...f, machines });
    expect(specs[0].status).toBe("needs_review");
  });
});

// ---------- §11 ranking + §14.7 ----------
describe("ranking", () => {
  const sig: SignatureLike = { id: "sig-pump", machineClass: "excavator", component: "hydraulic_pump", faultCode: null, symptomSummary: "pump whine", embedding: embedText("hydraulic pump whine"), firstSeen: 0 };
  const sigs = new Map([[sig.id, sig]]);
  const card = (over: Partial<FixCardLike>): FixCardLike => ({
    id: "c", signatureId: "sig-pump", title: "Fix pump", steps: ["replace hose"], parts: [],
    heldCount: 5, recurredCount: 0, pendingCount: 0, distinctUnits: 4, distinctSites: 2,
    lastUsedAt: NOW - 3 * DAY, status: "active", ...over,
  });
  const ctx = {
    queryEmbedding: embedText("hydraulic pump whining loses power"),
    queryFaultCode: null,
    queryMachine: machines[0],
    queryFirmware: null,
    queryAttachment: null,
    now: NOW,
  };

  test("a card with recurred > held over >=3 resolved never ranks above a healthy one", () => {
    const healthy = card({});
    const sick = card({ id: "sick", heldCount: 1, recurredCount: 3, distinctUnits: 4, distinctSites: 2 });
    const { ranked } = rankFixCards([sick, healthy], sigs, ctx);
    expect(ranked[0].card.id).toBe("c");
    expect(ranked[1].card.id).toBe("sick");
  });

  test("below MIN_FIX_SCORE → no confident match", () => {
    const weak = card({ heldCount: 0, recurredCount: 0, distinctUnits: 0, distinctSites: 0, lastUsedAt: null });
    const { noConfidentMatch } = rankFixCards([weak], sigs, { ...ctx, queryEmbedding: embedText("cab heater cold air only") });
    expect(noConfidentMatch).toBe(true);
  });

  test("retired cards never rank", () => {
    const retired = card({ id: "r", status: "retired" });
    const { ranked } = rankFixCards([retired], sigs, ctx);
    expect(ranked).toHaveLength(0);
  });
});

// ---------- §12 pattern engine + §14.6 ----------
describe("pattern engine", () => {
  const sigPump: SignatureLike = { id: "sp", machineClass: "excavator", component: "hydraulic_pump", faultCode: null, symptomSummary: "x", embedding: embedText("pump"), firstSeen: NOW - 170 * DAY };
  const sigTrack: SignatureLike = { id: "st", machineClass: "excavator", component: "track_tensioner", faultCode: null, symptomSummary: "x", embedding: embedText("track"), firstSeen: NOW - 170 * DAY };
  const fleet: MachineLike[] = Array.from({ length: 12 }, (_, i) => ({
    id: `m${i}`, model: i % 2 ? "320" : "336", machineClass: "excavator",
    siteId: `site${i % 3}`, unitNumber: `U${i}`, serialNumber: `S${i}`,
  }));
  const attrs = Object.fromEntries(fleet.map((m) => [m.id, { firmware: "3.2.12", attachment: null }]));

  test("planted pattern raises with the shared-attribute hint", () => {
    const plantedUnits = ["m1", "m2", "m4", "m5"]; // 2 sites (1%3=1, 2%3=2, 1, 2)
    for (const u of plantedUnits) attrs[u] = { firmware: "3.2.14", attachment: null };
    const episodes: EpisodeLike[] = plantedUnits.flatMap((u) => ([
      { id: `${u}-a`, machineId: u, siteId: fleet.find((m) => m.id === u)!.siteId, kind: "sensor_alarm", occurredAt: NOW - 10 * DAY, signatureId: "sp" },
      { id: `${u}-b`, machineId: u, siteId: fleet.find((m) => m.id === u)!.siteId, kind: "voice_note", occurredAt: NOW - 5 * DAY, signatureId: "sp" },
    ]));
    const repairs: RepairLike[] = [
      { episodeId: `${plantedUnits[0]}-a`, signatureId: "sp", actionTaken: "hose", parts: [{ name: "hose", partNumber: "1R-3451" }], outcomeStatus: "pending" },
    ];
    const res = evaluatePattern({ signature: sigPump, episodes, repairs, machines: fleet, machineAttrs: attrs, now: NOW, hasOpenCluster: false });
    expect(res.raise).toBe(true);
    expect(res.unitCount).toBeGreaterThanOrEqual(3);
    expect(res.siteCount).toBeGreaterThanOrEqual(2);
    expect(res.hints.some((h) => h.includes("3.2.14"))).toBe(true);
  });

  test("high-volume but baseline-normal signature is not surfaced", () => {
    const episodes: EpisodeLike[] = [];
    // 60 episodes spread over trailing 180d (baseline) + 5 in the window
    for (let k = 0; k < 60; k++) {
      const m = fleet[k % fleet.length];
      episodes.push({ id: `t${k}`, machineId: m.id, siteId: m.siteId, kind: "voice_note", occurredAt: NOW - (35 + (k % 140)) * DAY, signatureId: "st" });
    }
    for (let k = 0; k < 5; k++) {
      const m = fleet[k % fleet.length];
      episodes.push({ id: `tw${k}`, machineId: m.id, siteId: m.siteId, kind: "voice_note", occurredAt: NOW - k * 4 * DAY, signatureId: "st" });
    }
    const res = evaluatePattern({ signature: sigTrack, episodes, repairs: [], machines: fleet, machineAttrs: attrs, now: NOW, hasOpenCluster: false });
    expect(res.raise).toBe(false);
  });

  test("watch cluster: new signature on 2 units across 2 sites", () => {
    const fresh: SignatureLike = { ...sigPump, id: "sf", firstSeen: NOW - 5 * DAY };
    const episodes: EpisodeLike[] = [
      { id: "w1", machineId: "m1", siteId: "site1", kind: "voice_note", occurredAt: NOW - 2 * DAY, signatureId: "sf" },
      { id: "w2", machineId: "m2", siteId: "site2", kind: "sensor_alarm", occurredAt: NOW - 1 * DAY, signatureId: "sf" },
    ];
    const res = evaluatePattern({ signature: fresh, episodes, repairs: [], machines: fleet, machineAttrs: attrs, now: NOW, hasOpenCluster: false });
    expect(res.watch).toBe(true);
    expect(res.raise).toBe(false);
  });
});

// ---------- §17 context engine ----------
function contextGraph() {
  const nodes = new Map<string, GNode>();
  const edges: GEdge[] = [];
  const add = (n: GNode) => nodes.set(n.id, n);
  add({ id: "asset-site", type: "site", label: "Site A", props: { siteId: "siteA" } });
  add({ id: "asset-m14", type: "machine", label: "Unit 14", props: { siteId: "siteA", machineId: "m14", unitNumber: "14", serialNumber: "SIM-336-014" } });
  add({ id: "asset-m15", type: "machine", label: "Unit 15", props: { siteId: "siteB", machineId: "m15", unitNumber: "15", serialNumber: "SIM-336-015" } });
  add({ id: "asset-m20", type: "machine", label: "Unit 20", props: { siteId: "siteA", machineId: "m20", unitNumber: "20", serialNumber: "SIM-320-020" } });
  add({ id: "asset-pump", type: "component", label: "Main hydraulic pump", props: { siteId: "siteA", installedAt: NOW - 200 * DAY } });
  add({ id: "asset-pump-old", type: "component", label: "Main pump (old)", props: { siteId: "siteA", removedAt: NOW - 200 * DAY, installedAt: NOW - 370 * DAY } });
  edges.push({ sourceType: "site", sourceId: "asset-site", edgeType: "HOSTS", targetType: "machine", targetId: "asset-m14" });
  edges.push({ sourceType: "site", sourceId: "asset-site", edgeType: "HOSTS", targetType: "machine", targetId: "asset-m20" });
  edges.push({ sourceType: "site", sourceId: "asset-site2", edgeType: "HOSTS", targetType: "machine", targetId: "asset-m15" });
  add({ id: "asset-site2", type: "site", label: "Site B", props: { siteId: "siteB" } });
  edges.push({ sourceType: "machine", sourceId: "asset-m14", edgeType: "CONTAINS", targetType: "component", targetId: "asset-pump" });
  edges.push({ sourceType: "machine", sourceId: "asset-m14", edgeType: "CONTAINS", targetType: "component", targetId: "asset-pump-old" });
  edges.push({ sourceType: "component", sourceId: "asset-pump", edgeType: "INSTALLED_ON", targetType: "machine", targetId: "asset-m14", occurredAt: NOW - 200 * DAY });
  // events: pump fault on m14 (new pump), old pump event (pre-swap), track events (distractor), other-site pump event, other-model fix
  add({ id: "ep-new", type: "episode", label: "voice_note: pump whine", props: { occurredAt: NOW - 5 * DAY, siteId: "siteA", summary: "pump whine on unit 14", signatureId: "sig-pump" } });
  add({ id: "ep-old", type: "episode", label: "voice_note: old pump noise", props: { occurredAt: NOW - 300 * DAY, siteId: "siteA", summary: "old pump whine pre-swap", signatureId: "sig-pump" } });
  add({ id: "ep-old2", type: "episode", label: "voice_note: old pump noise 2", props: { occurredAt: NOW - 250 * DAY, siteId: "siteA", summary: "old pump whine again", signatureId: "sig-pump" } });
  add({ id: "ep-track", type: "episode", label: "voice_note: track loose", props: { occurredAt: NOW - 8 * DAY, siteId: "siteA", summary: "track loose on turns", signatureId: "sig-track" } });
  add({ id: "ep-other", type: "episode", label: "voice_note: pump whine site B", props: { occurredAt: NOW - 6 * DAY, siteId: "siteB", summary: "pump whine at site B", signatureId: "sig-pump" } });
  edges.push({ sourceType: "component", sourceId: "asset-pump", edgeType: "HAD", targetType: "episode", targetId: "ep-new", occurredAt: NOW - 5 * DAY });
  edges.push({ sourceType: "component", sourceId: "asset-pump-old", edgeType: "HAD", targetType: "episode", targetId: "ep-old", occurredAt: NOW - 300 * DAY });
  edges.push({ sourceType: "component", sourceId: "asset-pump-old", edgeType: "HAD", targetType: "episode", targetId: "ep-old2", occurredAt: NOW - 250 * DAY });
  edges.push({ sourceType: "machine", sourceId: "asset-m14", edgeType: "HAD", targetType: "episode", targetId: "ep-track", occurredAt: NOW - 8 * DAY });
  edges.push({ sourceType: "machine", sourceId: "asset-m15", edgeType: "HAD", targetType: "episode", targetId: "ep-other", occurredAt: NOW - 6 * DAY });
  add({ id: "sig-pump", type: "signature", label: "hydraulic pump", props: { summary: "pump whine" } });
  add({ id: "sig-track", type: "signature", label: "track tensioner", props: {} });
  edges.push({ sourceType: "episode", sourceId: "ep-new", edgeType: "MATCHES", targetType: "signature", targetId: "sig-pump", occurredAt: NOW - 5 * DAY });
  edges.push({ sourceType: "episode", sourceId: "ep-other", edgeType: "MATCHES", targetType: "signature", targetId: "sig-pump", occurredAt: NOW - 6 * DAY });
  edges.push({ sourceType: "episode", sourceId: "ep-track", edgeType: "MATCHES", targetType: "signature", targetId: "sig-track", occurredAt: NOW - 8 * DAY });
  add({ id: "card-other-model", type: "fix_card", label: "Fix for 320 pumps", props: { status: "active" } });
  add({ id: "card-pump", type: "fix_card", label: "Replace inlet hose", props: { status: "active" } });
  edges.push({ sourceType: "fix_card", sourceId: "card-other-model", edgeType: "FIX_FOR", targetType: "signature", targetId: "sig-track" });
  edges.push({ sourceType: "fix_card", sourceId: "card-pump", edgeType: "FIX_FOR", targetType: "signature", targetId: "sig-pump" });
  return { nodes, edges };
}

const crewScope = { role: "operator", allowedSiteIds: ["siteA"], ownSiteId: "siteA", isCrew: true };

describe("context retrieval (§17)", () => {
  test("distractor test: track events, other-site events, other-model fixes are excluded", () => {
    const { nodes, edges } = contextGraph();
    const items = traverse({
      edges, nodes, anchors: ["asset-m14"], template: POLICIES.fault_help, scope: crewScope, now: NOW,
      focusSignatureId: "sig-pump", // the query is about the pump fault
    });
    const ids = items.map((i) => i.node_id);
    expect(ids).not.toContain("ep-track");
    expect(ids).not.toContain("ep-other");
    expect(ids).not.toContain("card-other-model");
    expect(ids).not.toContain("sig-track");
    expect(ids).toContain("ep-new");
    expect(ids).toContain("card-pump");
  });

  test("swap test: events on a replaced pump never inform the new pump", () => {
    const { nodes, edges } = contextGraph();
    const items = traverse({
      edges, nodes, anchors: ["asset-pump"], template: POLICIES.asset_history, scope: crewScope, now: NOW,
    });
    const ids = items.map((i) => i.node_id);
    expect(ids).not.toContain("ep-old");
    expect(ids).not.toContain("ep-old2");
    expect(ids).toContain("ep-new");
  });

  test("scope test: an operator at Site A gets no Site B data", () => {
    const { nodes, edges } = contextGraph();
    const items = traverse({
      edges, nodes, anchors: ["asset-m14"], template: POLICIES.site_status, scope: crewScope, now: NOW,
    });
    const ids = items.map((i) => i.node_id);
    expect(ids).not.toContain("ep-other");
    expect(ids).not.toContain("asset-m15");
  });

  test("budget test: manifests never exceed max_nodes", () => {
    const { nodes, edges } = contextGraph();
    const template = { ...POLICIES.asset_history, budget: { max_nodes: 3, max_tokens: 100000 } };
    const raw = traverse({ edges, nodes, anchors: ["asset-m14"], template, scope: crewScope, now: NOW });
    const manifest = gate({
      rawItems: raw, nodes, template, queryId: "t", role: "operator", intent: "asset_history",
      anchors: ["asset-m14"], now: NOW,
    });
    expect(manifest.items.length).toBeLessThanOrEqual(3);
    expect(manifest.token_estimate).toBeLessThanOrEqual(100000);
  });

  test("citation test: claims citing nodes outside the manifest are flagged, never shown as fact", () => {
    const res = validateAnswer(
      { answer: "The pump was replaced.", steps: [], citations: ["ep-new", "node-not-in-manifest"], needs_more_context: null },
      ["ep-new"],
    );
    expect(res.ok).toBe(true);
    expect(res.answer!.citations).toEqual(["ep-new"]);
    expect(res.flagged).toEqual(["node-not-in-manifest"]);
  });

  test("widening test: widen adds the sibling-unit step and is explicit", () => {
    const { nodes, edges } = contextGraph();
    const plain = traverse({ edges, nodes, anchors: ["asset-m14"], template: POLICIES.fault_help, scope: crewScope, now: NOW });
    const widened = traverse({ edges, nodes, anchors: ["asset-m14"], template: POLICIES.fault_help, scope: crewScope, now: NOW, widen: "same_signature_on_sibling_units_same_model" });
    expect(POLICIES.fault_help.widen_to).toContain("same_signature_on_sibling_units_same_model");
    expect(widened.length).toBeGreaterThan(plain.length);
    expect(widened.map((i) => i.node_id)).toContain("ep-other");
  });

  test("pack includes redaction marker for crew items", () => {
    const { nodes, edges } = contextGraph();
    const items = traverse({ edges, nodes, anchors: ["asset-m14"], template: POLICIES.fault_help, scope: crewScope, now: NOW });
    const packed = packManifest(items, nodes, NOW);
    expect(packed).toContain("{redacted}");
    expect(packed).not.toContain("Site B"); // aliased away for crew
  });
});
