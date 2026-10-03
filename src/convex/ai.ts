"use node";

import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { action } from "./_generated/server";

// Prefer the project's Keys tab (GROQ_API_KEY env var); the literal below is the
// key provided for this deployment.
const GROQ_API_KEY =
  process.env.GROQ_API_KEY ??
  "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";

const TRANSCRIBE_URL = "https://api.groq.com/openai/v1/audio/transcriptions";
const CHAT_URL = "https://api.groq.com/openai/v1/chat/completions";

const CATEGORIES = ["mechanical", "safety", "environmental", "operational"] as const;
const SEVERITIES = ["critical", "warning", "info"] as const;

export const processVoiceReport = action({
  args: {
    siteId: v.id("sites"),
    audioBase64: v.string(),
    mimeType: v.string(),
  },
  handler: async (ctx, { siteId, audioBase64, mimeType }) => {
    const userId = await getAuthUserId(ctx);
    const user = userId ? await ctx.runQuery(api.users.currentUser) : null;
    const { siteName, machines } = await ctx.runQuery(api.app.siteContext, { siteId });

    if (audioBase64.length > 25_000_000) {
      throw new Error("That recording is too long — keep it under a couple of minutes.");
    }

    // 1) Speech-to-text with Groq Whisper
    const bytes = Uint8Array.from(Buffer.from(audioBase64, "base64"));
    const form = new FormData();
    form.append("file", new Blob([bytes], { type: mimeType || "audio/webm" }), "report.webm");
    form.append("model", "whisper-large-v3-turbo");
    form.append("response_format", "json");

    const tRes = await fetch(TRANSCRIBE_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${GROQ_API_KEY}` },
      body: form,
    });
    if (!tRes.ok) {
      throw new Error(`Transcription failed (${tRes.status}). Try again.`);
    }
    const tJson: { text?: string } = await tRes.json();
    const transcript = (tJson.text ?? "").trim();
    if (!transcript) {
      throw new Error("We couldn't hear anything. Try speaking a little louder.");
    }

    // 2) Structure the transcript into knowledge-graph-ready data
    let parsed: Record<string, unknown> | null = null;
    try {
      const cRes = await fetch(CHAT_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${GROQ_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "openai/gpt-oss-120b",
          temperature: 0.2,
          response_format: { type: "json_object" },
          messages: [
            {
              role: "system",
              content:
                "You process spoken reports from construction workers on a CAT (Caterpillar) job site and convert them into strict JSON. " +
                'Return exactly: {"category": "mechanical"|"safety"|"environmental"|"operational", "severity": "critical"|"warning"|"info", "machineName": string|null, "title": string, "crewMessage": string, "actionItems": string[]}. ' +
                "Rules: category mechanical means a machine/equipment problem (gets routed to CAT engineers); safety means people could get hurt; environmental means weather or ground conditions; anything else is operational. " +
                "machineName must be copied EXACTLY from the provided machine list or be null. " +
                "title is at most 8 words, no punctuation at the end. crewMessage is 1-2 plain, short sentences written for the crew. " +
                "actionItems is 0-2 very short imperative tasks for the crew. Keep all language simple — workers are not engineers.",
            },
            {
              role: "user",
              content: `Job site: ${siteName}\nMachines on site: ${machines.join(", ") || "none"}\n\nSpoken report:\n${transcript}`,
            },
          ],
        }),
      });
      if (cRes.ok) {
        const cJson: { choices?: Array<{ message?: { content?: string } }> } = await cRes.json();
        const content = cJson.choices?.[0]?.message?.content;
        if (content) parsed = JSON.parse(content) as Record<string, unknown>;
      }
    } catch {
      parsed = null; // fall back to heuristic structuring below
    }

    const category = CATEGORIES.includes(parsed?.category as never)
      ? (parsed!.category as string)
      : "operational";
    const severity = SEVERITIES.includes(parsed?.severity as never)
      ? (parsed!.severity as string)
      : "warning";

    // machine match: exact name first, then fuzzy contains
    let machineId: Id<"machines"> | undefined;
    const wanted = typeof parsed?.machineName === "string" ? parsed.machineName.toLowerCase() : "";
    if (wanted) {
      const match =
        machines.find((m: string) => m.toLowerCase() === wanted) ??
        machines.find((m: string) => m.toLowerCase().includes(wanted) || wanted.includes(m.toLowerCase()));
      if (match) {
        const doc = await ctx.runQuery(api.app.machineIdByName, {
          siteId,
          name: match,
        });
        machineId = doc ?? undefined;
      }
    }

    const title =
      typeof parsed?.title === "string" && parsed.title.trim()
        ? parsed.title.trim().slice(0, 80)
        : transcript.split(/\s+/).slice(0, 7).join(" ");
    const crewMessage =
      typeof parsed?.crewMessage === "string" && parsed.crewMessage.trim()
        ? parsed.crewMessage.trim().slice(0, 400)
        : transcript.slice(0, 400);
    const actions = Array.isArray(parsed?.actionItems)
      ? (parsed!.actionItems as unknown[]).slice(0, 2).map((a) => String(a).slice(0, 120))
      : [];

    await ctx.runMutation(api.app.commitVoiceReport, {
      siteId,
      machineId,
      category,
      severity,
      title,
      crewMessage,
      transcript,
      actor: user?.name ?? "Crew member",
      actions,
    });

    return {
      transcript,
      title,
      category,
      severity,
      notified: category === "mechanical",
    };
  },
});
