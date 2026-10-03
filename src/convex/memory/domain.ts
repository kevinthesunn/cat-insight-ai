// Pure domain logic for SiteMemory (no Convex runtime imports → unit-testable).
import { cosine, embedText } from "./core";

// ---- config (§7/§11/§12/§17 defaults, env-overridable) ----
const num = (v: string | undefined, d: number) => (v ? Number(v) : d);
export function getConfig() {
  return {
    SIG_MERGE_THRESHOLD: num(process.env.SIG_MERGE_THRESHOLD, 0.86),
    ACTION_MERGE_THRESHOLD: 0.85,
    MIN_FIX_SCORE: num(process.env.MIN_FIX_SCORE, 0.45),
    PATTERN_MIN_UNITS: num(process.env.PATTERN_MIN_UNITS, 3),
    PATTERN_MIN_SITES: num(process.env.PATTERN_MIN_SITES, 2),
    PATTERN_WATCH_MIN_UNITS: 2,
    PATTERN_WINDOW_DAYS: 30,
    PATTERN_BASELINE_DAYS: 180,
    PATTERN_RATE_FACTOR: 2,
    CONTEXT_MIN_SCORE: num(process.env.CONTEXT_MIN_SCORE, 0.3),
  };
}

const DAY = 86_400_000;

// ---- shared shape types (fixtures in tests use these) ----
export type SignatureLike = {
  id: string;
  machineClass: string;
  modelFamily?: string | null;
  component: string;
  faultCode?: string | null;
  symptomSummary: string;
  embedding: number[];
  firstSeen?: number | null;
  lastSeen?: number | null;
};
export type MachineLike = {
  id: string;
  model: string;
  machineClass: string;
  siteId?: string | null;
  unitNumber?: string | null;
  serialNumber?: string | null;
};
export type EpisodeLike = {
  id: string;
  machineId: string;
  siteId?: string | null;
  assetId?: string | null;
  kind: string;
  occurredAt: number;
  rawText?: string | null;
  signatureId?: string | null;
  embedding?: number[] | null;
  supersedes?: string | null;
  structured?: Record<string, unknown> | null;
};
export type RepairLike = {
  episodeId: string;
  signatureId?: string | null;
  actionTaken: string;
  parts: Array<{ name: string; partNumber?: string | null }>;
  outcomeStatus: "pending" | "held" | "recurred" | "unknown";
  outcomeResolvedAt?: number | null;
  recurrenceEpisodeId?: string | null;
};
export type FixCardLike = {
  id: string;
  signatureId: string;
  title: string;
  steps: string[];
  parts: string[];
  caveats?: string | null;
  heldCount: number;
  recurredCount: number;
  pendingCount: number;
  distinctUnits: number;
  distinctSites: number;
  lastUsedAt?: number | null;
  status: "active" | "retired" | "needs_review";
};

// ---- §7 signature normalization ----
export function matchSignature(
  candidates: SignatureLike[],
  q: { machineClass: string; component: string; faultCode?: string | null; embedding: number[] },
  threshold = getConfig().SIG_MERGE_THRESHOLD,
): string | null {
  // a. Exact: same class + component + fault code (when code present)
  if (q.faultCode) {
    const exact = candidates.find(
      (c) =>
        c.machineClass === q.machineClass &&
        c.component === q.component &&
        c.faultCode === q.faultCode,
    );
    if (exact) return exact.id;
  }
  // b. Semantic: cosine on the same machine class
  let best: { id: string; sim: number } | null = null;
  for (const c of candidates) {
    if (c.machineClass !== q.machineClass) continue;
    const sim = cosine(q.embedding, c.embedding);
    if (sim >= threshold && (!best || sim > best.sim)) best = { id: c.id, sim };
  }
  return best?.id ?? null;
}

// ---- §11 ranking ----
export type RankResult = {
  card: FixCardLike;
  score: number;
  breakdown: {
    signature_match: number;
    outcome_score: number;
    model_similarity: number;
    evidence_strength: number;
    recency: number;
    context_match: number;
  };
  confident: boolean;
};

export function scoreFixCard(
  card: FixCardLike,
  sig: SignatureLike,
  ctx: {
    queryEmbedding: number[];
    queryFaultCode?: string | null;
    queryMachine: MachineLike;
    queryFirmware?: string | null;
    queryAttachment?: string | null;
    now: number;
  },
): RankResult {
  const exact = Boolean(
    ctx.queryFaultCode && sig.faultCode && ctx.queryFaultCode === sig.faultCode,
  );
  const signature_match = exact
    ? 1.0
    : Math.max(0, Math.min(1, cosine(ctx.queryEmbedding, sig.embedding)));
  const outcome_score =
    (card.heldCount + 1) / (card.heldCount + card.recurredCount + 2);
  const m = ctx.queryMachine.model;
  const fam = sig.modelFamily ?? null;
  const model_similarity =
    fam && m === fam
      ? 1.0
      : fam && (m.startsWith(fam) || fam.startsWith(m))
        ? 0.7
        : 0.4;
  const evidence_strength = Math.min(
    1,
    Math.log(1 + card.distinctUnits) / Math.log(1 + 10),
  );
  const recency = card.lastUsedAt
    ? Math.exp(-(ctx.now - card.lastUsedAt) / DAY / 180)
    : 0;
  let context_match = 0;
  let ctxAttrs = 0;
  if (ctx.queryFirmware && ctx.queryFirmware.length > 0) {
    ctxAttrs++;
    if (card.caveats?.includes(ctx.queryFirmware)) context_match += 0.5;
  }
  if (ctx.queryAttachment && ctx.queryAttachment.length > 0) {
    ctxAttrs++;
    if (card.caveats?.includes(ctx.queryAttachment)) context_match += 0.5;
  }
  const context = ctxAttrs > 0 ? Math.min(1, context_match) : 0.5;

  const score =
    0.35 * signature_match +
    0.25 * outcome_score +
    0.15 * model_similarity +
    0.1 * evidence_strength +
    0.1 * recency +
    0.05 * context;

  return {
    card,
    score,
    breakdown: {
      signature_match,
      outcome_score,
      model_similarity,
      evidence_strength,
      recency,
      context_match: context,
    },
    confident: score >= getConfig().MIN_FIX_SCORE,
  };
}

export function rankFixCards(
  cards: FixCardLike[],
  signatures: Map<string, SignatureLike>,
  ctx: Parameters<typeof scoreFixCard>[2],
  limit = 3,
): { ranked: RankResult[]; noConfidentMatch: boolean } {
  const ranked = cards
    .filter((c) => c.status !== "retired")
    .map((c) => {
      const sig = signatures.get(c.signatureId);
      if (!sig) return null;
      return scoreFixCard(c, sig, ctx);
    })
    .filter((r): r is RankResult => r !== null)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
  const noConfidentMatch =
    ranked.length === 0 || !ranked[0].confident;
  return { ranked, noConfidentMatch };
}

// ---- §9 recurrence ----
export function withinRecurrenceWindow(
  repair: { occurredAt: number; engineHours?: number | null },
  candidate: { occurredAt: number; engineHours?: number | null },
  window: { hours: number; days: number },
): boolean {
  if (candidate.occurredAt < repair.occurredAt) return false;
  if (
    repair.engineHours != null &&
    candidate.engineHours != null &&
    candidate.engineHours >= repair.engineHours
  ) {
    return candidate.engineHours - repair.engineHours <= window.hours;
  }
  return candidate.occurredAt - repair.occurredAt <= window.days * DAY;
}

// ---- §12 pattern engine ----
export type PatternEval = {
  raise: boolean;
  watch: boolean;
  unitCount: number;
  siteCount: number;
  episodeCount: number;
  baselineRate: number;
  observedRate: number;
  score: number;
  windowStart: number;
  windowEnd: number;
  memberIds: string[];
  hints: string[];
};

const PATTERN_KINDS = new Set(["voice_note", "sensor_alarm", "repair"]);

export function evaluatePattern(input: {
  signature: SignatureLike;
  episodes: EpisodeLike[];
  repairs: RepairLike[];
  machines: MachineLike[]; // active fleet (same class at minimum; pass all)
  machineAttrs: Record<string, { firmware?: string | null; attachment?: string | null }>;
  now: number;
  hasOpenCluster: boolean;
  retiredSignatureIds?: string[];
}): PatternEval {
  const cfg = getConfig();
  const windowMs = cfg.PATTERN_WINDOW_DAYS * DAY;
  const windowStart = input.now - windowMs;
  const windowEnd = input.now;
  const fleet = input.machines.filter((m) => m.machineClass === input.signature.machineClass);
  const fleetSize = Math.max(1, fleet.length);

  const members = input.episodes.filter(
    (e) =>
      e.signatureId === input.signature.id &&
      !e.supersedes &&
      PATTERN_KINDS.has(e.kind) &&
      e.occurredAt >= windowStart &&
      e.occurredAt <= windowEnd,
  );
  const unitIds = [...new Set(members.map((e) => e.machineId))];
  const siteIds = [...new Set(members.map((e) => e.siteId).filter(Boolean))] as string[];
  const memberMachine = (id: string) => input.machines.find((m) => m.id === id);

  // baseline: trailing baseline window excluding the current window
  const baseStart = windowStart - cfg.PATTERN_BASELINE_DAYS * DAY;
  const baseCount = input.episodes.filter(
    (e) =>
      e.signatureId === input.signature.id &&
      !e.supersedes &&
      PATTERN_KINDS.has(e.kind) &&
      e.occurredAt >= baseStart &&
      e.occurredAt < windowStart,
  ).length;
  const eps = 0.01;
  const baselineRate = Math.max(
    eps,
    (baseCount / Math.max(1, fleetSize * cfg.PATTERN_BASELINE_DAYS)) * 1000,
  );
  const observedRate = Math.max(
    0,
    (members.length / Math.max(1, fleetSize * cfg.PATTERN_WINDOW_DAYS)) * 1000,
  );

  const raise =
    unitIds.length >= cfg.PATTERN_MIN_UNITS &&
    siteIds.length >= cfg.PATTERN_MIN_SITES &&
    observedRate >= cfg.PATTERN_RATE_FACTOR * baselineRate;
  const isNew = (input.signature.firstSeen ?? 0) >= windowStart;
  const watch =
    !input.hasOpenCluster &&
    !raise &&
    isNew &&
    unitIds.length >= cfg.PATTERN_WATCH_MIN_UNITS &&
    siteIds.length >= cfg.PATTERN_MIN_SITES;

  // shared-attribute hints: values over-represented among member machines vs fleet
  const hints: string[] = [];
  const attrShare = (
    pick: (m: MachineLike) => string | null | undefined,
  ): Array<{ value: string; share: number; fleetShare: number }> => {
    const memberVals = unitIds
      .map((id) => pick(memberMachine(id) ?? ({ id } as MachineLike)))
      .filter(Boolean) as string[];
    const fleetVals = fleet.map(pick).filter(Boolean) as string[];
    const out: Array<{ value: string; share: number; fleetShare: number }> = [];
    for (const value of [...new Set(memberVals)]) {
      const share = memberVals.filter((v) => v === value).length / memberVals.length;
      const fleetShare = fleetVals.filter((v) => v === value).length / Math.max(1, fleetVals.length);
      if (share >= 0.5 && fleetShare >= 0 && share >= 2 * fleetShare + 0.01) {
        out.push({ value, share, fleetShare });
      }
    }
    return out.sort((a, b) => b.share - a.share);
  };
  for (const h of attrShare((m) => m.model).slice(0, 1))
    hints.push(`common model: ${h.value}`);
  for (const h of attrShare((m) => input.machineAttrs[m.id]?.firmware ?? null).slice(0, 1))
    hints.push(`common firmware: ${h.value}`);
  for (const h of attrShare((m) => input.machineAttrs[m.id]?.attachment ?? null).slice(0, 1))
    hints.push(`common attachment: ${h.value}`);
  const memberRepairs = input.repairs.filter((r) =>
    members.some((e) => e.id === r.episodeId),
  );
  const partNums = memberRepairs
    .flatMap((r) => r.parts.map((p) => p.partNumber).filter(Boolean))
    .filter((p): p is string => Boolean(p));
  for (const h of attrShare(() => null)) void h; // no-op keeps types tidy
  if (partNums.length >= 2) {
    const top = partNums.sort(
      (a, b) =>
        partNums.filter((x) => x === b).length - partNums.filter((x) => x === a).length,
    )[0];
    const share = partNums.filter((x) => x === top).length / partNums.length;
    if (share >= 0.5) hints.push(`common part: ${top}`);
  }

  const score =
    unitIds.length * 2 + siteIds.length + observedRate / Math.max(0.1, baselineRate);

  return {
    raise,
    watch,
    unitCount: unitIds.length,
    siteCount: siteIds.length,
    episodeCount: members.length,
    baselineRate,
    observedRate,
    score,
    windowStart,
    windowEnd,
    memberIds: members.map((e) => e.id),
    hints,
  };
}

// ---- §10 consolidation ----
export type CardSpec = {
  signatureId: string;
  title: string;
  steps: string[];
  parts: string[];
  caveats: string | null;
  heldCount: number;
  recurredCount: number;
  pendingCount: number;
  distinctUnits: number;
  distinctSites: number;
  lastUsedAt: number | null;
  status: "active" | "retired" | "needs_review";
  evidence: string[]; // repair episode ids
  needsLLMText: boolean;
};

export function buildFixCardSpecs(input: {
  signatures: SignatureLike[];
  episodes: EpisodeLike[]; // kind='repair'
  repairs: RepairLike[];
  machines: MachineLike[];
  retiredSignatureIds?: string[];
  actionThreshold?: number;
}): CardSpec[] {
  const threshold = input.actionThreshold ?? getConfig().ACTION_MERGE_THRESHOLD;
  const retired = new Set(input.retiredSignatureIds ?? []);
  const episodeById = new Map(input.episodes.map((e) => [e.id, e]));
  const machineById = new Map(input.machines.map((m) => [m.id, m]));
  const specs: CardSpec[] = [];

  for (const sig of input.signatures) {
    const members = input.repairs
      .filter((r) => r.signatureId === sig.id)
      .map((r) => ({ r, e: episodeById.get(r.episodeId) }))
      .filter(
        (m): m is { r: RepairLike; e: EpisodeLike } =>
          Boolean(m.e) && !m.e.supersedes && m.e.kind === "repair",
      )
      .sort((a, b) => a.e.occurredAt - b.e.occurredAt);
    if (members.length === 0) continue;

    // §10.1 group repairs by normalized action (embedding cosine ≥ 0.85)
    type Group = Array<{ r: RepairLike; e: EpisodeLike; vec: number[] }>;
    const groups: Group[] = [];
    for (const m of members) {
      const vec = embedText(
        m.r.actionTaken + " " + m.r.parts.map((p) => p.name).join(" "),
      );
      const g = groups.find((grp) => grp.some((x) => cosine(x.vec, vec) >= threshold));
      if (g) g.push({ ...m, vec });
      else groups.push([{ ...m, vec }]);
    }

    for (const g of groups) {
      const held = g.filter((x) => x.r.outcomeStatus === "held").length;
      const recurred = g.filter((x) => x.r.outcomeStatus === "recurred").length;
      const pending = g.filter((x) => x.r.outcomeStatus === "pending").length;
      const units = new Set(g.map((x) => x.e.machineId));
      const sites = new Set(g.map((x) => x.e.siteId).filter(Boolean));
      const lastUsedAt = Math.max(...g.map((x) => x.e.occurredAt));

      // template text (LLM prose is generated live in the action — DECISIONS D6)
      const steps: string[] = [];
      for (const x of g) {
        const step = x.r.actionTaken.trim().replace(/\.$/, "");
        if (step && !steps.some((s) => s.toLowerCase() === step.toLowerCase()))
          steps.push(step.length > 140 ? step.slice(0, 137) + "…" : step);
        if (steps.length >= 6) break;
      }
      const partsSeen = new Map<string, number>();
      const partNumbers = new Set<string>();
      for (const x of g)
        for (const p of x.r.parts) {
          partsSeen.set(p.name, (partsSeen.get(p.name) ?? 0) + 1);
          if (p.partNumber) partNumbers.add(p.partNumber);
        }
      const caveats =
        partNumbers.size > 1
          ? "Part numbers varied between repairs — verify the correct part for your machine before ordering."
          : sig.faultCode
            ? null
            : null;
      const resolved = held + recurred;
      const status: CardSpec["status"] = retired.has(sig.id)
        ? "retired"
        : resolved >= 3 && recurred / resolved > 0.5
          ? "needs_review"
          : "active";
      const compLabel = sig.component.replace(/_/g, " ");
      const topSymptom = (sig.symptomSummary || compLabel).slice(0, 60);

      specs.push({
        signatureId: sig.id,
        title:
          steps[0] && steps[0].length <= 70
            ? `Fix: ${steps[0]}`
            : `${compLabel} — ${topSymptom}`,
        steps,
        parts: [...partsSeen.keys()].slice(0, 8),
        caveats,
        heldCount: held,
        recurredCount: recurred,
        pendingCount: pending,
        distinctUnits: units.size,
        distinctSites: sites.size,
        lastUsedAt,
        status,
        evidence: g.map((x) => x.e.id),
        needsLLMText: g.length >= 2,
      });
    }
  }
  return specs;
}
