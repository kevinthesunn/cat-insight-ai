import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { useAction, useMutation, useQuery } from "convex/react";
import {
  ChevronRight, GitBranch, Loader2, MessageCircleQuestion, Wrench,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { timeAgo } from "@/components/shared";

type Role = "manager" | "engineer" | "admin";

const STATUS_FLOW = ["new", "investigating", "known_issue", "fixed_in_product", "dismissed"] as const;

export default function EngineerDashboard({ role }: { role: Role }) {
  const isEngineer = role === "engineer" || role === "admin";
  const patterns = useQuery(api.ops.emergingPatterns, {});
  const machines = useQuery(api.ops.allMachines, {});
  const setClusterStatus = useMutation(api.ops.updateClusterStatus);
  const pushGuidance = useMutation(api.ops.pushGuidance);
  const reveal = useMutation(api.store.revealRawEpisode);
  const ask = useAction(api.context.queryContext);

  const [tab, setTab] = useState<"patterns" | "ask">("patterns");
  const [openNotes, setOpenNotes] = useState<string | null>(null);
  const [noteDraft, setNoteDraft] = useState("");
  const [guidanceFor, setGuidanceFor] = useState<string | null>(null);
  const [guidanceDraft, setGuidanceDraft] = useState("");
  const [rawFor, setRawFor] = useState<string | null>(null);
  const [rawText, setRawText] = useState("");
  const [question, setQuestion] = useState("");
  const [askMachine, setAskMachine] = useState<string>("");
  const [answer, setAnswer] = useState<any>(null);
  const [asking, setAsking] = useState(false);

  const doAsk = async () => {
    if (!question.trim()) return;
    setAsking(true);
    setAnswer(null);
    try {
      const res = await ask({
        question,
        ui_context: askMachine ? { machineId: askMachine as never } : undefined,
      });
      if (res.clarification) {
        setAnswer({
          answer: res.clarification.reason,
          steps: res.clarification.options.map((o: any) => o.label),
          manifest_summary: { intent: "clarification" },
          clarificationOptions: res.clarification.options,
        });
      } else {
        setAnswer(res);
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Query failed");
    } finally {
      setAsking(false);
    }
  };

  return (
    <main className="mx-auto w-full max-w-6xl px-4 pb-16 pt-8 sm:px-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-sm text-muted-foreground">
            {isEngineer ? "Caterpillar Engineering · all sites" : "Your site"}
          </p>
          <h1 className="mt-1 font-display text-2xl font-bold tracking-tight">
            {isEngineer ? "Pattern inbox" : "Site issues"}
          </h1>
        </div>
        <div className="flex rounded-lg border border-border bg-card p-1">
          <button
            onClick={() => setTab("patterns")}
            className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium ${tab === "patterns" ? "bg-secondary shadow-soft" : "text-muted-foreground"}`}
          >
            <GitBranch className="size-4" /> Patterns
          </button>
          <button
            onClick={() => setTab("ask")}
            className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium ${tab === "ask" ? "bg-secondary shadow-soft" : "text-muted-foreground"}`}
          >
            <MessageCircleQuestion className="size-4" /> Ask memory
          </button>
        </div>
      </div>

      {tab === "patterns" && (
        <div className="mt-6 space-y-4">
          {patterns === undefined && <p className="text-sm text-muted-foreground">Loading…</p>}
          {patterns && patterns.patterns.length === 0 && (
            <p className="rounded-xl border border-border bg-card p-5 text-sm text-muted-foreground shadow-soft">
              No emerging patterns. The scan runs every 15 minutes over a rolling 30-day window.
            </p>
          )}
          {patterns?.patterns.map((c: any) => (
            <div key={c.id} className="rounded-2xl border border-border bg-card p-5 shadow-soft">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="font-display text-lg font-bold leading-snug">
                    {c.signature ? c.signature.component.replace(/_/g, " ") : "Unknown fault"}
                    {c.signature?.faultCode ? ` · ${c.signature.faultCode}` : ""}
                  </p>
                  <p className="mt-0.5 text-sm text-muted-foreground">
                    {c.unitCount} units · {c.siteCount} sites · {c.episodeCount} episodes · score {Number(c.score ?? 0).toFixed(1)}
                  </p>
                </div>
                <span className="rounded-full border border-sky-200 bg-sky-50 px-2.5 py-1 text-xs font-semibold text-sky-800">
                  {c.status.replace(/_/g, " ")}
                </span>
              </div>

              <div className="mt-3 flex flex-wrap gap-1.5">
                {c.hints.map((h: string) => (
                  <span key={h} className="rounded-full bg-violet-100 px-2.5 py-1 text-xs font-semibold text-violet-900">
                    {h}
                  </span>
                ))}
                {c.baselineRate != null && c.observedRate != null && (
                  <span className="rounded-full bg-secondary px-2.5 py-1 text-xs text-muted-foreground">
                    {c.observedRate.toFixed(2)} /1000 machine-days vs baseline {c.baselineRate.toFixed(2)}
                  </span>
                )}
              </div>

              {c.engineerNotes && <p className="mt-3 rounded-lg bg-secondary/70 p-3 text-sm">Notes: {c.engineerNotes}</p>}

              <div className="mt-3 max-h-44 space-y-1.5 overflow-y-auto pr-1">
                {c.members.map((m: any) => (
                  <div key={m.episodeId} className="flex items-start gap-2 rounded-lg border border-border/70 px-3 py-2 text-sm">
                    <span className="mt-0.5 shrink-0 text-xs font-semibold text-muted-foreground">{m.machineLabel}</span>
                    <span className="min-w-0 flex-1 truncate text-muted-foreground">{m.text}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">{timeAgo(m.at)}</span>
                    {isEngineer && (
                      <button
                        className="shrink-0 text-xs font-semibold text-amber-700 underline"
                        onClick={() =>
                          void reveal({ episodeId: m.episodeId }).then((r: any) => {
                            setRawFor(m.episodeId);
                            setRawText(r.rawText || "(no transcript stored)");
                          })
                        }
                      >
                        raw
                      </button>
                    )}
                  </div>
                ))}
              </div>
              {rawFor && (
                <p className="mt-2 rounded-lg bg-stone-900 p-3 text-xs text-stone-200">RAW · {rawText}</p>
              )}

              {isEngineer && (
                <div className="mt-4 flex flex-wrap items-center gap-2">
                  {STATUS_FLOW.filter((s) => s !== c.status).map((s) => (
                    <Button
                      key={s}
                      size="sm"
                      variant={s === "dismissed" ? "ghost" : "outline"}
                      className="h-8 text-xs"
                      onClick={() => {
                        void setClusterStatus({ clusterId: c.id, status: s });
                        toast.success(`Marked ${s.replace(/_/g, " ")}`);
                      }}
                    >
                      → {s.replace(/_/g, " ")}
                    </Button>
                  ))}
                  <Button size="sm" variant="outline" className="h-8 text-xs" onClick={() => { setOpenNotes(c.id); setNoteDraft(c.engineerNotes ?? ""); }}>
                    Notes
                  </Button>
                  <Button size="sm" className="h-8 gap-1.5 text-xs" onClick={() => { setGuidanceFor(c.id); setGuidanceDraft(""); }}>
                    <Wrench className="size-3.5" /> Push guidance to affected sites
                  </Button>
                </div>
              )}

              {openNotes === c.id && (
                <div className="mt-3 space-y-2">
                  <Textarea value={noteDraft} onChange={(e) => setNoteDraft(e.target.value)} className="min-h-20" placeholder="Investigation notes…" />
                  <Button size="sm" onClick={() => { void setClusterStatus({ clusterId: c.id, status: c.status, notes: noteDraft }); setOpenNotes(null); toast.success("Notes saved"); }}>
                    Save notes
                  </Button>
                </div>
              )}
              {guidanceFor === c.id && (
                <div className="mt-3 space-y-2">
                  <Textarea value={guidanceDraft} onChange={(e) => setGuidanceDraft(e.target.value)} className="min-h-20" placeholder="One-line guidance for crews at the affected sites…" />
                  <Button size="sm" onClick={() => { void pushGuidance({ clusterId: c.id, note: guidanceDraft }); setGuidanceFor(null); toast.success("Guidance pushed to the fix card"); }}>
                    Send to crews
                  </Button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {tab === "ask" && (
        <div className="mt-6 grid gap-4 lg:grid-cols-2">
          <div className="rounded-2xl border border-border bg-card p-5 shadow-soft">
            <p className="font-display font-bold">Ask the memory layer</p>
            <p className="mt-1 text-sm text-muted-foreground">
              Answers are built only from the branch of the knowledge graph your role allows — every claim cites its node.
            </p>
            {isEngineer && machines && (
              <select
                value={askMachine}
                onChange={(e) => setAskMachine(e.target.value)}
                className="mt-3 h-10 w-full rounded-lg border border-input bg-background px-3 text-sm"
              >
                <option value="">No machine selected (deterministic lookup from the question)</option>
                {machines.map((m: any) => (
                  <option key={m.id} value={m.id}>{m.siteLabel} · {m.unitNumber ?? m.serialNumber} · {m.model}</option>
                ))}
              </select>
            )}
            <Textarea
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              className="mt-3 min-h-24"
              placeholder="e.g. The main pump on Unit 14 is whining — what's the fix? Is this spreading to other 336s?"
            />
            <Button className="mt-3 gap-2" disabled={asking || !question.trim()} onClick={() => void doAsk()}>
              {asking ? <Loader2 className="size-4 animate-spin" /> : <MessageCircleQuestion className="size-4" />}
              Ask
            </Button>
          </div>
          <div className="rounded-2xl border border-border bg-card p-5 shadow-soft">
            {answer ? (
              <>
                <p className="whitespace-pre-line text-[15px] leading-relaxed">{answer.answer}</p>
                {answer.steps?.length > 0 && (
                  <ol className="mt-3 list-decimal space-y-1 pl-5 text-sm">
                    {answer.steps.map((s: string, i: number) => <li key={i}>{s}</li>)}
                  </ol>
                )}
                {answer.clarificationOptions && (
                  <div className="mt-3 flex flex-wrap gap-2">
                    {answer.clarificationOptions.map((o: any) => (
                      <Button key={o.id} size="sm" variant="outline" onClick={() => { setAskMachine(o.id); setQuestion("What's wrong with this machine?"); }}>
                        {o.label} <ChevronRight className="size-3.5" />
                      </Button>
                    ))}
                  </div>
                )}
                {answer.widened && (
                  <p className="mt-3 rounded-lg bg-violet-50 p-3 text-xs text-violet-900">
                    Widened once ({answer.manifest_summary?.widenReason}): the answer uses context beyond this machine's branch.
                  </p>
                )}
                <div className="mt-3 flex flex-wrap gap-1.5">
                  <span className="rounded-full bg-secondary px-2.5 py-1 text-xs text-muted-foreground">
                    intent: {answer.manifest_summary?.intent}
                  </span>
                  <span className="rounded-full bg-secondary px-2.5 py-1 text-xs text-muted-foreground">
                    nodes: {answer.manifest_summary?.nodeCount} · ~{answer.manifest_summary?.tokenEstimate} tokens
                  </span>
                  {(answer.citations ?? []).map((c: string) => (
                    <span key={c} className="rounded-full bg-amber-100 px-2.5 py-1 text-[11px] font-mono text-amber-900">{c.slice(0, 12)}</span>
                  ))}
                  {answer.flaggedCitations?.length > 0 && (
                    <span className="rounded-full bg-red-100 px-2.5 py-1 text-xs font-semibold text-red-800">
                      {answer.flaggedCitations.length} unverified claim(s) flagged
                    </span>
                  )}
                </div>
              </>
            ) : (
              <p className="text-sm text-muted-foreground">Answers appear here with citations, the manifest size, and any widening — or a clarification, never a guess.</p>
            )}
          </div>
        </div>
      )}
    </main>
  );
}
