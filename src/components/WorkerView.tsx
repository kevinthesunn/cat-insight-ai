import { Button } from "@/components/ui/button";
import { CATEGORY_ICON, SeverityIcon, timeAgo } from "@/components/shared";
import { api } from "@/convex/_generated/api";
import type { Doc, Id } from "@/convex/_generated/dataModel";
import { useAction, useMutation } from "convex/react";
import {
  Check, CircleAlert, CircleStop, CloudSun, HardHat, Loader2, Mic, Users,
} from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";

type Data = {
  user: Doc<"users"> | null;
  sites: Doc<"sites">[];
  machines: Doc<"machines">[];
  events: Doc<"events">[];
  alerts: Doc<"alerts">[];
  tasks: Doc<"actionItems">[];
  reports: Doc<"engineerReports">[];
};

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
}

function CategoryIcon({ category }: { category: string }) {
  const Icon = CATEGORY_ICON[category] ?? CircleAlert;
  return <Icon className="size-5" />;
}

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

function fmtClock(totalSec: number) {
  return `${Math.floor(totalSec / 60)}:${String(totalSec % 60).padStart(2, "0")}`;
}

type Phase = "idle" | "recording" | "processing";

export default function WorkerView({ user, data }: { user: Doc<"users"> | null; data: Data }) {
  const ack = useMutation(api.app.acknowledgeAlert);
  const resolve = useMutation(api.app.resolveAlert);
  const complete = useMutation(api.app.completeTask);
  const processVoice = useAction(api.ai.processVoiceReport);

  const site = data.sites.find((s) => s._id === (user?.siteId ?? data.sites[0]?._id)) ?? data.sites[0];
  const siteAlerts = data.alerts
    .filter((a) => a.siteId === site?._id)
    .sort((a, b) => b.createdAt - a.createdAt);
  const openAlerts = siteAlerts.filter((a) => a.status !== "resolved");
  const doneAlerts = siteAlerts.filter((a) => a.status === "resolved").slice(0, 3);
  const tasks = data.tasks
    .filter((t) => t.siteId === site?._id && t.status === "open")
    .sort((a, b) => (a.priority === "urgent" ? -1 : 1) - (b.priority === "urgent" ? -1 : 1) || b.createdAt - a.createdAt);
  const doneTasks = data.tasks.filter((t) => t.siteId === site?._id && t.status === "done");

  const [phase, setPhase] = useState<Phase>("idle");
  const [elapsed, setElapsed] = useState(0);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<number | null>(null);

  const startRecording = async () => {
    if (!site) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : undefined;
      const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      chunksRef.current = [];
      rec.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      rec.start(250);
      recorderRef.current = rec;
      setElapsed(0);
      setPhase("recording");
      timerRef.current = window.setInterval(() => setElapsed((s) => s + 1), 1000);
    } catch {
      toast.error("Microphone is blocked. Allow mic access, or find your foreman to log it.");
    }
  };

  const stopAndSend = async () => {
    const rec = recorderRef.current;
    if (!rec || !site) return;
    if (timerRef.current) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
    const finished = new Promise<Blob>((resolve) => {
      rec.onstop = () => resolve(new Blob(chunksRef.current, { type: rec.mimeType || "audio/webm" }));
    });
    rec.stop();
    streamRef.current?.getTracks().forEach((t) => t.stop());
    setPhase("processing");
    try {
      const blob = await finished;
      if (blob.size < 1200) {
        toast.error("Didn't catch that — hold the button talk a little longer.");
        return;
      }
      const audioBase64 = await blobToBase64(blob);
      const res = await processVoice({
        siteId: site._id,
        audioBase64,
        mimeType: blob.type,
      });
      toast.success(`Logged: ${res.title}`, {
        description: `“${res.transcript}”`,
        duration: 8000,
      });
      if (res.notified) {
        toast.info("CAT engineers have been notified automatically.", { duration: 6000 });
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't send that. Try again.");
    } finally {
      setPhase("idle");
      recorderRef.current = null;
    }
  };

  return (
    <main className="mx-auto w-full max-w-2xl px-4 pb-16 pt-8 sm:px-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-sm text-muted-foreground">{greeting()}, {user?.name?.split(" ")[0] ?? "there"} 👋</p>
          <h1 className="mt-1 font-display text-2xl font-bold tracking-tight">{site?.name ?? "Your site"}</h1>
        </div>
        <div className="flex flex-col items-end gap-1 text-right text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-2.5 py-1 font-medium text-foreground shadow-soft">
            <CloudSun className="size-3.5 text-amber-500" />
            {site?.weatherCondition} · {Math.round(site?.weatherTempC ?? 0)}°C
          </span>
          <span className="inline-flex items-center gap-1"><Users className="size-3.5" /> {site?.crewCount} on site</span>
        </div>
      </div>

      {/* Voice report — one big button, no forms */}
      <button
        disabled={phase === "processing" || !site}
        onClick={() => (phase === "recording" ? void stopAndSend() : void startRecording())}
        className={`mt-6 flex w-full items-center gap-4 rounded-2xl p-6 text-left shadow-lift transition-all active:scale-[0.99] disabled:cursor-wait ${
          phase === "recording"
            ? "bg-red-600"
            : phase === "processing"
              ? "bg-stone-900"
              : "bg-primary"
        }`}
      >
        <span className="relative flex size-14 shrink-0 items-center justify-center rounded-2xl bg-primary-foreground/15">
          {phase === "processing" ? (
            <Loader2 className="size-7 animate-spin text-primary-foreground" />
          ) : phase === "recording" ? (
            <>
              <span className="absolute inset-0 animate-ping rounded-2xl bg-white/25" />
              <CircleStop className="size-7 text-white" />
            </>
          ) : (
            <Mic className="size-7 text-primary-foreground" />
          )}
        </span>
        <span className="flex-1">
          {phase === "idle" && (
            <>
              <span className="block text-xl font-bold text-primary-foreground">Report a problem</span>
              <span className="block text-sm text-primary-foreground/80">Tap it, then just talk like you'd tell your foreman. We do the paperwork.</span>
            </>
          )}
          {phase === "recording" && (
            <>
              <span className="flex items-center gap-2 text-xl font-bold text-white">
                Listening
                <span className="flex items-end gap-0.5">
                  {[0, 1, 2, 3].map((i) => (
                    <span key={i} className="w-1 animate-pulse rounded-full bg-white/90" style={{ height: 6 + i * 4, animationDelay: `${i * 120}ms` }} />
                  ))}
                </span>
                <span className="ml-auto font-mono text-base font-semibold text-white/90">{fmtClock(elapsed)}</span>
              </span>
              <span className="block text-sm text-white/85">Tap the button when you're done.</span>
            </>
          )}
          {phase === "processing" && (
            <>
              <span className="block text-xl font-bold text-white">Adding to the memory layer…</span>
              <span className="block text-sm text-white/75">Transcribing and routing to your crew and CAT engineers.</span>
            </>
          )}
        </span>
      </button>

      <section className="mt-8">
        <h2 className="flex items-center gap-2 font-display text-lg font-semibold">
          Need attention now
          {openAlerts.length > 0 && (
            <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs font-bold text-red-700">{openAlerts.length}</span>
          )}
        </h2>
        {openAlerts.length === 0 ? (
          <div className="mt-3 rounded-xl border border-border bg-card p-5 text-center shadow-soft">
            <Check className="mx-auto size-6 text-emerald-500" />
            <p className="mt-2 text-sm font-medium">All clear on {site?.name ?? "site"}</p>
            <p className="text-xs text-muted-foreground">New problems pop up here the moment they're detected.</p>
          </div>
        ) : (
          <div className="mt-3 space-y-3">
            {openAlerts.map((a) => {
              const critical = a.severity === "critical" && a.status === "open";
              return (
                <div
                  key={a._id}
                  className={`rounded-xl border bg-card p-4 shadow-soft ${critical ? "border-red-300 bg-red-50/40" : "border-border"}`}
                >
                  <div className="flex items-start gap-3">
                    <span className={`flex size-10 shrink-0 items-center justify-center rounded-lg ${critical ? "bg-red-100 text-red-700" : "bg-amber-100 text-amber-700"}`}>
                      <CategoryIcon category={a.category} />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="font-semibold leading-snug">{a.title}</p>
                      <p className="mt-0.5 text-sm text-muted-foreground">{a.message}</p>
                      <p className="mt-1 text-xs text-muted-foreground">{timeAgo(a.createdAt)}</p>
                    </div>
                  </div>
                  <div className="mt-3 flex gap-2">
                    {a.status === "open" ? (
                      <Button size="lg" className="h-11 flex-1 text-base font-semibold" onClick={() => void ack({ alertId: a._id })}>
                        Got it — we're on it
                      </Button>
                    ) : (
                      <Button size="lg" variant="outline" className="h-11 flex-1 text-base font-semibold" onClick={() => void resolve({ alertId: a._id })}>
                        It's handled ✓
                      </Button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      <section className="mt-8">
        <h2 className="flex items-center gap-2 font-display text-lg font-semibold">
          <HardHat className="size-5 text-amber-500" />
          Today's tasks
          {tasks.length > 0 && (
            <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-bold text-amber-900">{tasks.length}</span>
          )}
        </h2>
        {tasks.length === 0 ? (
          <div className="mt-3 rounded-xl border border-border bg-card p-5 text-center text-sm shadow-soft">
            <Check className="mx-auto size-6 text-emerald-500" />
            <p className="mt-2 font-medium">Nothing on your list. Nice.</p>
          </div>
        ) : (
          <div className="mt-3 space-y-2.5">
            {tasks.map((t) => (
              <button
                key={t._id}
                onClick={() => {
                  void complete({ taskId: t._id });
                  toast.success("Done. Nice work.");
                }}
                className="flex w-full items-center gap-4 rounded-xl border border-border bg-card p-4 text-left shadow-soft transition-all hover:border-emerald-300 active:scale-[0.99]"
              >
                <span className="flex size-8 shrink-0 items-center justify-center rounded-full border-2 border-stone-300">
                  <Check className="size-4 text-transparent" />
                </span>
                <span className="flex-1">
                  <span className={`block font-semibold ${t.priority === "urgent" ? "text-red-700" : ""}`}>
                    {t.priority === "urgent" && <CircleAlert className="mr-1 inline size-4" />}
                    {t.title}
                  </span>
                  {t.detail && <span className="block text-sm text-muted-foreground">{t.detail}</span>}
                </span>
              </button>
            ))}
          </div>
        )}
        {doneTasks.length > 0 && (
          <p className="mt-3 text-xs text-muted-foreground">{doneTasks.length} finished today — good pace.</p>
        )}
      </section>

      {doneAlerts.length > 0 && (
        <section className="mt-8">
          <h2 className="font-display text-sm font-semibold uppercase tracking-wide text-muted-foreground">Handled recently</h2>
          <div className="mt-2 space-y-1.5">
            {doneAlerts.map((a) => (
              <div key={a._id} className="flex items-center gap-2.5 rounded-lg border border-border/70 bg-card px-3 py-2 text-sm shadow-soft">
                <SeverityIcon severity={a.severity} className="size-4 shrink-0" />
                <span className="truncate">{a.title}</span>
                <span className="ml-auto shrink-0 text-xs text-muted-foreground">{timeAgo(a.resolvedAt ?? a.createdAt)}</span>
              </div>
            ))}
          </div>
        </section>
      )}

      <p className="mt-10 rounded-xl border border-amber-200/70 bg-amber-50/60 p-4 text-center text-xs leading-relaxed text-amber-900">
        Every report you speak up is remembered on this site's knowledge graph — and machine problems go straight to CAT engineers. When they find a quick fix, it lands here.
      </p>
    </main>
  );
}
