// Provider implementations behind the §5 interfaces (LLMClient, Embedder,
// Transcriber). Embedder default is local (memory/core.ts); LLM/STT default is
// Groq. Swap here to change providers (DECISIONS.md D2).

import { componentsFor } from "./vocab";

const GROQ_API_KEY =
  process.env.GROQ_API_KEY ??
  "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";
const STT_MODEL = "whisper-large-v3-turbo";
const LLM_MODEL = "openai/gpt-oss-120b";

/** §2 allowed model customization: custom vocabulary hint for STT. */
export function sttVocabHint(machineClass: string): string {
  const terms = componentsFor(machineClass).flatMap((c) => [c.label, ...c.synonyms]);
  return [...new Set(terms)].slice(0, 60).join(", ");
}

export async function groqTranscribe(
  audioBase64: string,
  mimeType: string,
): Promise<string> {
  const bytes = Uint8Array.from(Buffer.from(audioBase64, "base64"));
  const form = new FormData();
  form.append("file", new Blob([bytes], { type: mimeType || "audio/webm" }), "note.webm");
  form.append("model", STT_MODEL);
  form.append("response_format", "json");
  const res = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${GROQ_API_KEY}` },
    body: form,
  });
  if (!res.ok) throw new Error(`Transcription failed (${res.status})`);
  const json: { text?: string } = await res.json();
  return (json.text ?? "").trim();
}

async function groqChat(system: string, user: string, maxTokens = 700): Promise<string> {
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${GROQ_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: LLM_MODEL,
      temperature: 0.2,
      max_tokens: maxTokens,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  });
  if (!res.ok) throw new Error(`LLM failed (${res.status})`);
  const json: { choices?: Array<{ message?: { content?: string } }> } = await res.json();
  return json.choices?.[0]?.message?.content ?? "";
}

/** §8 step 3 — extraction prompt with the exact fabrication rules. */
export const EXTRACTION_SYSTEM = `You process field reports from heavy-equipment crews and convert them to strict JSON. Output JSON only, matching:
{"kind_confirmed":"voice_note|repair|inspection","component":"<key from the allowed list or 'other'>","component_label":"free text if other else null","fault_code":"string|null","symptoms":["short phrases, keep the crew's wording"],"severity":"stopped|degraded|monitor","action_taken":"string|null","parts":[{"name":"","part_number":"string|null"}],"resolved_by_crew":true|false,"confidence":0.0}
Rules: NEVER invent a fault code or a part number — use null when the worker did not say one. Choose component ONLY from the allowed list, else "other" plus component_label. Keep language simple.`;

export async function groqExtract(
  rawText: string,
  machineClass: string,
  allowedComponents: string[],
  hint?: string,
): Promise<unknown> {
  const user = [
    `Machine class: ${machineClass}`,
    `Allowed component keys: ${allowedComponents.join(", ")}`,
    hint ? `Clarification hint from the crew: ${hint}` : "",
    `Spoken report:\n${rawText}`,
  ]
    .filter(Boolean)
    .join("\n\n");
  const out = await groqChat(EXTRACTION_SYSTEM, user);
  return JSON.parse(out);
}

/** §10.3 — card text from member repairs ONLY, with the required instruction. */
export async function groqCardText(
  memberRepairs: Array<{ action: string; parts: string[]; outcome: string; unit: string; site: string }>,
): Promise<{ title: string; steps: string[]; caveats: string | null } | null> {
  const system =
    "You write a short fix card for heavy-equipment crews. Output JSON only: " +
    '{"title":"<=70 chars","steps":["3-6 short imperative steps"],"caveats":"string|null"}. ' +
    "Use only information present in the supplied repairs. If repairs disagree, say so in caveats. " +
    "Do not invent part numbers or procedures.";
  const user = memberRepairs
    .map(
      (r) =>
        `- unit ${r.unit} at ${r.site} (${r.outcome}): ${r.action}${
          r.parts.length ? ` | parts: ${r.parts.join(", ")}` : ""
        }`,
    )
    .join("\n");
  try {
    const out = await groqChat(system, user, 500);
    const parsed = JSON.parse(out) as Record<string, unknown>;
    if (!parsed.title || !Array.isArray(parsed.steps) || parsed.steps.length === 0) return null;
    return {
      title: String(parsed.title).slice(0, 70),
      steps: (parsed.steps as unknown[]).map(String).slice(0, 6),
      caveats: parsed.caveats ? String(parsed.caveats).slice(0, 300) : null,
    };
  } catch {
    return null;
  }
}

/** §17.4.6 — answering call: instructions + question + pack ONLY, no tools. */
export const ANSWER_SYSTEM = (role: string) =>
  `You are SiteMemory's assistant for a ${role}. Answer ONLY from the supplied context pack. ` +
  "Tone: plain, short sentences, field-safe. Never invent fault codes, part numbers, or history. " +
  `Cite the node ids you used in "citations". If the pack does not contain enough, set needs_more_context {"reason", "suggested_template"} instead of guessing. ` +
  'Output JSON only: {"answer":"...","steps":["..."],"citations":["node_id"],"needs_more_context":null}.';

export async function groqAnswer(
  role: string,
  question: string,
  contextPack: string,
): Promise<unknown> {
  const out = await groqChat(ANSWER_SYSTEM(role), `Question: ${question}\n\nContext pack:\n${contextPack}`, 600);
  return JSON.parse(out);
}
