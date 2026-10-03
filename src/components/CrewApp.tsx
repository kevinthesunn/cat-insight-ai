import { Button } from "@/components/ui/button";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { useAction, useMutation, useQuery } from "convex/react";
import {
  CheckCircle2, ChevronLeft, CircleStop, History, Loader2, Mic, Radio, TriangleAlert, Wrench,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { enqueue, listQueued, syncQueue, type QueuedSubmission } from "@/lib/offline";

type Role = "operator" | "technician";
type Phase = "idle" | "recording" | "ready" | "sending" | "logged";

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onloadend = () => {
      const s = String(r.result);
      resolve(s.slice(s.indexOf(",") + 1));
    };
    r.onerror = reject;
    r.readAsDataURL(blob);
  });
}

function ago(ts: number | null | undefined) {
  if (!ts) return "";
  const d = Math.round((Date.now() - ts) / 86400000);
  if (d <= 0) return "today";
  return d === 1 ? "yesterday" : `${d} days ago`;
}

const MIN_BUTTON = "min-h-[72px] text-[20px]";

export default function CrewApp({ role }: { role: Role }) {
  const boot = useQuery(api.store.crewBootstrap);
  const setDefault = useMutation(api.store.setDefaultMachine);
  const record = useMutation(api.ingest.recordEpisode);
  const transcribe = useAction(api.ingest.transcribePreview);
  const feedback = useMutation(api.store.recordFeedback);
  const flag = useMutation(api.store.flagEpisode);

  const [machineId, setMachineId] = useState<Id<"machines"> | null>(null);
  const [picking, setPicking] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const [mode, setMode] = useState<"problem" | "repair">("problem");
  const [transcript, setTranscript] = useState("");
  const [elapsed, setElapsed] = useState(0);
  const [episodeId, setEpisodeId] = useState<Id<"episodes"> | null>(null);
  const [queuedCount, setQueuedCount] = useState(0);
  const [showAll, setShowAll] = useState(false);
  const [hc, setHc] = useState(false);
  const [view, setView] = useState<"home" | "fixcard" | "history">("home");
  const [sentAt, setSentAt] = useState<number>(0);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<number | null>(null);
  const audioRef = useRef<{ base64?: string; mime?: string }>({});

  const now = sentAt || Date.now();
  const status = useQuery(
    api.store.episodeStatus,
    episodeId ? { episodeId } : "skip",
  );
  const fixes = useQuery(
    api.store.findFixes,
    machineId ? { machineId, episodeId: episodeId ?? undefined, now } : "skip",
  );
  const history = useQuery(
    api.store.machineHistory,
    view === "history" && machineId ? { machineId, limit: 25 } : "skip",
  );

  useEffect(() => {
    if (boot && !machineId) {
      const preferred = (boot.user.defaultMachineId ?? boot.machines[0]?.id ?? null) as Id<"machines"> | null;
      if (preferred) setMachineId(preferred);
    }
  }, [boot, machineId]);

  useEffect(() => {
    document.documentElement.classList.toggle("hc", hc);
  }, [hc]);

  const refreshQueue = useCallback(() => {
    void listQueued().then((q) => setQueuedCount(q.length));
  }, []);

  const doSync = useCallback(() => {
    void syncQueue(async (item: QueuedSubmission) => {
      await record({
        machineId: item.machineId as Id<"machines">,
        kind: item.kind,
        rawText: item.rawText,
        audioBase64: item.audioBase64,
        mimeType: item.mimeType,
        idempotencyKey: item.idempotencyKey,
      });
    }).then((n) => {
      if (n > 0) {
        toast.success(`Synced ${n} saved note${n > 1 ? "s" : ""}`);
        refreshQueue();
      }
    });
  }, [record, refreshQueue]);

  useEffect(() => {
    refreshQueue();
    const onOnline = () => doSync();
    window.addEventListener("online", onOnline);
    const t = window.setInterval(doSync, 30000);
    return () => {
      window.removeEventListener("online", onOnline);
      window.clearInterval(t);
    };
  }, [doSync, refreshQueue]);

  const machine = boot?.machines.find((m) => m.id === machineId) ?? null;

  const startRecording = async (m: "problem" | "repair") => {
    setMode(m);
    setTranscript("");
    setEpisodeId(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : undefined;
      const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      chunksRef.current = [];
      audioRef.current = {};
      rec.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      rec.start(250);
      recorderRef.current = rec;
      setElapsed(0);
      setPhase("recording");
      timerRef.current = window.setInterval(() => setElapsed((s) => s + 1), 1000);
    } catch {
      toast.error("Microphone is blocked. Allow mic access to talk.");
    }
  };

  const stopRecording = async () => {
    const rec = recorderRef.current;
    if (!rec) return;
    if (timerRef.current) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
    const finished = new Promise<Blob>((resolve) => {
      rec.onstop = () => resolve(new Blob(chunksRef.current, { type: rec.mimeType || "audio/webm" }));
    });
    rec.stop();
    streamRef.current?.getTracks().forEach((t) => t.stop());
    setPhase("ready");
    try {
      const blob = await finished;
      if (blob.size < 1200) {
        toast.error("Didn't catch that — hold the button and talk a little longer.");
        setPhase("idle");
        return;
      }
      const base64 = await blobToBase64(blob);
      audioRef.current = { base64, mime: blob.type };
      if (typeof navigator !== "undefined" && navigator.onLine === false) {
        await enqueue({
          idempotencyKey: crypto.randomUUID(),
          machineId: machineId!,
          kind: mode === "repair" ? "repair" : "voice_note",
          audioBase64: base64,
          mimeType: blob.type,
          createdAt: Date.now(),
        });
        setPhase("idle");
        refreshQueue();
        toast.success("No signal — saved. It syncs by itself when you're back online.");
        return;
      }
      const res = await transcribe({
        audioBase64: base64,
        mimeType: blob.type,
        machineClass: machine?.machineClass ?? "excavator",
      });
      setTranscript(res.text);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't hear that. Try again.");
      setPhase("idle");
    }
  };

  const send = async () => {
    if (!machineId) return;
    setPhase("sending");
    const key = crypto.randomUUID();
    try {
      const res = await record({
        machineId,
        kind: mode === "repair" ? "repair" : "voice_note",
        rawText: transcript || undefined,
        audioBase64: transcript ? undefined : audioRef.current.base64,
        mimeType: transcript ? undefined : audioRef.current.mime,
        idempotencyKey: key,
      });
      setEpisodeId(res.episodeId);
      setSentAt(Date.now());
      setPhase("logged");
      setView("fixcard");
    } catch {
      await enqueue({
        idempotencyKey: key,
        machineId,
        kind: mode === "repair" ? "repair" : "voice_note",
        audioBase64: transcript ? undefined : audioRef.current.base64,
        mimeType: audioRef.current.mime,
        rawText: transcript || undefined,
        createdAt: Date.now(),
      });
      setPhase("idle");
      refreshQueue();
      toast.success("Saved offline — it syncs by itself.");
    }
  };

  const discard = () => {
    setPhase("idle");
    setTranscript("");
  };

  const top = fixes && !("forbidden" in fixes) ? fixes.ranked[0] : undefined;
  const others = fixes && !("forbidden" in fixes) ? fixes.ranked.slice(1) : [];
  const noMatch = fixes && !("forbidden" in fixes) && episodeId && fixes.noConfidentMatch;

  // __CREW2__

  const HoldButton = ({ m, icon, title, sub, tone }: { m: "problem" | "repair"; icon: React.ReactNode; title: string; sub: string; tone: string }) => (
    <button
      disabled={phase !== "idle"}
      onPointerDown={() => void startRecording(m)}
      onPointerUp={() => void stopRecording()}
      className={`${MIN_BUTTON} flex w-full items-center gap-4 rounded-2xl p-5 text-left shadow-lift transition-all active:scale-[0.99] disabled:opacity-60 ${tone}`}
    >
      <span className="flex size-12 shrink-0 items-center justify-center rounded-xl bg-black/10">{icon}</span>
      <span className="flex-1">
        <span className="block text-[20px] font-bold leading-tight">{title}</span>
        <span className="block text-sm opacity-80">{sub}</span>
      </span>
    </button>
  );

  return (
    <main className="mx-auto w-full max-w-xl px-4 pb-16 pt-6 sm:px-6">
      {/* machine context + controls */}
      <div className="flex items-center justify-between gap-3">
        <button onClick={() => setPicking(true)} className="text-left">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">Machine</p>
          <p className="font-display text-xl font-bold tracking-tight">
            {machine ? `${machine.unitNumber ?? machine.serialNumber} · ${machine.model}` : "Pick a machine"}
          </p>
        </button>
        <div className="flex items-center gap-2">
          {queuedCount > 0 && (
            <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/15 px-2.5 py-1 text-xs font-semibold text-amber-700 dark:text-amber-400">
              <Radio className="size-3" /> {queuedCount} saved
            </span>
          )}
          <Button variant="outline" size="sm" className="h-9" onClick={() => setHc(!hc)}>
            {hc ? "Normal" : "High contrast"}
          </Button>
        </div>
      </div>

      {view === "home" && (
        <div className="mt-6 grid gap-3">
          {(role === "technician"
            ? ([
                { m: "repair" as const, icon: <Wrench className="size-6 text-white" />, title: "I fixed something", sub: "Hold to talk. What was wrong, what you did, parts used.", tone: "bg-emerald-600 text-white" },
                { m: "problem" as const, icon: <Mic className="size-6 text-primary-foreground" />, title: "Report a problem", sub: "Hold to talk. We do the paperwork.", tone: "bg-primary text-primary-foreground" },
              ])
            : ([
                { m: "problem" as const, icon: <Mic className="size-6 text-primary-foreground" />, title: "Report a problem", sub: "Hold to talk. We do the paperwork.", tone: "bg-primary text-primary-foreground" },
                { m: "repair" as const, icon: <Wrench className="size-6 text-white" />, title: "I fixed something", sub: "Hold to talk. What was wrong, what you did, parts used.", tone: "bg-emerald-600 text-white" },
              ])
          ).map((b) => (
            <HoldButton key={b.m} {...b} />
          ))}
          <button
            onClick={() => setView("history")}
            className={`${MIN_BUTTON} flex w-full items-center gap-4 rounded-2xl border-2 border-border bg-card p-5 text-left shadow-soft transition-all active:scale-[0.99]`}
          >
            <span className="flex size-12 shrink-0 items-center justify-center rounded-xl bg-secondary">
              <History className="size-6 text-foreground" />
            </span>
            <span className="flex-1">
              <span className="block text-[20px] font-bold leading-tight">What's wrong with this machine?</span>
              <span className="block text-sm text-muted-foreground">Its memory, and fixes that worked on units like it.</span>
            </span>
          </button>
        </div>
      )}

      {/* recording / transcript states */}
      {phase === "recording" && (
        <div className="fixed inset-x-0 bottom-0 z-50 p-4">
          <div className="mx-auto flex max-w-xl items-center gap-4 rounded-2xl bg-red-600 p-5 text-white shadow-lift">
            <span className="relative flex size-12 items-center justify-center">
              <span className="absolute inset-0 animate-ping rounded-full bg-white/30" />
              <CircleStop className="size-7" />
            </span>
            <div className="flex-1">
              <p className="text-lg font-bold">Listening — release to finish</p>
              <p className="text-sm text-white/85">Just talk like you'd tell your foreman.</p>
            </div>
            <span className="font-mono text-lg font-semibold">
              {Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, "0")}
            </span>
          </div>
        </div>
      )}

      {phase === "ready" && (
        <div className="mt-6 rounded-2xl border border-border bg-card p-5 shadow-lift">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">We heard</p>
          <p className="mt-2 min-h-12 text-[20px] leading-relaxed">{transcript || "…"}</p>
          <div className="mt-4 flex gap-2">
            <Button variant="outline" className={`${MIN_BUTTON} flex-1`} onClick={discard}>Redo</Button>
            <Button className={`${MIN_BUTTON} flex-1`} onClick={() => void send()}>Send</Button>
          </div>
        </div>
      )}

      {phase === "sending" && (
        <div className="mt-6 flex items-center gap-3 rounded-2xl bg-stone-900 p-5 text-white shadow-lift dark:bg-stone-800 dark:ring-1 dark:ring-stone-700">
          <Loader2 className="size-6 animate-spin" />
          <p className="text-lg font-bold">Adding to the memory layer…</p>
        </div>
      )}

      {/* fix card */}
      {view === "fixcard" && (
        <section className="mt-6">
          <div className="flex items-center justify-between">
            <h2 className="font-display text-lg font-bold">{mode === "repair" ? "Logged. Nice." : "Best-known fix"}</h2>
            <Button variant="ghost" size="sm" onClick={() => { setView("home"); setPhase("idle"); setEpisodeId(null); }}>
              <ChevronLeft className="size-4" /> Done
            </Button>
          </div>

          {status?.extractionStatus === "pending" && (
            <p className="mt-3 flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> Understanding your note… the fix below is matched from memory.
            </p>
          )}

          {noMatch && (
            <div className="mt-3 rounded-2xl border border-amber-500/40 bg-amber-500/10 p-5">
              <p className="flex items-center gap-2 font-semibold text-amber-800 dark:text-amber-300">
                <TriangleAlert className="size-5" /> No match yet — sent to the engineers
              </p>
              <p className="mt-1 text-sm text-amber-900/80 dark:text-amber-200/80">This exact fault isn't in memory for {machine?.model}s yet. CAT Engineering gets it with your words attached.</p>
              {episodeId && <Button size="sm" className="mt-3" variant="outline" onClick={() => void flag({ episodeId })}>Make sure they see it</Button>}
            </div>
          )}

          {top && (
            <div className="mt-3 rounded-2xl border-2 border-emerald-500/60 bg-card p-5 shadow-lift">
              {top.guidanceNote && (
                <p className="mb-3 rounded-lg bg-stone-900 p-3 text-sm text-amber-300 dark:bg-stone-800 dark:ring-1 dark:ring-stone-700">
                  Engineer guidance: {top.guidanceNote}
                </p>
              )}
              <p className="font-display text-xl font-bold leading-snug">{top.title}</p>
              {top.caveats && <p className="mt-2 rounded-lg bg-amber-500/10 p-3 text-sm text-amber-800 dark:text-amber-300">Caveat: {top.caveats}</p>}
              <ol className="mt-3 space-y-2">
                {top.steps.map((s: string, i: number) => (
                  <li key={i} className="flex gap-2.5 text-[18px] leading-relaxed">
                    <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-secondary text-xs font-bold">{i + 1}</span>
                    {s}
                  </li>
                ))}
              </ol>
              {top.parts.length > 0 && (
                <p className="mt-3 text-sm text-muted-foreground">Parts: {top.parts.join(", ")}</p>
              )}
              <p className="mt-3 flex items-center gap-1.5 text-sm font-medium text-emerald-700 dark:text-emerald-400">
                <CheckCircle2 className="size-4" />
                Worked on {top.held} of {top.held + top.recurred} unit{top.held + top.recurred === 1 ? "" : "s"} that tried it
              </p>
              <p className="text-xs text-muted-foreground">
                {top.distinctUnits} unit{top.distinctUnits === 1 ? "" : "s"} · {top.distinctSites} site{top.distinctSites === 1 ? "" : "s"} · last used {ago(top.lastUsedAt)}
                {top.evidence[0] ? ` · ${top.evidence[0].siteLabel}` : ""}
              </p>
              <div className="mt-4 grid grid-cols-3 gap-2">
                <Button className={`${MIN_BUTTON} bg-emerald-600 hover:bg-emerald-700`} onClick={() => { void feedback({ fixCardId: top.cardId, machineId: machineId ?? undefined, verdict: "worked" }); toast.success("Thanks — that helps the next crew."); }}>This worked</Button>
                <Button variant="outline" className={MIN_BUTTON} onClick={() => { void feedback({ fixCardId: top.cardId, machineId: machineId ?? undefined, verdict: "didnt_work" }); toast.success("Noted — thanks."); }}>Didn't work</Button>
                <Button variant="ghost" className={MIN_BUTTON} onClick={() => { void feedback({ fixCardId: top.cardId, machineId: machineId ?? undefined, verdict: "not_tried" }); }}>Haven't tried</Button>
              </div>
              {others.length > 0 && !showAll && (
                <Button variant="link" className="mt-2 px-0 text-sm" onClick={() => setShowAll(true)}>
                  See {others.length} other option{others.length > 1 ? "s" : ""}
                </Button>
              )}
              {showAll && others.map((o: any) => (
                <div key={o.cardId} className="mt-3 rounded-xl border border-border p-4">
                  <p className="font-semibold">{o.title}</p>
                  <p className="text-xs text-muted-foreground">Worked on {o.held} of {o.held + o.recurred} units · {o.distinctSites} sites</p>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {/* machine history */}
      {view === "history" && (
        <section className="mt-6">
          <div className="flex items-center justify-between">
            <h2 className="font-display text-lg font-bold">This machine's memory</h2>
            <Button variant="ghost" size="sm" onClick={() => setView("home")}><ChevronLeft className="size-4" /> Back</Button>
          </div>
          {fixes && !("forbidden" in fixes) && fixes.ranked[0] && (
            <div className="mt-3 rounded-2xl border-2 border-emerald-500/60 bg-card p-5 shadow-lift">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Best-known fix for its current fault</p>
              <p className="mt-1 font-display text-lg font-bold">{fixes.ranked[0].title}</p>
              <Button variant="outline" className={`${MIN_BUTTON} mt-3 w-full`} onClick={() => setView("fixcard")}>Show the fix</Button>
            </div>
          )}
          <div className="mt-3 space-y-2">
            {(history && !("forbidden" in history) ? history.episodes : []).map((e: any) => (
              <div key={e.id} className="rounded-xl border border-border bg-card px-4 py-3 shadow-soft">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-sm font-semibold capitalize">{e.kind.replace("_", " ")}{e.signatureLabel ? ` · ${e.signatureLabel}` : ""}</p>
                  <span className="text-xs text-muted-foreground">{ago(e.at)}</span>
                </div>
                {e.text && <p className="mt-1 text-sm text-muted-foreground">{e.text}</p>}
              </div>
            ))}
          </div>
        </section>
      )}

      {/* machine picker */}
      {picking && (
        <div className="fixed inset-0 z-50 bg-stone-950/70 p-4 backdrop-blur-sm" onClick={() => setPicking(false)}>
          <div className="mx-auto mt-10 max-w-md rounded-2xl bg-card p-4 shadow-lift" onClick={(e) => e.stopPropagation()}>
            <p className="mb-3 font-display text-lg font-bold">Which machine?</p>
            <div className="max-h-[60vh] space-y-2 overflow-y-auto">
              {(boot?.machines ?? []).map((m) => (
                <button
                  key={m.id}
                  className={`${MIN_BUTTON} w-full rounded-xl border border-border px-4 py-3 text-left transition hover:border-amber-400`}
                  onClick={() => {
                    setMachineId(m.id as Id<"machines">);
                    void setDefault({ machineId: m.id as Id<"machines"> });
                    setPicking(false);
                  }}
                >
                  <span className="block font-bold">{m.unitNumber ?? m.serialNumber} · {m.model}</span>
                  <span className="block text-sm text-muted-foreground">{m.machineClass}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
