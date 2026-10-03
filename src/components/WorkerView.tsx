import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { CATEGORY_ICON, SeverityIcon, timeAgo } from "@/components/shared";
import { api } from "@/convex/_generated/api";
import type { Doc, Id } from "@/convex/_generated/dataModel";
import { useMutation } from "convex/react";
import {
  Check, CircleAlert, CloudSun, HardHat, MessageSquarePlus, ShieldAlert, Users, Wrench,
} from "lucide-react";
import { useState } from "react";
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

const PROBLEM_TYPES = [
  { id: "mechanical", icon: Wrench, label: "A machine is acting up", hint: "Weird noise, warning light, low power…" },
  { id: "safety", icon: ShieldAlert, label: "Something unsafe", hint: "Anything that could hurt someone" },
  { id: "environmental", icon: CloudSun, label: "Weather or ground", hint: "Water, wind, mud, unstable ground" },
  { id: "operational", icon: MessageSquarePlus, label: "Something else", hint: "Anything the team should know" },
] as const;

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
}

export default function WorkerView({ user, data }: { user: Doc<"users"> | null; data: Data }) {
  const ack = useMutation(api.app.acknowledgeAlert);
  const resolve = useMutation(api.app.resolveAlert);
  const complete = useMutation(api.app.completeTask);
  const report = useMutation(api.app.reportProblem);

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

  const [open, setOpen] = useState(false);
  const [type, setType] = useState<string | null>(null);
  const [machineId, setMachineId] = useState<string>("");
  const [detail, setDetail] = useState("");
  const [sending, setSending] = useState(false);

  const siteMachines = data.machines.filter((m) => m.siteId === site?._id);

  const submit = async () => {
    if (!site || !type) return;
    setSending(true);
    try {
      await report({
        siteId: site._id,
        machineId: type === "mechanical" && machineId ? (machineId as Id<"machines">) : undefined,
        category: type,
        title:
          type === "mechanical"
            ? `${siteMachines.find((m) => m._id === machineId)?.name ?? "Machine"} — crew report`
            : PROBLEM_TYPES.find((p) => p.id === type)!.label,
        detail: detail.trim() || "Reported from the field.",
        severity: type === "mechanical" ? "critical" : type === "operational" ? "info" : "warning",
      });
      toast.success("Got it. Your crew and CAT engineers can see this now.");
      setOpen(false);
      setType(null);
      setDetail("");
      setMachineId("");
    } finally {
      setSending(false);
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

      <button
        onClick={() => setOpen(true)}
        className="mt-6 flex w-full items-center gap-4 rounded-2xl bg-primary p-5 text-left shadow-lift transition-transform active:scale-[0.99]"
      >
        <span className="flex size-12 items-center justify-center rounded-xl bg-primary-foreground/15">
          <MessageSquarePlus className="size-6 text-primary-foreground" />
        </span>
        <span className="flex-1">
          <span className="block text-lg font-bold text-primary-foreground">Report a problem</span>
          <span className="block text-sm text-primary-foreground/75">Takes 20 seconds. We tell everyone for you.</span>
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
              const Icon = CATEGORY_ICON[a.category] ?? CircleAlert;
              const critical = a.severity === "critical" && a.status === "open";
              return (
                <div
                  key={a._id}
                  className={`rounded-xl border bg-card p-4 shadow-soft ${critical ? "border-red-300 bg-red-50/40" : "border-border"}`}
                >
                  <div className="flex items-start gap-3">
                    <span className={`flex size-10 shrink-0 items-center justify-center rounded-lg ${critical ? "bg-red-100 text-red-700" : "bg-amber-100 text-amber-700"}`}>
                      <Icon className="size-5" />
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
        Machine problems go straight to CAT engineers automatically. When they find a quick fix, it lands here for your crew.
      </p>

      <Dialog open={open} onOpenChange={(v) => { setOpen(v); if (!v) setType(null); }}>
        <DialogContent className="max-w-md">
          {!type ? (
            <>
              <DialogHeader>
                <DialogTitle className="font-display">What's going on?</DialogTitle>
                <DialogDescription>Pick the closest one. One tap is enough.</DialogDescription>
              </DialogHeader>
              <div className="grid gap-2.5">
                {PROBLEM_TYPES.map((p) => (
                  <button
                    key={p.id}
                    onClick={() => setType(p.id)}
                    className="flex items-center gap-3.5 rounded-xl border border-border bg-card p-4 text-left transition-all hover:border-primary/60 hover:bg-accent active:scale-[0.99]"
                  >
                    <span className="flex size-11 items-center justify-center rounded-lg bg-primary/15">
                      <p.icon className="size-5" />
                    </span>
                    <span>
                      <span className="block font-semibold">{p.label}</span>
                      <span className="block text-sm text-muted-foreground">{p.hint}</span>
                    </span>
                  </button>
                ))}
              </div>
            </>
          ) : (
            <>
              <DialogHeader>
                <DialogTitle className="font-display">Tell us a little more</DialogTitle>
                <DialogDescription>Plain words are fine. A sentence helps the engineers.</DialogDescription>
              </DialogHeader>
              <div className="space-y-3">
                {type === "mechanical" && siteMachines.length > 0 && (
                  <Select value={machineId} onValueChange={setMachineId}>
                    <SelectTrigger className="h-12 text-base">
                      <SelectValue placeholder="Which machine?" />
                    </SelectTrigger>
                    <SelectContent>
                      {siteMachines.map((m) => (
                        <SelectItem key={m._id} value={m._id} className="text-base">{m.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
                <Textarea
                  value={detail}
                  onChange={(e) => setDetail(e.target.value)}
                  placeholder="What's happening?"
                  className="min-h-24 text-base"
                />
                <div className="flex gap-2">
                  <Button variant="ghost" className="flex-1" onClick={() => setType(null)}>Back</Button>
                  <Button
                    className="flex-1"
                    disabled={sending || (type === "mechanical" && !machineId)}
                    onClick={() => void submit()}
                  >
                    {sending ? "Sending…" : "Send it"}
                  </Button>
                </div>
                <p className="text-center text-xs text-muted-foreground">
                  The whole crew sees this instantly. Machine issues also ping CAT Engineering.
                </p>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </main>
  );
}
