// Pure (runtime-free) memory primitives: embeddings, redaction, extraction
// validation with the anti-fabrication guard, and a mock provider for tests.
import { componentsFor } from "./vocab";

// ---- Embedder (DECISIONS.md D3): deterministic hashed bag-of-words ----
export const EMBED_DIM = 256;

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1);
}

function fnv1a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export function embedText(text: string): number[] {
  const vec = new Array<number>(EMBED_DIM).fill(0);
  const tokens = tokenize(text);
  for (const tok of tokens) {
    const h = fnv1a(tok);
    const idx = h % EMBED_DIM;
    const sign = (h >>> 31) & 1 ? -1 : 1;
    vec[idx] += sign;
    // bigram-ish smoothing: also add token-pair anchor for two-word phrases
    if (tokens.length > 1) vec[(h >>> 8) % EMBED_DIM] += sign * 0.25;
  }
  const norm = Math.sqrt(vec.reduce((s, x) => s + x * x, 0)) || 1;
  return vec.map((x) => x / norm);
}

export function embedParts(parts: Array<string | null | undefined>): number[] {
  return embedText(parts.filter(Boolean).join(" "));
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) dot += a[i] * b[i];
  return dot; // both L2-normalized
}

// ---- §13 redaction (crew-facing) ----
export type RedactCtx = {
  operatorNames: string[];
  serials: string[];
  unitNumbers: string[];
  locationNames: string[];
};

export function redactText(text: string, ctx: RedactCtx): string {
  let out = text;
  for (const list of [ctx.operatorNames, ctx.serials, ctx.unitNumbers, ctx.locationNames]) {
    for (const needle of list) {
      if (needle && needle.length > 2) {
        out = out.split(needle).join("[redacted]");
      }
    }
  }
  return out;
}

// ---- §8 extraction schema + validation ----
export type ExtractionResult = {
  kind_confirmed: "voice_note" | "repair" | "inspection";
  component: string; // vocab key or "other"
  component_label: string | null;
  fault_code: string | null;
  symptoms: string[];
  severity: "stopped" | "degraded" | "monitor";
  action_taken: string | null;
  parts: Array<{ name: string; part_number: string | null }>;
  resolved_by_crew: boolean;
  confidence: number;
};

const KINDS = ["voice_note", "repair", "inspection"] as const;
const SEVERITIES = ["stopped", "degraded", "monitor"] as const;

/** Normalized code shapes: CID-FMI (e.g. "117-9") and SPN-FMI (e.g. "SPN 94 FMI 2"). */
export function findFaultCodes(text: string): string[] {
  const codes: string[] = [];
  const cid = text.matchAll(/\b(\d{1,4}\s?-\s?\d{1,2})\b/g);
  for (const m of cid) codes.push(m[1].replace(/\s/g, ""));
  const spn = text.matchAll(/\bspn\s*:?\s*(\d{1,4}).{0,12}?fmi\s*:?\s*(\d{1,2})/gi);
  for (const m of spn) codes.push(`SPN${m[1]}FMI${m[2]}`);
  return codes;
}

export function findPartNumbers(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/\b([0-9][A-Z0-9]{1,3}-[0-9]{3,4})\b/g)) out.push(m[1]);
  for (const m of text.matchAll(/\b([A-Z]{1,3}\d{3,6})\b/g)) out.push(m[1]);
  return out;
}

function containsCode(rawText: string, code: string): boolean {
  const norm = rawText.toLowerCase().replace(/\s/g, "");
  return norm.includes(code.toLowerCase().replace(/\s/g, ""));
}

/**
 * §8 + §14.10: coerce LLM output to the schema; NEVER keep a fault code or
 * part number that the worker did not actually say (anti-fabrication guard).
 */
export function validateExtraction(
  parsed: unknown,
  rawText: string,
  machineClass: string,
): ExtractionResult | null {
  if (!parsed || typeof parsed !== "object") return null;
  const p = parsed as Record<string, unknown>;

  const kindRaw = String(p.kind_confirmed ?? "voice_note");
  const kind = (KINDS as readonly string[]).includes(kindRaw)
    ? (kindRaw as ExtractionResult["kind_confirmed"])
    : "voice_note";

  const vocabKeys = componentsFor(machineClass).map((c) => c.key);
  let component = String(p.component ?? "other");
  if (component !== "other" && !vocabKeys.includes(component)) component = "other";
  const componentLabel = p.component_label ? String(p.component_label).slice(0, 80) : null;

  // Anti-fabrication guards.
  let faultCode: string | null = null;
  if (typeof p.fault_code === "string" && p.fault_code.trim()) {
    const spoken = findFaultCodes(rawText);
    const claimed = p.fault_code.trim().replace(/\s/g, "");
    if (spoken.some((c) => c === claimed) || containsCode(rawText, claimed)) {
      faultCode = claimed;
    }
  }

  const symptoms = Array.isArray(p.symptoms)
    ? p.symptoms.slice(0, 6).map((s) => String(s).slice(0, 120)).filter(Boolean)
    : [];

  const sevRaw = String(p.severity ?? "monitor");
  const severity = (SEVERITIES as readonly string[]).includes(sevRaw)
    ? (sevRaw as ExtractionResult["severity"])
    : "monitor";

  const actionTaken = p.action_taken ? String(p.action_taken).slice(0, 500) : null;

  const spokenParts = findPartNumbers(rawText);
  const parts = Array.isArray(p.parts)
    ? (p.parts as Array<Record<string, unknown>>)
        .slice(0, 8)
        .map((part) => {
          const pn =
            typeof part.part_number === "string" && part.part_number.trim()
              ? spokenParts.find(
                  (c) =>
                    c.toLowerCase() === part.part_number!.trim().toLowerCase(),
                ) ?? null
              : null;
          return { name: String(part.name ?? "part").slice(0, 80), part_number: pn };
        })
        .filter((part) => part.name)
    : [];

  const confidence = Math.max(0, Math.min(1, Number(p.confidence ?? 0.5)));

  return {
    kind_confirmed: kind,
    component,
    component_label: component === "other" ? componentLabel : null,
    fault_code: faultCode,
    symptoms,
    severity,
    action_taken: actionTaken,
    parts,
    resolved_by_crew: Boolean(p.resolved_by_crew),
    confidence,
  };
}

/** Text fed to the embedder for an episode (§8 step 4). */
export function extractionEmbedText(ex: ExtractionResult): string {
  return [ex.component_label ?? ex.component, ex.fault_code, ...ex.symptoms, ex.action_taken]
    .filter(Boolean)
    .join(" ");
}

// ---- Mock provider (offline tests; §5 "mock providers so tests run offline") ----
export function mockExtract(rawText: string, kind: string, machineClass: string): ExtractionResult {
  const lower = rawText.toLowerCase();
  const comps = componentsFor(machineClass);
  let component = "other";
  let label: string | null = null;
  for (const c of comps) {
    if (c.synonyms.some((s) => lower.includes(s)) || lower.includes(c.key.replace(/_/g, " "))) {
      component = c.key;
      label = null;
      break;
    }
  }
  if (component === "other") {
    for (const c of comps) {
      const hit = c.synonyms.find((s) => lower.includes(s.split(" ")[0]));
      if (hit) {
        component = c.key;
        break;
      }
    }
  }
  const codes = findFaultCodes(rawText);
  const severity: ExtractionResult["severity"] = /stopped|dead|wont move|won't move|down/.test(lower)
    ? "stopped"
    : /noisy|whin|leak|slow|derate|hot|smoke|missing|loose/.test(lower)
      ? "degraded"
      : "monitor";
  return validateExtraction(
    {
      kind_confirmed: kind,
      component,
      component_label: label,
      fault_code: codes[0] ?? null,
      symptoms: [rawText.slice(0, 100)],
      severity,
      action_taken: kind === "repair" ? rawText.slice(0, 200) : null,
      parts: [],
      resolved_by_crew: kind === "repair",
      confidence: component !== "other" ? 0.9 : 0.4,
    },
    rawText,
    machineClass,
  )!;
}
